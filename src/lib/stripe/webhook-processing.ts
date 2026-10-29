/**
 * Webhook event orchestration: ensure record -> atomic claim -> dispatch -> fenced
 * finalize, returning a typed ProcessWebhookResult.
 *
 * Transaction boundaries (explicit):
 *   - ensureRecord, tryClaim, markProcessed, releaseForRetry, markDeadLetter are each
 *     a single short statement. They are NOT part of any handler transaction.
 *   - Financial handlers run in their own transactions (payment-row FOR UPDATE).
 *   - No Stripe network call happens inside any transaction owned by this module.
 *   - Consequently "handler committed" and "event marked processed" are NOT atomic.
 *     If finalization fails after a successful handler, the event stays recoverable and
 *     the retry re-runs the handler, which must be (and for refunds is) idempotent.
 *
 * Audit rows are best-effort (writePaymentAuditLog swallows its own errors) and are
 * additionally guarded here so audit/log failures can never change the outcome:
 *   - a successful financial handler is never reported as failed because audit failed;
 *   - an incomplete handler is never reported as processed because audit succeeded.
 *
 * No Prisma/Stripe imports: unit-testable with an injected store.
 */

import {
  claimWebhookEvent,
  type WebhookClaim,
  type WebhookClaimConfig,
  type WebhookClaimResult,
  type WebhookEventStore,
  type WebhookRecoveryClaimOptions,
} from "./webhook-event-claim";
import {
  classifyWebhookFailure,
  summarizeErrorForStorage,
} from "./webhook-errors";
import type { WebhookOpsEvent } from "./webhook-ops-log";
import type {
  AuditAction,
  ProcessWebhookResult,
  WebhookFailureCode,
  WebhookRecoveryIneligibleResult,
} from "./types";

export type WebhookDispatchResult =
  | { handled: true; action: string }
  /** Event type is intentionally unsupported: terminal "ignored" decision. */
  | { handled: false };

export type WebhookAuditArgs = {
  action: AuditAction;
  newValue: Record<string, unknown>;
};

export type WebhookProcessingDeps<E extends { id: string; type: string }> = {
  store: WebhookEventStore;
  config: WebhookClaimConfig;
  dispatch: (event: E) => Promise<WebhookDispatchResult>;
  audit: (args: WebhookAuditArgs) => Promise<void>;
  log: (event: WebhookOpsEvent, context: Record<string, unknown>) => void;
  newClaimToken?: () => string;
};

async function safeAudit<E extends { id: string; type: string }>(
  deps: WebhookProcessingDeps<E>,
  args: WebhookAuditArgs,
): Promise<void> {
  try {
    await deps.audit(args);
  } catch {
    // Best-effort by contract; the ops log line is the fallback record.
  }
}

function safeLog<E extends { id: string; type: string }>(
  deps: WebhookProcessingDeps<E>,
  event: WebhookOpsEvent,
  context: Record<string, unknown>,
): void {
  try {
    deps.log(event, context);
  } catch {
    // Logging must never alter processing outcome.
  }
}

/** Outcome of persisting a failure disposition under fencing. */
type DispositionResult =
  | { kind: "recorded" }
  | { kind: "superseded" }
  | { kind: "persist_failed" };

async function persistDeadLetter<E extends { id: string; type: string }>(
  deps: WebhookProcessingDeps<E>,
  claim: WebhookClaim,
  reason: WebhookFailureCode,
  evidence: { lastErrorCode?: string; message?: string },
): Promise<DispositionResult> {
  try {
    const updated = await deps.store.markDeadLetter(claim, { reason, ...evidence });
    return updated ? { kind: "recorded" } : { kind: "superseded" };
  } catch {
    return { kind: "persist_failed" };
  }
}

/**
 * Process one verified event. Never throws: every failure becomes a typed outcome.
 *
 * Live Stripe deliveries call this WITHOUT `recovery` and behave exactly as before
 * (return type ProcessWebhookResult). Operator recovery passes `recovery`, which adds
 * the recovery-only eligibility predicate to the SAME atomic claim; when that predicate
 * no longer holds the result is `recovery_not_eligible` (nothing claimed, no handler
 * run, no state changed) instead of a processing failure.
 */
export async function processWebhookEventWithDeps<E extends { id: string; type: string }>(
  event: E,
  deps: WebhookProcessingDeps<E>,
): Promise<ProcessWebhookResult>;
export async function processWebhookEventWithDeps<E extends { id: string; type: string }>(
  event: E,
  deps: WebhookProcessingDeps<E>,
  recovery: WebhookRecoveryClaimOptions,
): Promise<ProcessWebhookResult | WebhookRecoveryIneligibleResult>;
export async function processWebhookEventWithDeps<E extends { id: string; type: string }>(
  event: E,
  deps: WebhookProcessingDeps<E>,
  recovery?: WebhookRecoveryClaimOptions,
): Promise<ProcessWebhookResult | WebhookRecoveryIneligibleResult> {
  const stripeEventId = event.id;
  const eventType = event.type;
  const baseCtx = { stripeEventId, eventType };

  // 1. Ensure the row exists. This is NOT a claim.
  try {
    await deps.store.ensureRecord({ id: stripeEventId, type: eventType, payload: event });
  } catch (error) {
    // If we cannot durably record the event we must not claim it was handled.
    const classified = classifyWebhookFailure(error);
    const code: WebhookFailureCode =
      classified.retryable && classified.code === "DB_TRANSIENT" ? "DB_TRANSIENT" : "EVENT_RECORD_FAILED";
    safeLog(deps, "webhook.retryable_failure", { ...baseCtx, errorCode: code });
    return { outcome: "retryable_failure", code, handlerCompleted: false };
  }

  // 2. Atomic conditional claim.
  let claimResult: WebhookClaimResult;
  try {
    claimResult = await claimWebhookEvent(
      deps.store,
      stripeEventId,
      deps.config,
      deps.newClaimToken,
      recovery,
    );
  } catch (error) {
    const classified = classifyWebhookFailure(error);
    const code: WebhookFailureCode =
      classified.retryable && classified.code === "DB_TRANSIENT" ? "DB_TRANSIENT" : "CLAIM_FAILED";
    safeLog(deps, "webhook.retryable_failure", { ...baseCtx, errorCode: code });
    return { outcome: "retryable_failure", code, handlerCompleted: false };
  }

  switch (claimResult.kind) {
    case "already_processed":
      safeLog(deps, "webhook.duplicate_already_processed", baseCtx);
      await safeAudit(deps, {
        action: "webhook_duplicate",
        newValue: { ...baseCtx, disposition: "already_processed" },
      });
      return { outcome: "already_processed" };

    case "dead_lettered":
      safeLog(deps, "webhook.duplicate_dead_lettered", baseCtx);
      await safeAudit(deps, {
        action: "webhook_duplicate",
        newValue: { ...baseCtx, disposition: "dead_lettered" },
      });
      return { outcome: "permanent_failure", code: "EVENT_DEAD_LETTERED", deadLettered: true };

    case "in_flight":
      safeLog(deps, "webhook.duplicate_in_flight_skipped", baseCtx);
      await safeAudit(deps, {
        action: "webhook_in_flight_skipped",
        newValue: { ...baseCtx },
      });
      return { outcome: "in_flight" };

    case "recovery_not_eligible":
      // Only reachable when `recovery` was supplied. A skip: no claim, no handler, no
      // state change, no audit row (it is not an event outcome worth recording).
      safeLog(deps, "webhook.recovery_claim_not_eligible", baseCtx);
      return { outcome: "recovery_not_eligible" };

    case "unavailable":
      safeLog(deps, "webhook.claim_state_changed", { ...baseCtx, errorCode: "CLAIM_STATE_CHANGED" });
      return { outcome: "retryable_failure", code: "CLAIM_STATE_CHANGED", handlerCompleted: false };

    case "acquired":
      break;
  }

  const claim = claimResult.claim;
  const claimCtx = {
    ...baseCtx,
    attemptCount: claim.attemptCount,
    claimGeneration: claim.claimGeneration,
    previousStatus: claim.previousStatus,
    maxAttempts: deps.config.maxAttempts,
  };

  if (claim.previousStatus === "PROCESSING") {
    // Previous owner's lease expired (crash, kill, or slow handler).
    safeLog(deps, "webhook.expired_claim_reclaimed", claimCtx);
    await safeAudit(deps, {
      action: "webhook_claim_reclaimed",
      newValue: { ...claimCtx },
    });
  } else if (claim.previousStatus === "RETRYABLE_FAILED") {
    safeLog(deps, "webhook.retry_attempt_started", claimCtx);
  } else {
    safeLog(deps, "webhook.event_claimed", claimCtx);
  }
  await safeAudit(deps, {
    action: "webhook_received",
    newValue: {
      ...baseCtx,
      attemptCount: claim.attemptCount,
      claimGeneration: claim.claimGeneration,
    },
  });

  // 3. Attempt cap: crash loops and repeated failures must not retry forever.
  if (claim.attemptCount > deps.config.maxAttempts) {
    safeLog(deps, "webhook.retry_limit_exceeded_dead_lettered", {
      ...claimCtx,
      errorCode: "RETRY_LIMIT_EXCEEDED",
    });
    // No fresh failure here: pass no evidence so the store PRESERVES the original
    // failure (lastErrorCode/error) that exhausted the retries.
    return finishDeadLetter(deps, claim, claimCtx, "RETRY_LIMIT_EXCEEDED", {});
  }

  // 4. Dispatch the handler. Handler errors are classified deliberately.
  let dispatched: WebhookDispatchResult;
  try {
    dispatched = await deps.dispatch(event);
  } catch (error) {
    return handleDispatchFailure(deps, claim, claimCtx, error);
  }

  // 5. Fenced finalize. Handler success must not be reported as processed unless the
  //    fenced update actually recorded it.
  let finalized: boolean;
  try {
    finalized = await deps.store.markProcessed(claim);
  } catch {
    // Handler committed (or no-op'd) but the event row could not be finalized.
    safeLog(deps, "webhook.handler_succeeded_finalize_failed", {
      ...claimCtx,
      errorCode: "FINALIZE_FAILED",
      handlerCompleted: true,
    });
    await safeAudit(deps, {
      action: "webhook_finalize_failed",
      newValue: { ...baseCtx, attemptCount: claim.attemptCount, handlerCompleted: true },
    });
    // Best-effort: free the lease so the next delivery need not wait for expiry.
    try {
      await deps.store.releaseForRetry(claim, {
        code: "FINALIZE_FAILED",
        message: "handler completed; failed to mark event processed",
      });
    } catch {
      safeLog(deps, "webhook.release_for_retry_failed", claimCtx);
    }
    return { outcome: "retryable_failure", code: "FINALIZE_FAILED", handlerCompleted: true };
  }

  if (!finalized) {
    // A newer claim owns the event; we must not touch its state. Fail closed so Stripe
    // retries: the redelivery becomes already_processed once the new owner finishes.
    safeLog(deps, "webhook.stale_finalization_rejected", {
      ...claimCtx,
      errorCode: "CLAIM_SUPERSEDED",
      handlerCompleted: true,
    });
    await safeAudit(deps, {
      action: "webhook_stale_finalization_rejected",
      newValue: { ...baseCtx, attemptCount: claim.attemptCount, claimGeneration: claim.claimGeneration },
    });
    return { outcome: "retryable_failure", code: "CLAIM_SUPERSEDED", handlerCompleted: true };
  }

  if (!dispatched.handled) {
    safeLog(deps, "webhook.event_ignored_unsupported", { ...claimCtx, action: "unhandled" });
    return { outcome: "ignored", action: "unhandled", attemptCount: claim.attemptCount };
  }

  safeLog(deps, "webhook.event_processed", { ...claimCtx, action: dispatched.action });
  return { outcome: "processed", action: dispatched.action, attemptCount: claim.attemptCount };
}

async function handleDispatchFailure<E extends { id: string; type: string }>(
  deps: WebhookProcessingDeps<E>,
  claim: WebhookClaim,
  claimCtx: Record<string, unknown>,
  error: unknown,
): Promise<ProcessWebhookResult> {
  const classified = classifyWebhookFailure(error);
  const message = summarizeErrorForStorage(error);

  if (!classified.retryable) {
    safeLog(deps, "webhook.permanent_failure_dead_lettered", {
      ...claimCtx,
      errorCode: classified.code,
    });
    return finishDeadLetter(deps, claim, claimCtx, classified.code, {
      lastErrorCode: classified.code,
      message,
    });
  }

  // Retryable. Cap attempts so a poison event cannot loop indefinitely.
  if (claim.attemptCount >= deps.config.maxAttempts) {
    safeLog(deps, "webhook.retry_limit_exceeded_dead_lettered", {
      ...claimCtx,
      errorCode: "RETRY_LIMIT_EXCEEDED",
    });
    // The failure that exhausted the limit IS the original evidence: keep its own code
    // (HANDLER_ERROR / DB_TRANSIENT) and message; the stable dead-letter reason is
    // recorded separately as RETRY_LIMIT_EXCEEDED.
    return finishDeadLetter(deps, claim, claimCtx, "RETRY_LIMIT_EXCEEDED", {
      lastErrorCode: classified.code,
      message,
    });
  }

  safeLog(deps, "webhook.retryable_failure", { ...claimCtx, errorCode: classified.code });
  await safeAudit(deps, {
    action: "webhook_retryable_failure",
    newValue: {
      stripeEventId: claim.stripeEventId,
      attemptCount: claim.attemptCount,
      errorCode: classified.code,
    },
  });

  try {
    const released = await deps.store.releaseForRetry(claim, {
      code: classified.code,
      message,
    });
    if (!released) {
      // Superseded: a newer worker owns the event; do not touch it.
      safeLog(deps, "webhook.stale_finalization_rejected", {
        ...claimCtx,
        errorCode: "CLAIM_SUPERSEDED",
        handlerCompleted: false,
      });
    }
  } catch {
    // Lease will expire on its own; the event remains recoverable.
    safeLog(deps, "webhook.release_for_retry_failed", claimCtx);
  }

  return { outcome: "retryable_failure", code: classified.code, handlerCompleted: false };
}

async function finishDeadLetter<E extends { id: string; type: string }>(
  deps: WebhookProcessingDeps<E>,
  claim: WebhookClaim,
  claimCtx: Record<string, unknown>,
  code: WebhookFailureCode,
  evidence: { lastErrorCode?: string; message?: string },
): Promise<ProcessWebhookResult> {
  const persisted = await persistDeadLetter(deps, claim, code, evidence);

  if (persisted.kind === "recorded") {
    await safeAudit(deps, {
      action: "webhook_dead_lettered",
      newValue: {
        stripeEventId: claim.stripeEventId,
        attemptCount: claim.attemptCount,
        errorCode: code,
        // Null when the original evidence was preserved untouched on the row.
        originalErrorCode: evidence.lastErrorCode ?? null,
      },
    });
    return { outcome: "permanent_failure", code, deadLettered: true };
  }

  if (persisted.kind === "superseded") {
    safeLog(deps, "webhook.stale_finalization_rejected", {
      ...claimCtx,
      errorCode: "CLAIM_SUPERSEDED",
      handlerCompleted: false,
    });
    return { outcome: "retryable_failure", code: "CLAIM_SUPERSEDED", handlerCompleted: false };
  }

  // Could not durably record the terminal decision: never claim it was recorded. The
  // event stays recoverable. When this attempt produced fresh failure evidence, try to
  // persist it through the fenced release so it is not lost and the lease is freed
  // (the next claim then dead-letters via the attempt cap, preserving that evidence).
  // Best-effort: if the database is unavailable the lease simply expires.
  if (evidence.message !== undefined) {
    try {
      await deps.store.releaseForRetry(claim, {
        code: evidence.lastErrorCode ?? code,
        message: evidence.message,
      });
    } catch {
      safeLog(deps, "webhook.release_for_retry_failed", claimCtx);
    }
  }
  safeLog(deps, "webhook.retryable_failure", { ...claimCtx, errorCode: "DEAD_LETTER_PERSIST_FAILED" });
  return { outcome: "retryable_failure", code: "DEAD_LETTER_PERSIST_FAILED", handlerCompleted: false };
}
