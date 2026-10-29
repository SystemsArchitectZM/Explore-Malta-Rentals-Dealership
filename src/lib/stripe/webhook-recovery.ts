/**
 * Durable, bounded recovery of stored Stripe webhook events (Stage 3.21).
 *
 * WHY: recovery must not depend on Stripe redelivering an event. Eligible events are
 * found from durable database state and re-run through the SAME orchestrator
 * (`processWebhookEventWithDeps` via the injected `processEvent`) that handles live
 * deliveries. There is deliberately no second event-processing implementation here.
 *
 * What this module does NOT do (by construction, so it cannot weaken the contract):
 *   - It never writes WebhookEvent state itself. It only selects candidates (read-only)
 *     and hands each one to `processEvent`, which performs the atomic conditional
 *     claim (`tryClaim`), runs the handler under the fencing token, and persists the
 *     outcome with fenced updates.
 *   - It never resets a row to RECEIVED, never clears a lease, never edits attempt
 *     counters, and never replays DEAD_LETTER or PROCESSED events. An expired lease is
 *     only permission to ATTEMPT a new claim — not proof that the previous handler has
 *     stopped, which is why handler idempotency (payment-row FOR UPDATE, authoritative
 *     refund caps, PENDING-before-Stripe reservations, stable Stripe idempotency keys)
 *     remains the real duplicate-effect protection.
 *   - An outcome is counted as `recovered` only when `processEvent` returned
 *     processed/ignored, which the orchestrator returns ONLY after its fenced
 *     markProcessed succeeded. A failed terminal write surfaces as a retryable
 *     failure and is counted as `stillRetryable`, never as success.
 *
 * Concurrency: two overlapping recovery invocations (or recovery racing a live Stripe
 * delivery) both go through `tryClaim`; exactly one can own an event, the other
 * receives `in_flight` and is counted in `skippedInFlight`. No global lock is needed
 * and none is used (session-level advisory locks are unsafe with pooled connections,
 * and a transaction-scoped one would have to span Stripe-bound handler work).
 *
 * Bounds: batch size, per-invocation wall-clock budget, and (because every claim
 * increments attemptCount) the configured attempt limit, after which the claim path
 * dead-letters instead of running the handler. Repeated recovery therefore cannot loop.
 *
 * No Prisma/Stripe imports: unit-testable with injected deps. The PostgreSQL candidate
 * query lives in webhook-recovery-store.ts.
 */

import type { WebhookOpsEvent } from "./webhook-ops-log";
import type {
  AuditAction,
  ProcessWebhookResult,
  WebhookRecoveryIneligibleResult,
} from "./types";
import type { WebhookRecoveryClaimOptions } from "./webhook-event-claim";
import {
  RECOVERY_DEFAULT_BUDGET_SECONDS,
  isRecoveryExcludedCandidate,
} from "./webhook-recovery-policy";

// ─── Limits ────────────────────────────────────────────────────────────────────

/**
 * Stage 3.23: default lowered 10 -> 5. Every candidate can run a Stripe-bound handler
 * (refund/payment reconciliation), so a small default keeps one HTTP request short; the
 * maximum stays 25 for operators who deliberately raise it per call.
 */
export const RECOVERY_DEFAULT_BATCH_SIZE = 5;
export const RECOVERY_MAX_BATCH_SIZE = 25;

/**
 * RETRYABLE_FAILED events are only eligible once their last attempt is at least this
 * old, so recovery does not fight Stripe's own redelivery of a just-failed event.
 * Expired PROCESSING leases are eligible as soon as the lease (database clock) expires.
 */
export const RECOVERY_DEFAULT_MIN_RETRY_AGE_SECONDS = 300;
export const RECOVERY_MIN_MIN_RETRY_AGE_SECONDS = 60;
export const RECOVERY_MAX_MIN_RETRY_AGE_SECONDS = 86_400;

/**
 * SOFT wall-clock budget for one invocation (candidates after it are left for the next
 * run). It is only checked BETWEEN events: an event already being handled is not
 * cancelled, so one slow handler can overrun the budget. The production value comes from
 * STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS (see webhook-recovery-policy.ts); this constant
 * is the default used when a caller injects none.
 */
export const RECOVERY_DEFAULT_MAX_DURATION_MS = RECOVERY_DEFAULT_BUDGET_SECONDS * 1000;

export type WebhookRecoveryRunInput = {
  batchSize: number;
  minRetryAgeSeconds: number;
};

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Defensive normalisation (the HTTP layer validates; this protects direct callers). */
export function normalizeRecoveryRunInput(
  input: Partial<WebhookRecoveryRunInput> = {},
): WebhookRecoveryRunInput {
  return {
    batchSize: clampInt(
      input.batchSize ?? RECOVERY_DEFAULT_BATCH_SIZE,
      1,
      RECOVERY_MAX_BATCH_SIZE,
      RECOVERY_DEFAULT_BATCH_SIZE,
    ),
    minRetryAgeSeconds: clampInt(
      input.minRetryAgeSeconds ?? RECOVERY_DEFAULT_MIN_RETRY_AGE_SECONDS,
      RECOVERY_MIN_MIN_RETRY_AGE_SECONDS,
      RECOVERY_MAX_MIN_RETRY_AGE_SECONDS,
      RECOVERY_DEFAULT_MIN_RETRY_AGE_SECONDS,
    ),
  };
}

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Durable-state candidate (advisory; the claim re-checks everything atomically).
 * Returned: PROCESSING (expired lease) and RETRYABLE_FAILED rows claimed at least once
 * under the lease protocol, plus never-claimed RECEIVED rows ONLY when they were created
 * at/after a valid claim-protocol cutover. Never returned: DEAD_LETTER, PROCESSED, active
 * leases, claimGeneration = 0 legacy rows, and any type in
 * RECOVERY_EXCLUDED_EVENT_TYPES (currently empty).
 */
export type WebhookRecoveryCandidate = {
  stripeEventId: string;
  eventType: string;
  status: "PROCESSING" | "RETRYABLE_FAILED" | "RECEIVED";
  attemptCount: number;
  /** Stored full Stripe event JSON. Never logged or returned. */
  payload: unknown;
};

export type RecoveryEvent = { id: string; type: string; [key: string]: unknown };

export type WebhookRecoveryDeps = {
  /** Read-only. Advisory only: ownership is decided by the claim inside processEvent. */
  listCandidates: (input: {
    limit: number;
    minRetryAgeSeconds: number;
    claimProtocolCutoverIso: string | null;
  }) => Promise<WebhookRecoveryCandidate[]>;
  /**
   * MUST be the production orchestrator (claim + fenced dispatch + fenced finalize).
   * `recovery` makes the claim itself enforce the recovery eligibility predicate;
   * `recovery_not_eligible` means nothing was claimed or run (a skip, not a failure).
   */
  processEvent: (
    event: RecoveryEvent,
    recovery: WebhookRecoveryClaimOptions,
  ) => Promise<ProcessWebhookResult | WebhookRecoveryIneligibleResult>;
  /**
   * Validated claim-protocol cutover (UTC ISO) or null. null (unset/invalid) = fail
   * closed: claimGeneration = 0 rows are never recovered.
   */
  claimProtocolCutoverIso?: string | null;
  /** Best-effort run-level audit (counts and event ids only; never payloads). */
  audit: (args: {
    action: AuditAction;
    actor: string;
    newValue: Record<string, unknown>;
  }) => Promise<void>;
  log: (event: WebhookOpsEvent, context: Record<string, unknown>) => void;
  now: () => number;
  maxDurationMs?: number;
};

export type RecoveryEventOutcome =
  | "recovered"
  | "already_processed"
  | "skipped_in_flight"
  /** Recovery predicate no longer held at claim time; nothing claimed, no attempt consumed. */
  | "skipped_not_eligible"
  /** Defense-in-depth: candidate is an excluded event type; never handed to the orchestrator. */
  | "excluded_event_type"
  | "still_retryable"
  /** Dead-lettered by THIS attempt (terminal state durably persisted first). */
  | "dead_lettered"
  /** Row was already DEAD_LETTER (race with another worker); nothing was replayed. */
  | "already_dead_lettered"
  | "error";

export type RecoveryEventReport = {
  stripeEventId: string;
  eventType: string;
  outcome: RecoveryEventOutcome;
  /** Stable failure code when applicable. */
  code?: string;
};

export type WebhookRecoveryResult = {
  /** Candidates selected for this invocation (<= batchSize). */
  scanned: number;
  /** Candidates handed to the orchestrator (<= scanned; less if the time budget ran out). */
  attempted: number;
  recovered: number;
  alreadyProcessed: number;
  skippedInFlight: number;
  /** Selected but no longer recovery-eligible at claim time (not a failure; no attempt consumed). */
  skippedNotEligible: number;
  /**
   * Candidates dropped by the in-process excluded-event-type check. The SQL already
   * excludes these types, so this is normally 0; true totals are in the report's
   * `excludedEventTypeRecoverable` count.
   */
  excludedEventType: number;
  stillRetryable: number;
  deadLettered: number;
  alreadyDeadLettered: number;
  errors: number;
  /** More eligible events may remain (batch cap or time budget reached). */
  hasMore: boolean;
  stoppedEarly: boolean;
  events: RecoveryEventReport[];
};

export class WebhookRecoveryLookupError extends Error {
  readonly code = "RECOVERY_LOOKUP_FAILED";
  constructor() {
    super("Could not list recovery candidates");
    this.name = "WebhookRecoveryLookupError";
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuild the event object from the stored payload. The row's own id/type columns win
 * so the orchestrator always claims the row this candidate came from. A non-object
 * payload yields an event without `data`, which the dispatcher classifies as the
 * permanent EVENT_PAYLOAD_INVALID (dead-letter) instead of looping.
 */
export function buildEventFromCandidate(candidate: WebhookRecoveryCandidate): RecoveryEvent {
  const base = isRecord(candidate.payload) ? candidate.payload : {};
  return { ...base, id: candidate.stripeEventId, type: candidate.eventType };
}

function classifyResult(result: ProcessWebhookResult | WebhookRecoveryIneligibleResult): {
  outcome: RecoveryEventOutcome;
  code?: string;
} {
  switch (result.outcome) {
    case "recovery_not_eligible":
      return { outcome: "skipped_not_eligible" };
    case "processed":
    case "ignored":
      return { outcome: "recovered" };
    case "already_processed":
      return { outcome: "already_processed" };
    case "in_flight":
      return { outcome: "skipped_in_flight" };
    case "retryable_failure":
      return { outcome: "still_retryable", code: result.code };
    case "permanent_failure":
      if (result.code === "EVENT_DEAD_LETTERED") {
        return { outcome: "already_dead_lettered", code: result.code };
      }
      // deadLettered=false never occurs today; treat conservatively as retryable.
      return result.deadLettered
        ? { outcome: "dead_lettered", code: result.code }
        : { outcome: "still_retryable", code: result.code };
  }
}

function safeLog(
  deps: WebhookRecoveryDeps,
  event: WebhookOpsEvent,
  context: Record<string, unknown>,
): void {
  try {
    deps.log(event, context);
  } catch {
    // Logging must never alter recovery behaviour.
  }
}

// ─── Run ───────────────────────────────────────────────────────────────────────

/**
 * Run one bounded recovery pass. Throws only WebhookRecoveryLookupError (candidate
 * query failed — nothing was attempted). Per-event failures never abort the batch.
 */
export async function runWebhookRecovery(
  rawInput: Partial<WebhookRecoveryRunInput>,
  actor: string,
  deps: WebhookRecoveryDeps,
): Promise<WebhookRecoveryResult> {
  const input = normalizeRecoveryRunInput(rawInput);
  const maxDurationMs = deps.maxDurationMs ?? RECOVERY_DEFAULT_MAX_DURATION_MS;
  const startedAt = deps.now();
  const claimProtocolCutoverIso = deps.claimProtocolCutoverIso ?? null;
  const claimOptions: WebhookRecoveryClaimOptions = {
    minRetryAgeSeconds: input.minRetryAgeSeconds,
    claimProtocolCutoverIso,
  };

  safeLog(deps, "webhook.recovery_run_started", {
    actor,
    batchSize: input.batchSize,
    minRetryAgeSeconds: input.minRetryAgeSeconds,
    maxDurationMs,
  });

  let candidates: WebhookRecoveryCandidate[];
  try {
    // Fetch one extra row so `hasMore` is exact without a second count query.
    candidates = await deps.listCandidates({
      limit: input.batchSize + 1,
      minRetryAgeSeconds: input.minRetryAgeSeconds,
      claimProtocolCutoverIso,
    });
  } catch {
    safeLog(deps, "webhook.recovery_candidate_lookup_failed", { actor, errorCode: "RECOVERY_LOOKUP_FAILED" });
    throw new WebhookRecoveryLookupError();
  }

  const batch = candidates.slice(0, input.batchSize);
  const result: WebhookRecoveryResult = {
    scanned: batch.length,
    attempted: 0,
    recovered: 0,
    alreadyProcessed: 0,
    skippedInFlight: 0,
    skippedNotEligible: 0,
    excludedEventType: 0,
    stillRetryable: 0,
    deadLettered: 0,
    alreadyDeadLettered: 0,
    errors: 0,
    hasMore: candidates.length > input.batchSize,
    stoppedEarly: false,
    events: [],
  };

  for (const candidate of batch) {
    if (deps.now() - startedAt >= maxDurationMs) {
      result.stoppedEarly = true;
      result.hasMore = true;
      break;
    }
    const ctx = { stripeEventId: candidate.stripeEventId, eventType: candidate.eventType };

    // Defense in depth: when RECOVERY_EXCLUDED_EVENT_TYPES is non-empty, SQL already
    // filters them; still never hand a matching candidate to the orchestrator even if
    // a lister returns it. Nothing is written: the row keeps its state.
    let report: RecoveryEventReport;
    if (isRecoveryExcludedCandidate(candidate)) {
      report = { ...ctx, outcome: "excluded_event_type", code: "RECOVERY_EXCLUDED_EVENT_TYPE" };
    } else {
      result.attempted += 1;
      try {
        const processed = await deps.processEvent(
          buildEventFromCandidate(candidate),
          claimOptions,
        );
        const { outcome, code } = classifyResult(processed);
        report = { ...ctx, outcome, ...(code ? { code } : {}) };
      } catch {
        // processEvent is designed not to throw. If it does, the outcome is UNKNOWN, so
        // it is reported as an error (never as recovered); durable state decides next run.
        report = { ...ctx, outcome: "error", code: "RECOVERY_DISPATCH_ERROR" };
      }
    }

    switch (report.outcome) {
      case "skipped_not_eligible":
        result.skippedNotEligible += 1;
        safeLog(deps, "webhook.recovery_candidate_not_eligible", ctx);
        break;
      case "excluded_event_type":
        result.excludedEventType += 1;
        safeLog(deps, "webhook.recovery_candidate_excluded_event_type", ctx);
        break;
      case "recovered":
        result.recovered += 1;
        break;
      case "already_processed":
        result.alreadyProcessed += 1;
        break;
      case "skipped_in_flight":
        result.skippedInFlight += 1;
        safeLog(deps, "webhook.recovery_candidate_skipped_in_flight", ctx);
        break;
      case "still_retryable":
        result.stillRetryable += 1;
        safeLog(deps, "webhook.recovery_candidate_failed", { ...ctx, errorCode: report.code });
        break;
      case "dead_lettered":
        result.deadLettered += 1;
        safeLog(deps, "webhook.recovery_candidate_dead_lettered", { ...ctx, errorCode: report.code });
        break;
      case "already_dead_lettered":
        result.alreadyDeadLettered += 1;
        break;
      case "error":
        result.errors += 1;
        safeLog(deps, "webhook.recovery_candidate_failed", { ...ctx, errorCode: report.code });
        break;
    }
    result.events.push(report);
  }

  safeLog(deps, "webhook.recovery_run_completed", {
    actor,
    scanned: result.scanned,
    attempted: result.attempted,
    recovered: result.recovered,
    alreadyProcessed: result.alreadyProcessed,
    skippedInFlight: result.skippedInFlight,
    skippedNotEligible: result.skippedNotEligible,
    excludedEventType: result.excludedEventType,
    stillRetryable: result.stillRetryable,
    deadLettered: result.deadLettered,
    alreadyDeadLettered: result.alreadyDeadLettered,
    errors: result.errors,
    hasMore: result.hasMore,
    stoppedEarly: result.stoppedEarly,
  });

  try {
    await deps.audit({
      action: "webhook_recovery_run",
      actor,
      newValue: {
        batchSize: input.batchSize,
        minRetryAgeSeconds: input.minRetryAgeSeconds,
        scanned: result.scanned,
        attempted: result.attempted,
        recovered: result.recovered,
        alreadyProcessed: result.alreadyProcessed,
        skippedInFlight: result.skippedInFlight,
        skippedNotEligible: result.skippedNotEligible,
        excludedEventType: result.excludedEventType,
        stillRetryable: result.stillRetryable,
        deadLettered: result.deadLettered,
        alreadyDeadLettered: result.alreadyDeadLettered,
        errors: result.errors,
        hasMore: result.hasMore,
        stoppedEarly: result.stoppedEarly,
        maxDurationMs,
        // ids/types/outcome codes only; bounded by RECOVERY_MAX_BATCH_SIZE.
        events: result.events,
      },
    });
  } catch {
    // Best-effort by contract (same as every webhook audit row). Per-event outcomes are
    // already durable on the WebhookEvent rows and in the ops log lines above.
  }

  return result;
}
