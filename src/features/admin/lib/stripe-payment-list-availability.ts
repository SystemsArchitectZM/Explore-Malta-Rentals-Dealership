/**
 * Pure helpers for admin payment-list refund capacity display.
 * Mirrors createRefund accounting (authoritative request sums + pending).
 */

import {
  computeAuthoritativeRefundAvailability,
  detectHistoricalRefundAmbiguity,
  type LinkedRefundRequest,
  type PaymentRefundCounters,
} from "@/lib/stripe/refund-accounting";

export type AdminPaymentListRefundMetrics = {
  needsReconciliation: boolean;
  reconciliationReasons: string[];
  unmatchedRefundIds: string[];
  rentalAvailableCents: number;
  depositAvailableCents: number;
  combinedAvailableCents: number;
  /** False when allocation integrity / accounting threw — fail closed to zero capacity. */
  availabilityReliable: boolean;
};

const ZERO: Omit<
  AdminPaymentListRefundMetrics,
  "needsReconciliation" | "reconciliationReasons" | "unmatchedRefundIds"
> = {
  rentalAvailableCents: 0,
  depositAvailableCents: 0,
  combinedAvailableCents: 0,
  availabilityReliable: false,
};

/**
 * Compute reconciliation flags and purpose availability for one payment row.
 * Uses batched request + mirror inputs — callers must not N+1.
 */
export function buildAdminPaymentListRefundMetrics(input: {
  payment: PaymentRefundCounters;
  requests: LinkedRefundRequest[];
  stripeRefunds: Array<{ stripeRefundId: string; amountCents: number }>;
}): AdminPaymentListRefundMetrics {
  try {
    const ambiguity = detectHistoricalRefundAmbiguity({
      payment: input.payment,
      stripeRefunds: input.stripeRefunds,
      requests: input.requests,
    });

    const availability = computeAuthoritativeRefundAvailability({
      payment: {
        amountCents: input.payment.amountCents,
        rentalAmountCents: input.payment.rentalAmountCents,
        depositAmountCents: input.payment.depositAmountCents,
      },
      requests: input.requests.map((r, index) => ({
        id: r.stripeRefundId ?? `req_${index}`,
        purpose: r.purpose,
        status: r.status,
        amountCents: r.amountCents,
      })),
    });

    return {
      needsReconciliation: ambiguity.ambiguous,
      reconciliationReasons: ambiguity.reasons,
      unmatchedRefundIds: ambiguity.reasons
        .filter((r) => r.startsWith("unmatched_stripe_refund:"))
        .map((r) => r.slice("unmatched_stripe_refund:".length)),
      rentalAvailableCents: availability.rentalAvailableCents,
      depositAvailableCents: availability.depositAvailableCents,
      combinedAvailableCents: availability.combinedAvailableCents,
      availabilityReliable: true,
    };
  } catch {
    return {
      ...ZERO,
      needsReconciliation: true,
      reconciliationReasons: ["accounting_unavailable"],
      unmatchedRefundIds: [],
    };
  }
}
