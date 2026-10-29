/**
 * Pure decision helper for checkout.session.expired webhooks.
 * Status updates must be session-scoped to the payment's stored session id.
 */

import { isPaidLineageStripePaymentStatus } from "./payment-status-rules";

export type CheckoutSessionExpiredIgnoreReason =
  | "already_succeeded"
  | "already_expired"
  | "session_mismatch";

export type CheckoutSessionExpiredRetryReason = "payment_not_found" | "no_stored_session";

export type CheckoutSessionExpiredDecision =
  | { kind: "apply" }
  | { kind: "ignore"; reason: CheckoutSessionExpiredIgnoreReason }
  | { kind: "retry"; reason: CheckoutSessionExpiredRetryReason };

/**
 * Returns whether an expired Checkout Session event should update the payment
 * row and release the unpaid booking, wait for local persistence, or ignore.
 *
 * Paid-lineage statuses (SUCCEEDED, PARTIALLY_REFUNDED, REFUNDED, DISPUTED)
 * use `already_succeeded` for webhook-action compatibility.
 *
 * Missing payment or null stored session are retryable — acknowledging them as
 * success would permanently skip expiry after checkout catches up.
 */
export function decideCheckoutSessionExpiredEffect(input: {
  eventSessionId: string;
  payment: {
    stripeCheckoutSessionId: string | null | undefined;
    stripeStatus: string;
  } | null;
}): CheckoutSessionExpiredDecision {
  if (!input.payment) {
    return { kind: "retry", reason: "payment_not_found" };
  }

  if (isPaidLineageStripePaymentStatus(input.payment.stripeStatus)) {
    return { kind: "ignore", reason: "already_succeeded" };
  }

  const storedSessionId = input.payment.stripeCheckoutSessionId?.trim() || null;
  if (!storedSessionId) {
    return { kind: "retry", reason: "no_stored_session" };
  }

  if (storedSessionId !== input.eventSessionId) {
    return { kind: "ignore", reason: "session_mismatch" };
  }

  if (input.payment.stripeStatus === "EXPIRED") {
    // Duplicate / replay for the same session — do not re-release.
    return { kind: "ignore", reason: "already_expired" };
  }

  return { kind: "apply" };
}

export function checkoutSessionExpiredRetryErrorMessage(
  decision: Extract<CheckoutSessionExpiredDecision, { kind: "retry" }>,
): string {
  if (decision.reason === "payment_not_found") {
    return "CHECKOUT_SESSION_EXPIRED_PAYMENT_NOT_FOUND: no StripePayment yet; retry until checkout persists the row";
  }
  return "CHECKOUT_SESSION_EXPIRED_SESSION_NOT_LINKED: StripePayment has no checkout session id yet; retry until linked";
}
