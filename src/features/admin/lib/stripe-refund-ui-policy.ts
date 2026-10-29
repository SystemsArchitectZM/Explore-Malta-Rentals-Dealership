/**
 * Pure admin Stripe refund UI policy — mirrors backend allowlists without
 * duplicating purpose-cap math. Backend remains authoritative.
 */

import { isRefundEligibleStripePaymentStatus } from "@/lib/stripe/payment-status-rules";

export type StripeRefundUiViewerRole = "ADMIN" | "STAFF" | string;

export function canMutateStripeRefunds(viewerRole: StripeRefundUiViewerRole): boolean {
  return viewerRole === "ADMIN";
}

/**
 * Whether the list/action column may offer a *new* refund dialog.
 * Does not model idempotent replay of an existing clientRequestId.
 */
export function canOfferNewRefundAction(input: {
  viewerRole: StripeRefundUiViewerRole;
  needsReconciliation: boolean;
  stripeStatus: string;
  rentalAvailableEur: number;
  depositAvailableEur: number;
  availabilityReliable?: boolean;
}): boolean {
  if (!canMutateStripeRefunds(input.viewerRole)) return false;
  if (input.needsReconciliation) return false;
  if (input.availabilityReliable === false) return false;
  if (!isRefundEligibleStripePaymentStatus(input.stripeStatus)) return false;
  return input.rentalAvailableEur > 0 || input.depositAvailableEur > 0;
}

export function canOfferReconcileAction(input: {
  viewerRole: StripeRefundUiViewerRole;
  needsReconciliation: boolean;
}): boolean {
  return canMutateStripeRefunds(input.viewerRole) && input.needsReconciliation;
}

/**
 * UI gate for SECURITY_DEPOSIT purpose. Stricter than the server (pre-pickup
 * ADMIN exception remains API-only).
 */
export function canSubmitDepositPurposeInUi(bookingStatus: string): boolean {
  return bookingStatus === "COMPLETED";
}

export function canSubmitRefundDialog(input: {
  viewerRole: StripeRefundUiViewerRole;
  needsReconciliation: boolean;
  purpose: "RENTAL" | "SECURITY_DEPOSIT";
  bookingStatus: string;
  busy: boolean;
}): boolean {
  if (input.busy) return false;
  if (!canMutateStripeRefunds(input.viewerRole)) return false;
  if (input.needsReconciliation) return false;
  if (input.purpose === "SECURITY_DEPOSIT" && !canSubmitDepositPurposeInUi(input.bookingStatus)) {
    return false;
  }
  return true;
}

/** Map backend error codes to Admin.stripePayments.errors.* message keys. */
export function refundErrorMessageKey(
  code: string | null | undefined,
): "ineligible" | "no_capacity" | "needs_reconciliation" | "request_conflict" | null {
  switch (code) {
    case "ineligible":
      return "ineligible";
    case "no_capacity":
      return "no_capacity";
    case "needs_reconciliation":
      return "needs_reconciliation";
    case "request_conflict":
      return "request_conflict";
    default:
      return null;
  }
}

export function isConfirmedRefundSuccessStatus(status: string | null | undefined): boolean {
  return status === "succeeded";
}
