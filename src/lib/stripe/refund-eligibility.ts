/**
 * Pure eligibility rules for purpose-aware Stripe refunds.
 */

import type { RefundPurposeAdmin } from "./refund-accounting";
import { isRefundEligibleStripePaymentStatus } from "./payment-status-rules";

export type DepositRefundBookingEvidence = {
  status: string;
  depositMethod: string;
  pickupDateTime: Date | string;
  /** Earliest BookingStatusHistory.createdAt where newStatus = CANCELLED, if any. */
  cancelledAt: Date | string | null;
  /** Prior status immediately before CANCELLED, if known from history. */
  statusBeforeCancel: string | null;
};

export type RefundEligibilityResult = { ok: true } | { ok: false; error: string };

function asDate(value: Date | string): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Stripe path requires ONLINE combined checkout.
 * IN_PERSON / offline / ALREADY_PAID deposits are not refunded here.
 *
 * Status allowlist is `isRefundEligibleStripePaymentStatus`
 * (SUCCEEDED | PARTIALLY_REFUNDED). Other StripePaymentStatus values,
 * including REFUNDED / DISPUTED / unpaid / unknown, fail closed.
 */
export function evaluateStripeRefundChannelEligibility(input: {
  stripeStatus: string;
  stripePaymentIntentId: string | null | undefined;
  depositMethod: string;
  paymentProofUploadPath?: string | null;
  totalDueOnline?: number | null;
}): RefundEligibilityResult {
  if (!isRefundEligibleStripePaymentStatus(input.stripeStatus)) {
    return { ok: false, error: `Cannot refund a payment with status: ${input.stripeStatus}` };
  }
  if (!input.stripePaymentIntentId) {
    return { ok: false, error: "Payment intent ID not found — cannot process Stripe refund" };
  }
  if (input.paymentProofUploadPath) {
    return { ok: false, error: "ALREADY_PAID / offline proof payments cannot use Stripe refunds" };
  }
  if (input.totalDueOnline != null && input.totalDueOnline <= 0) {
    return { ok: false, error: "No online Stripe amount is due for this booking" };
  }
  if (input.depositMethod !== "ONLINE") {
    return {
      ok: false,
      error: "Stripe refunds require ONLINE combined checkout payments",
    };
  }
  return { ok: true };
}

/**
 * RENTAL purpose: channel-eligible Stripe payment only (purpose caps applied separately).
 * SECURITY_DEPOSIT: COMPLETED by default, or confirmed→cancelled before pickup (explicit admin).
 */
export function evaluatePurposeRefundEligibility(input: {
  purpose: RefundPurposeAdmin;
  booking: DepositRefundBookingEvidence;
}): RefundEligibilityResult {
  if (input.purpose === "RENTAL") {
    return { ok: true };
  }

  // SECURITY_DEPOSIT
  if (input.booking.depositMethod !== "ONLINE") {
    return {
      ok: false,
      error: "Security deposit Stripe refunds require an ONLINE deposit allocation",
    };
  }

  if (input.booking.status === "COMPLETED") {
    return { ok: true };
  }

  // Approved pre-pickup exception: CANCELLED after CONFIRMED, before pickup.
  if (input.booking.status !== "CANCELLED") {
    return {
      ok: false,
      error: "Security deposit refunds require COMPLETED status (or confirmed pre-pickup cancellation)",
    };
  }

  if (input.booking.statusBeforeCancel !== "CONFIRMED") {
    return {
      ok: false,
      error: "Pre-pickup deposit refund requires cancellation from CONFIRMED status",
    };
  }

  if (!input.booking.cancelledAt) {
    return {
      ok: false,
      error: "Cannot prove cancellation time for pre-pickup deposit refund",
    };
  }

  const cancelledAt = asDate(input.booking.cancelledAt);
  const pickupAt = asDate(input.booking.pickupDateTime);
  if (!cancelledAt || !pickupAt) {
    return {
      ok: false,
      error: "Ambiguous cancellation or pickup timestamps for deposit refund",
    };
  }

  if (cancelledAt.getTime() >= pickupAt.getTime()) {
    return {
      ok: false,
      error: "Deposit refund exception requires cancellation before pickup",
    };
  }

  return { ok: true };
}
