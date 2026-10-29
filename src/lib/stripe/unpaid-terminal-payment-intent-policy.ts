/**
 * Pure association + outcome rules for payment_intent.payment_failed / canceled.
 * Distinguishes missing/unlinked rows (retry) from protected or stale attempts (ack).
 */

import {
  isPaidLineageStripePaymentStatus,
  isUnpaidStripePaymentStatus,
} from "./payment-status-rules";

export type UnpaidTerminalPaymentIntentSnapshot = {
  stripePaymentIntentId: string | null;
  stripeStatus: string;
};

export type UnpaidTerminalPaymentIntentDecision =
  | { kind: "apply" }
  | {
      kind: "ignore";
      reason: "protected_status" | "stale_attempt" | "already_same_terminal";
    }
  | {
      kind: "retry";
      reason: "payment_not_found" | "payment_intent_not_linked";
    };

/**
 * Decide how a PI failed/canceled event should proceed after reading the payment row.
 *
 * - Missing row → retry (local upsert may still be in flight).
 * - Stored PI null while unpaid → retry until createCheckoutSession persists the intent
 *   (avoids applying a stale PI after a concurrent replacement that has not linked yet).
 *   Legacy rows that never store a PI will eventually dead-letter; sweeper remains backstop.
 * - Stored PI ≠ event → ignore stale (do not fail/cancel a newer attempt).
 * - Paid lineage → ignore (no overwrite / no release).
 */
export function decideUnpaidTerminalPaymentIntentEffect(input: {
  eventPaymentIntentId: string;
  payment: UnpaidTerminalPaymentIntentSnapshot | null;
  /** Target unpaid terminal status for this event. */
  nextStatus: "FAILED" | "CANCELLED";
}): UnpaidTerminalPaymentIntentDecision {
  const eventPi = input.eventPaymentIntentId.trim();
  if (!eventPi) {
    return { kind: "retry", reason: "payment_intent_not_linked" };
  }

  if (!input.payment) {
    return { kind: "retry", reason: "payment_not_found" };
  }

  if (isPaidLineageStripePaymentStatus(input.payment.stripeStatus)) {
    return { kind: "ignore", reason: "protected_status" };
  }

  const storedPi = input.payment.stripePaymentIntentId?.trim() || null;

  if (storedPi && storedPi !== eventPi) {
    return { kind: "ignore", reason: "stale_attempt" };
  }

  if (!storedPi) {
    // Unpaid but PI not persisted yet — wait for local link rather than bookingId-only write.
    if (isUnpaidStripePaymentStatus(input.payment.stripeStatus)) {
      return { kind: "retry", reason: "payment_intent_not_linked" };
    }
    // Unknown status: fail closed as retry so ops can inspect rather than ack.
    return { kind: "retry", reason: "payment_intent_not_linked" };
  }

  // Matching PI, unpaid (or already same terminal unpaid status).
  if (input.payment.stripeStatus === input.nextStatus) {
    return { kind: "ignore", reason: "already_same_terminal" };
  }

  if (isUnpaidStripePaymentStatus(input.payment.stripeStatus)) {
    return { kind: "apply" };
  }

  return { kind: "ignore", reason: "protected_status" };
}

export function unpaidTerminalPaymentIntentRetryErrorMessage(
  decision: Extract<UnpaidTerminalPaymentIntentDecision, { kind: "retry" }>,
): string {
  if (decision.reason === "payment_not_found") {
    return "UNPAID_TERMINAL_PAYMENT_NOT_FOUND: no StripePayment for booking; retry until checkout persists the row";
  }
  return "UNPAID_TERMINAL_PAYMENT_INTENT_NOT_LINKED: StripePayment has no matching payment_intent yet; retry until linked";
}
