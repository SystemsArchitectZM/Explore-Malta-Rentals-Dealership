/**
 * Lease-based claim + fencing contract for Stripe webhook events.
 *
 * State machine (WebhookEvent.status):
 *
 *   (absent) --ensureRecord--> RECEIVED
 *   RECEIVED | RETRYABLE_FAILED | PROCESSING(lease expired)
 *        --tryClaim (single conditional UPDATE)--> PROCESSING
 *   PROCESSING --markProcessed--> PROCESSED                      (terminal)
 *   PROCESSING --releaseForRetry--> RETRYABLE_FAILED             (reclaimable)
 *   PROCESSING --markDeadLetter--> DEAD_LETTER                   (terminal; ops review)
 *   PROCESSING + worker crash --lease expiry--> reclaimable by next delivery
 *
 * Fencing: every successful claim increments `claimGeneration` and sets a fresh
 * `claimToken`. markProcessed / releaseForRetry / markDeadLetter update the row only
 * `WHERE status = 'PROCESSING' AND claimToken = $token AND claimGeneration = $gen`.
 * A stale worker therefore cannot overwrite a newer owner's status, error or
 * completion state.
 *
 * CRITICAL LIMITATION — read before relying on fencing:
 * A lease does not cancel an old worker's already-running handler. After a lease
 * expires, worker A may still be executing financial writes while worker B claims and
 * runs the same handler. Fencing only protects the WebhookEvent row (A cannot finalize
 * B's claim). Duplicate side effects are prevented ONLY by handler idempotency:
 * payment-row `FOR UPDATE` locking, absolute SUCCEEDED recomputes, unique Stripe ids,
 * and PENDING-before-Stripe reservations. This module does not claim exactly-once
 * execution across PostgreSQL and Stripe.
 *
 * Leases are not heartbeat-renewed: handlers are short database transactions. The
 * default lease is deliberately long relative to a handler (see config) so ordinary
 * slow work does not lose its claim.
 *
 * This file contains no Prisma/Stripe imports so the logic is unit-testable. The
 * PostgreSQL implementation is webhook-event-store.ts. In-memory test stores can model
 * the contract but CANNOT prove PostgreSQL row-lock / READ COMMITTED behaviour.
 */

import { randomUUID } from "node:crypto";

import type { WebhookEventStatusValue } from "./types";

// ─── Configuration ─────────────────────────────────────────────────────────────

export const DEFAULT_WEBHOOK_CLAIM_LEASE_SECONDS = 300;
export const MIN_WEBHOOK_CLAIM_LEASE_SECONDS = 60;
export const MAX_WEBHOOK_CLAIM_LEASE_SECONDS = 1800;

export const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 8;
/**
 * Floor for the configured attempt limit. A limit of 1 would dead-letter on the first
 * transient failure (effectively disabling retries), so configuration cannot go below 3.
 */
export const MIN_WEBHOOK_MAX_ATTEMPTS = 3;
export const MAX_WEBHOOK_MAX_ATTEMPTS = 50;

export type WebhookClaimConfig = {
  leaseSeconds: number;
  /** Claims after which a retryable failure is dead-lettered instead of released. */
  maxAttempts: number;
};

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Non-secret tuning knobs:
 *   STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS (default 300, clamped 60..1800)
 *   STRIPE_WEBHOOK_MAX_ATTEMPTS        (default 8,   clamped 3..50)
 * Invalid values fall back to defaults rather than producing unsafe short leases;
 * out-of-range integers are clamped (e.g. 0 or 1 becomes 3, never "no retries").
 */
export function resolveWebhookClaimConfig(
  env: Record<string, string | undefined> = process.env,
): WebhookClaimConfig {
  return {
    leaseSeconds: parseBoundedInt(
      env.STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS,
      DEFAULT_WEBHOOK_CLAIM_LEASE_SECONDS,
      MIN_WEBHOOK_CLAIM_LEASE_SECONDS,
      MAX_WEBHOOK_CLAIM_LEASE_SECONDS,
    ),
    maxAttempts: parseBoundedInt(
      env.STRIPE_WEBHOOK_MAX_ATTEMPTS,
      DEFAULT_WEBHOOK_MAX_ATTEMPTS,
      MIN_WEBHOOK_MAX_ATTEMPTS,
      MAX_WEBHOOK_MAX_ATTEMPTS,
    ),
  };
}

// ─── Contract ──────────────────────────────────────────────────────────────────

export type WebhookEventRecordInput = {
  id: string;
  type: string;
  /** Stored once at creation; never overwritten by later deliveries. */
  payload: unknown;
};

/** Proof of ownership returned by a successful claim. */
export type WebhookClaim = {
  eventRowId: string;
  stripeEventId: string;
  claimToken: string;
  claimGeneration: number;
  attemptCount: number;
  /** Status immediately before this claim (RECEIVED, RETRYABLE_FAILED or PROCESSING). */
  previousStatus: WebhookEventStatusValue;
};

/**
 * Recovery-specific claim eligibility, enforced ATOMICALLY inside the same conditional
 * UPDATE as the normal claim (so a candidate selected earlier cannot consume another
 * attempt after a newer one made it ineligible). Passed ONLY by operator recovery; live
 * Stripe deliveries never pass it and keep their original claim behaviour.
 *
 * It only ever NARROWS what the normal claim allows. It never skips the lease check,
 * the attempt counter, the generation/token assignment or terminal-state handling.
 */
export type WebhookRecoveryClaimOptions = {
  /** RETRYABLE_FAILED (and cutover-era RECEIVED) rows must be at least this old (DB clock). */
  minRetryAgeSeconds: number;
  /**
   * Validated claim-protocol cutover (UTC ISO) or null. null means rows with
   * claimGeneration = 0 are NOT recoverable (fail closed).
   */
  claimProtocolCutoverIso: string | null;
};

export type WebhookEventState = {
  status: WebhookEventStatusValue;
  processed: boolean;
  /** True only while status = PROCESSING and the lease has not expired (DB clock). */
  leaseActive: boolean;
};

export type WebhookFailureRecord = {
  code: string;
  message: string;
};

/**
 * Terminal disposition. `reason` is ALWAYS written (stable code: why the event is
 * dead-lettered). `lastErrorCode` / `message` are written only when provided; when
 * omitted the store MUST preserve the existing values, so a dead-letter decision taken
 * without a fresh failure (retry limit reached at claim time) never erases the
 * original failure evidence.
 */
export type WebhookDeadLetterRecord = {
  reason: string;
  lastErrorCode?: string;
  message?: string;
};

export interface WebhookEventStore {
  /**
   * Create the row if absent. MUST NOT claim and MUST NOT overwrite an existing row
   * (an upsert-with-empty-update is acceptable only if it changes nothing).
   */
  ensureRecord(event: WebhookEventRecordInput): Promise<void>;

  /**
   * One atomic conditional operation: succeeds only when processed = false and the
   * row is RECEIVED, RETRYABLE_FAILED, or PROCESSING with an expired lease. On success
   * increments attemptCount and claimGeneration, assigns claimToken, sets the lease.
   * Returns null when no row qualified.
   */
  tryClaim(input: {
    stripeEventId: string;
    claimToken: string;
    leaseSeconds: number;
    /**
     * Present only for operator recovery. When present the claim additionally requires
     * the recovery eligibility predicate (event-type exclusion, backoff, cutover).
     */
    recovery?: WebhookRecoveryClaimOptions;
  }): Promise<WebhookClaim | null>;

  readState(stripeEventId: string): Promise<WebhookEventState | null>;

  /** Fenced. Returns false when the claim is no longer the current one. */
  markProcessed(claim: WebhookClaim): Promise<boolean>;
  /** Fenced. Clears the lease and makes the event reclaimable. */
  releaseForRetry(claim: WebhookClaim, failure: WebhookFailureRecord): Promise<boolean>;
  /** Fenced. Terminal; clears the lease; preserves evidence not supplied (see record type). */
  markDeadLetter(claim: WebhookClaim, record: WebhookDeadLetterRecord): Promise<boolean>;
}

export type WebhookClaimResult =
  | { kind: "acquired"; claim: WebhookClaim }
  | { kind: "already_processed" }
  | { kind: "dead_lettered" }
  | { kind: "in_flight" }
  /** Recovery-only: row exists, is non-terminal and unleased, but the recovery predicate no longer holds. */
  | { kind: "recovery_not_eligible" }
  | { kind: "unavailable"; reason: "state_changed" | "missing_record" };

/**
 * Attempt to claim an event that already has a row. Distinguishes why a claim was
 * not acquired so callers can map outcomes deterministically.
 */
export async function claimWebhookEvent(
  store: WebhookEventStore,
  stripeEventId: string,
  config: WebhookClaimConfig,
  newToken: () => string = randomUUID,
  recovery?: WebhookRecoveryClaimOptions,
): Promise<WebhookClaimResult> {
  const claim = await store.tryClaim({
    stripeEventId,
    claimToken: newToken(),
    leaseSeconds: config.leaseSeconds,
    ...(recovery ? { recovery } : {}),
  });
  if (claim) {
    return { kind: "acquired", claim };
  }

  const state = await store.readState(stripeEventId);
  if (!state) {
    return { kind: "unavailable", reason: "missing_record" };
  }
  if (state.processed || state.status === "PROCESSED") {
    return { kind: "already_processed" };
  }
  if (state.status === "DEAD_LETTER") {
    return { kind: "dead_lettered" };
  }
  if (state.status === "PROCESSING" && state.leaseActive) {
    return { kind: "in_flight" };
  }
  if (recovery) {
    // The normal claim would have been allowed here (non-terminal, no active lease), so
    // the recovery-only predicate is what refused it: a skip, not a failure.
    return { kind: "recovery_not_eligible" };
  }
  // Qualifying state at read time but the conditional update matched nothing:
  // another worker changed the row between the two statements.
  return { kind: "unavailable", reason: "state_changed" };
}

/**
 * Pure mirror of the migration backfill, used by tests to document and check the
 * legacy-row mapping. The SQL in the migration is the executable source of truth.
 */
export function legacyWebhookEventStatus(row: {
  processed: boolean;
  error: string | null;
}): { status: WebhookEventStatusValue; attemptCount: number; lastErrorCode: string | null } {
  if (row.processed) {
    return { status: "PROCESSED", attemptCount: 1, lastErrorCode: null };
  }
  if (row.error !== null) {
    return {
      status: "RETRYABLE_FAILED",
      attemptCount: 1,
      lastErrorCode: "LEGACY_UNCLASSIFIED_ERROR",
    };
  }
  return { status: "RECEIVED", attemptCount: 0, lastErrorCode: null };
}
