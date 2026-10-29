/**
 * Stable, searchable operational event classifications for refund flows.
 * Ambiguous outcomes must never be labeled as definitive failures.
 */

import type { AuditAction } from "./types";

export type RefundOpsEvent =
  | "refund.stripe_definitive_failure"
  | "refund.stripe_pending"
  | "refund.stripe_ambiguous_outcome"
  | "refund.db_persist_after_stripe_success"
  | "refund.webhook_terminal_conflict";

const SAFE_CONTEXT_KEYS = new Set([
  "bookingId",
  "stripePaymentId",
  "clientRequestId",
  "requestId",
  "stripeRefundId",
  "purpose",
  "amountCents",
  "stripeStatus",
  "priorStatus",
  "note",
]);

export function auditActionForRefundOpsEvent(event: RefundOpsEvent): AuditAction {
  switch (event) {
    case "refund.stripe_definitive_failure":
      return "refund_failed";
    case "refund.stripe_pending":
      return "refund_pending";
    case "refund.stripe_ambiguous_outcome":
      return "refund_ambiguous";
    case "refund.db_persist_after_stripe_success":
      return "refund_persist_incomplete";
    case "refund.webhook_terminal_conflict":
      return "refund_reconciled";
  }
}

export function sanitizeRefundOpsContext(
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

/**
 * Emit a sanitized operational log line. Never logs secrets or raw Stripe payloads.
 */
export function logRefundOpsEvent(
  event: RefundOpsEvent,
  context: Record<string, unknown> = {},
): void {
  console.error(`[refund-ops] event=${event}`, sanitizeRefundOpsContext(context));
}

export function classifyStripeCreateOutcome(input: {
  kind: "throw" | "status";
  status?: string | null;
}): RefundOpsEvent {
  if (input.kind === "throw") {
    return "refund.stripe_ambiguous_outcome";
  }
  const status = (input.status ?? "").toLowerCase();
  if (status === "failed" || status === "canceled" || status === "cancelled") {
    return "refund.stripe_definitive_failure";
  }
  if (status === "succeeded") {
    // Caller should not use this helper for success; pending path is non-succeeded non-failed.
    return "refund.stripe_pending";
  }
  return "refund.stripe_pending";
}
