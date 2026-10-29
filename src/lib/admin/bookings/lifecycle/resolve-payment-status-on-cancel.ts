import type { PaymentStatus } from "@/generated/prisma/index";

/**
 * Cancellation never proves a Stripe rental refund occurred.
 * Preserve the existing payment status (including already-REFUNDED).
 * The legacy `refundPayment` request flag is ignored for status updates.
 */
export function resolvePaymentStatusOnCancel(
  currentPaymentStatus: PaymentStatus,
  _refundPaymentFlag?: boolean,
): PaymentStatus {
  return currentPaymentStatus;
}
