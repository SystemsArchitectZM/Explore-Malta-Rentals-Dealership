/**
 * Maps typed webhook outcomes to HTTP responses. Status is derived ONLY from the
 * discriminated `outcome` — never from error-message text.
 *
 * Policy (Stripe treats any non-2xx as failed and retries with backoff):
 *
 *   processed / ignored / already_processed     200  complete (or intentional no-op) and recorded
 *   in_flight                                   503  retryable; this delivery ran NO handler
 *   permanent_failure (dead-lettered)           200  terminal decision durably recorded; stop retries,
 *                                                    operators review DEAD_LETTER rows
 *   retryable_failure                           500  incomplete; a retry may help
 *   missing/invalid signature, unreadable body  400  (decided in the route, before any processing)
 *   server misconfiguration (no signing secret) 500  (decided in the route; not a client error)
 *
 * in_flight = 503 (Stage 3.21; supersedes the earlier 200 policy):
 *   An in-flight duplicate means ANOTHER worker holds an unexpired lease. This delivery
 *   ran nothing and recorded nothing, so acknowledging it with 2xx could tell Stripe
 *   the event is handled when it may never complete (the owner can crash after the
 *   duplicate was acknowledged, and Stripe might then stop redelivering). A retryable
 *   status keeps Stripe's own redelivery as an additional recovery path. Durable
 *   recovery does NOT depend on it (see webhook-recovery.ts).
 *
 *   The response is produced from a read-only observation: answering 503 never changes
 *   the lease owner's state and never releases or steals its lease.
 *
 *   TRADE-OFF: a retryable response can increase duplicate deliveries while a slow
 *   handler is still running. Duplicates that arrive after the lease expires CAN
 *   re-enter the handler (a lease does not stop a running handler), so handler
 *   idempotency remains essential and is what actually protects financial state.
 *
 * Response bodies contain only stable codes — no stack traces, SQL, or secrets.
 */

import type { ProcessWebhookResult } from "./types";

export const WEBHOOK_IN_FLIGHT_HTTP_STATUS = 503;

/** Seconds suggested to the caller via Retry-After for an in-flight duplicate. */
export const WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS = 30;

export type WebhookHttpResponse = {
  status: number;
  body: Record<string, unknown>;
  /** Extra response headers (e.g. Retry-After). Never contains internal detail. */
  headers?: Record<string, string>;
};

export function mapWebhookResultToHttp(result: ProcessWebhookResult): WebhookHttpResponse {
  switch (result.outcome) {
    case "processed":
      return {
        status: 200,
        body: { received: true, outcome: "processed", action: result.action },
      };
    case "ignored":
      return {
        status: 200,
        body: { received: true, outcome: "ignored", action: result.action },
      };
    case "already_processed":
      return {
        status: 200,
        body: { received: true, outcome: "already_processed", duplicate: true },
      };
    case "in_flight":
      return {
        status: WEBHOOK_IN_FLIGHT_HTTP_STATUS,
        body: { received: false, outcome: "in_flight", error: "EVENT_IN_FLIGHT" },
        headers: { "Retry-After": String(WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS) },
      };
    case "permanent_failure":
      return {
        status: 200,
        body: {
          received: true,
          outcome: "permanent_failure",
          error: result.code,
          deadLettered: result.deadLettered,
        },
      };
    case "retryable_failure":
      return {
        status: 500,
        body: { received: false, outcome: "retryable_failure", error: result.code },
      };
  }
}
