/**
 * Pure (dependency-free) recovery policy: which stored events automatic recovery must
 * not touch, how the claim-protocol cutover marker is interpreted, and the soft time
 * budget configuration. Nothing here reads or exposes secrets; the only environment
 * variables consulted are the two non-secret tuning knobs documented below.
 *
 * Configuration (non-secret, same convention as STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS):
 *
 *   STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS
 *     Soft per-pass time budget. Default 10, clamped to 1..60. A missing, blank or
 *     non-integer value falls back to the default (conservative), never to "unbounded".
 *
 *   STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT
 *     Optional ISO-8601 instant WITH an explicit offset (e.g. 2026-11-02T09:30:00Z).
 *     Meaning: "from this instant on, every application instance that can ingest Stripe
 *     webhooks uses the lease-claim protocol (Stage 3.19+); no pre-claim instance can
 *     insert or process WebhookEvent rows." An operator must set it only after a
 *     controlled drain/switch. It is NEVER defaulted or inferred. Missing, malformed,
 *     pre-2020 or future-dated values are rejected and recovery FAILS CLOSED: rows with
 *     claimGeneration = 0 stay excluded from automatic recovery and visible in the
 *     diagnostic report.
 */

// ─── Event types excluded from AUTOMATIC recovery ──────────────────────────────

/**
 * Types that automatic recovery must never select, claim, or dispatch.
 *
 * Empty after Step 13: `payment_intent.payment_failed` / `payment_intent.canceled`
 * were previously excluded because early handlers released bookings by
 * `metadata.bookingId` alone. Automatic recovery redispatches the stored Stripe
 * event through the same orchestrator as live delivery
 * (`processWebhookEventForRecovery` → `processWebhookEventWithDeps` →
 * `dispatchStripeEvent`). Step 11's `decideUnpaidTerminalPaymentIntentEffect`
 * now requires a matching stored PaymentIntent (or retries until linked) and
 * ignores stale/paid-lineage rows, so recovery of these types reuses those
 * attempt-scoped rules and claim/idempotency/retry budgets without a separate
 * bookingId-only path.
 *
 * Keep this constant (and the SQL/report `isExcluded` plumbing) so a future
 * exclusion can be reintroduced without inventing a second recovery path. When
 * non-empty, SQL in webhook-event-store.ts and webhook-recovery-store.ts must
 * embed the same literals (asserted by scripts/test-webhook-recovery.ts).
 */
export const RECOVERY_EXCLUDED_EVENT_TYPES = [] as const;

export function isRecoveryExcludedEventType(type: unknown): boolean {
  return (
    typeof type === "string" &&
    (RECOVERY_EXCLUDED_EVENT_TYPES as readonly string[]).includes(type)
  );
}

/**
 * Event type is stored twice: the `eventType` column (authoritative; dispatch uses it)
 * and `payload.type`. Fail closed on EITHER, and on any payload shape we cannot read
 * (a non-object payload simply contributes no payload type; the column still decides).
 */
export function isRecoveryExcludedCandidate(candidate: {
  eventType: unknown;
  payload: unknown;
}): boolean {
  if (isRecoveryExcludedEventType(candidate.eventType)) return true;
  const payload = candidate.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    return isRecoveryExcludedEventType((payload as Record<string, unknown>).type);
  }
  return false;
}

// ─── Claim-protocol cutover marker ─────────────────────────────────────────────

export type ClaimProtocolCutoverStatus = "unset" | "invalid" | "valid";

export type ClaimProtocolCutover = {
  status: ClaimProtocolCutoverStatus;
  /** Normalized UTC ISO instant; non-null only when status === "valid". */
  value: string | null;
};

const MIN_CUTOVER_YEAR = 2020;

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Strict parse. Anything ambiguous (no offset, impossible calendar date, future
 * instant, absurdly old) is "invalid" and recovery fails closed.
 */
export function resolveClaimProtocolCutover(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): ClaimProtocolCutover {
  const raw = env.STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT;
  if (raw === undefined || raw.trim() === "") {
    return { status: "unset", value: null };
  }
  const invalid: ClaimProtocolCutover = { status: "invalid", value: null };

  const match = ISO_WITH_OFFSET.exec(raw.trim());
  if (!match) return invalid;

  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s === undefined ? 0 : Number(s);
  if (year < MIN_CUTOVER_YEAR || hour > 23 || minute > 59 || second > 59) return invalid;

  // Reject impossible calendar dates (e.g. Feb 31) instead of letting Date roll over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return invalid;
  }

  const ms = Date.parse(raw.trim());
  if (Number.isNaN(ms)) return invalid;
  if (ms > nowMs) return invalid; // a future cutover cannot describe the past

  return { status: "valid", value: new Date(ms).toISOString() };
}

// ─── Soft time budget ──────────────────────────────────────────────────────────

export const RECOVERY_DEFAULT_BUDGET_SECONDS = 10;
export const RECOVERY_MIN_BUDGET_SECONDS = 1;
export const RECOVERY_MAX_BUDGET_SECONDS = 60;

/**
 * SOFT budget: it is checked between events only. A handler already running is not
 * cancelled and can overrun it. See docs/stripe-webhook-reliability.md.
 */
export function resolveRecoveryBudgetMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS;
  if (raw === undefined || raw.trim() === "") {
    return RECOVERY_DEFAULT_BUDGET_SECONDS * 1000;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    return RECOVERY_DEFAULT_BUDGET_SECONDS * 1000;
  }
  const clamped = Math.min(
    RECOVERY_MAX_BUDGET_SECONDS,
    Math.max(RECOVERY_MIN_BUDGET_SECONDS, parsed),
  );
  return clamped * 1000;
}

export type WebhookRecoveryConfig = {
  maxDurationMs: number;
  claimProtocolCutover: ClaimProtocolCutover;
};

export function resolveWebhookRecoveryConfig(
  env: Record<string, string | undefined> = process.env,
  nowMs: number = Date.now(),
): WebhookRecoveryConfig {
  return {
    maxDurationMs: resolveRecoveryBudgetMs(env),
    claimProtocolCutover: resolveClaimProtocolCutover(env, nowMs),
  };
}
