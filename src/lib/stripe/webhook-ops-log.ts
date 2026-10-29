/**
 * Sanitized operational log lines for webhook processing.
 *
 * Distinguishes duplicate delivery, retry, permanent failure and success so alerts
 * can be keyed on a stable `event=` token. Never logs payloads, customer data,
 * stack traces, SQL, or secrets.
 *
 * NOTE: PaymentAuditLog rows are best-effort. A missing audit row does NOT imply an
 * uncommitted financial operation; the authoritative record of what happened is the
 * WebhookEvent row (status/attemptCount/lastErrorCode) plus the handler's own
 * transactional writes. These log lines are the fallback when the audit insert fails.
 */

export type WebhookOpsEvent =
  | "webhook.event_claimed"
  | "webhook.retry_attempt_started"
  | "webhook.expired_claim_reclaimed"
  | "webhook.duplicate_already_processed"
  | "webhook.duplicate_in_flight_skipped"
  | "webhook.duplicate_dead_lettered"
  | "webhook.claim_state_changed"
  | "webhook.event_processed"
  | "webhook.event_ignored_unsupported"
  | "webhook.retryable_failure"
  | "webhook.permanent_failure_dead_lettered"
  | "webhook.retry_limit_exceeded_dead_lettered"
  | "webhook.stale_finalization_rejected"
  | "webhook.handler_succeeded_finalize_failed"
  | "webhook.release_for_retry_failed"
  // Operator-triggered durable recovery (webhook-recovery.ts)
  | "webhook.recovery_run_started"
  | "webhook.recovery_run_completed"
  | "webhook.recovery_candidate_skipped_in_flight"
  | "webhook.recovery_candidate_failed"
  | "webhook.recovery_candidate_dead_lettered"
  | "webhook.recovery_candidate_lookup_failed"
  | "webhook.recovery_candidate_excluded_event_type"
  | "webhook.recovery_candidate_not_eligible"
  | "webhook.recovery_claim_not_eligible";

const SAFE_CONTEXT_KEYS = new Set([
  "actor",
  "batchSize",
  "minRetryAgeSeconds",
  "maxDurationMs",
  "scanned",
  "attempted",
  "recovered",
  "alreadyProcessed",
  "skippedInFlight",
  "stillRetryable",
  "deadLettered",
  "alreadyDeadLettered",
  "skippedNotEligible",
  "excludedEventType",
  "errors",
  "hasMore",
  "stoppedEarly",
  "stripeEventId",
  "eventType",
  "attemptCount",
  "claimGeneration",
  "previousStatus",
  "outcome",
  "action",
  "errorCode",
  "handlerCompleted",
  "maxAttempts",
]);

export function sanitizeWebhookOpsContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (!SAFE_CONTEXT_KEYS.has(key)) continue;
    if (value == null) {
      out[key] = value;
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** Events that warrant error-level visibility (alertable). */
const ERROR_LEVEL_EVENTS = new Set<WebhookOpsEvent>([
  "webhook.retryable_failure",
  "webhook.permanent_failure_dead_lettered",
  "webhook.retry_limit_exceeded_dead_lettered",
  "webhook.stale_finalization_rejected",
  "webhook.handler_succeeded_finalize_failed",
  "webhook.release_for_retry_failed",
  "webhook.claim_state_changed",
  "webhook.duplicate_dead_lettered",
  "webhook.recovery_candidate_failed",
  "webhook.recovery_candidate_dead_lettered",
  "webhook.recovery_candidate_lookup_failed",
]);

export function webhookOpsEventLevel(event: WebhookOpsEvent): "error" | "info" {
  return ERROR_LEVEL_EVENTS.has(event) ? "error" : "info";
}

export function logWebhookOpsEvent(
  event: WebhookOpsEvent,
  context: Record<string, unknown> = {},
): void {
  try {
    const line = `[webhook-ops] event=${event}`;
    const safe = sanitizeWebhookOpsContext(context);
    if (webhookOpsEventLevel(event) === "error") {
      console.error(line, safe);
    } else {
      console.info(line, safe);
    }
  } catch {
    // Logging must never alter processing outcome.
  }
}
