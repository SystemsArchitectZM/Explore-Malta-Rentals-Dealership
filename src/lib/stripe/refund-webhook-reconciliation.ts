/**
 * Purpose-aware reconciliation for Stripe refund webhook payloads.
 * Injectable deps keep unit tests free of Prisma/Stripe network I/O.
 */

import {
  detectHistoricalRefundAmbiguity,
  sumSucceededRefundCounters,
  type LinkedRefundRequest,
  type PaymentRefundCounters,
  type RefundPurposeAdmin,
} from "./refund-accounting";
import { logRefundOpsEvent } from "./refund-ops-log";

export type RefundWebhookMirrorInput = {
  stripeRefundId: string;
  amountCents: number;
  status: string;
  reason: "DUPLICATE" | "FRAUDULENT" | "REQUESTED_BY_CUSTOMER";
  paymentIntentId: string | null;
  metadata: Record<string, string | undefined>;
};

export type RefundWebhookPaymentRow = PaymentRefundCounters & {
  id: string;
  bookingId: string;
  stripePaymentIntentId: string | null;
};

export type RefundWebhookRequestRow = {
  id: string;
  clientRequestId: string;
  purpose: RefundPurposeAdmin | "UNSPECIFIED";
  amountCents: number;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stripeRefundId: string | null;
};

export type RefundWebhookDeps = {
  findPaymentByPaymentIntentId: (
    paymentIntentId: string,
  ) => Promise<RefundWebhookPaymentRow | null>;
  withPaymentLock: <T>(
    stripePaymentId: string,
    fn: (ctx: {
      payment: RefundWebhookPaymentRow;
      requests: RefundWebhookRequestRow[];
      stripeRefunds: Array<{ stripeRefundId: string; amountCents: number }>;
      upsertMirror: (input: {
        stripeRefundId: string;
        amountCents: number;
        status: string;
        reason: RefundWebhookMirrorInput["reason"];
      }) => Promise<void>;
      updateRequest: (
        id: string,
        data: Partial<Pick<RefundWebhookRequestRow, "status" | "stripeRefundId">>,
      ) => Promise<void>;
      setCountersAbsolute: (input: {
        rentalRefundedCents: number;
        depositRefundedCents: number;
        refundedAmountCents: number;
      }) => Promise<void>;
    }) => Promise<T>,
  ) => Promise<T>;
  writeAuditLog: (args: {
    bookingId: string;
    stripePaymentId: string;
    action: "refund_succeeded" | "refund_failed" | "refund_reconciled";
    newValue: Record<string, unknown>;
  }) => Promise<void>;
};

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "").toLowerCase();
}

function isTerminalFailed(status: string): boolean {
  return status === "failed" || status === "canceled" || status === "cancelled";
}

function isSucceeded(status: string): boolean {
  return status === "succeeded";
}

function purposeFromMetadata(
  metadata: Record<string, string | undefined>,
): RefundPurposeAdmin | null {
  const purpose = metadata.purpose;
  if (purpose === "RENTAL" || purpose === "SECURITY_DEPOSIT") return purpose;
  return null;
}

/**
 * Upsert StripeRefund mirror and reconcile linked StripeRefundRequest when possible.
 * Never invents purpose for unmatched historical refunds.
 * FAILED/CANCELLED are terminal for ordinary webhook success promotion.
 */
export async function reconcileRefundWebhookEvent(
  input: RefundWebhookMirrorInput,
  deps: RefundWebhookDeps,
): Promise<string> {
  if (!input.paymentIntentId) {
    return "no_payment_intent";
  }

  const payment = await deps.findPaymentByPaymentIntentId(input.paymentIntentId);
  if (!payment) {
    return "no_payment_record";
  }

  const stripeStatus = normalizeStatus(input.status);
  const metaClientRequestId = input.metadata.clientRequestId?.trim() || null;
  const metaPurpose = purposeFromMetadata(input.metadata);

  return deps.withPaymentLock(payment.id, async (ctx) => {
    await ctx.upsertMirror({
      stripeRefundId: input.stripeRefundId,
      amountCents: input.amountCents,
      status: input.status || "pending",
      reason: input.reason,
    });

    const byStripeId = ctx.requests.find((r) => r.stripeRefundId === input.stripeRefundId);
    const byClientId = metaClientRequestId
      ? ctx.requests.find((r) => r.clientRequestId === metaClientRequestId)
      : undefined;

    if (byStripeId && byClientId && byStripeId.id !== byClientId.id) {
      await deps.writeAuditLog({
        bookingId: payment.bookingId,
        stripePaymentId: payment.id,
        action: "refund_reconciled",
        newValue: {
          stripeRefundId: input.stripeRefundId,
          note: "conflicting_request_links",
          byStripeId: byStripeId.id,
          byClientId: byClientId.id,
        },
      });
      return "refund_link_conflict";
    }

    const request = byStripeId ?? byClientId;

    if (!request) {
      const ambiguity = detectHistoricalRefundAmbiguity({
        payment: ctx.payment,
        stripeRefunds: [
          ...ctx.stripeRefunds.filter((r) => r.stripeRefundId !== input.stripeRefundId),
          { stripeRefundId: input.stripeRefundId, amountCents: input.amountCents },
        ],
        requests: ctx.requests as LinkedRefundRequest[],
      });
      await deps.writeAuditLog({
        bookingId: payment.bookingId,
        stripePaymentId: payment.id,
        action: "refund_reconciled",
        newValue: {
          stripeRefundId: input.stripeRefundId,
          note: "unmatched_historical_or_external_refund",
          ambiguous: ambiguity.ambiguous,
          reasons: ambiguity.reasons,
        },
      });
      return "refund_recorded_unmatched";
    }

    if (
      metaPurpose &&
      request.purpose !== "UNSPECIFIED" &&
      request.purpose !== metaPurpose
    ) {
      await deps.writeAuditLog({
        bookingId: payment.bookingId,
        stripePaymentId: payment.id,
        action: "refund_reconciled",
        newValue: {
          stripeRefundId: input.stripeRefundId,
          requestId: request.id,
          note: "purpose_metadata_mismatch",
        },
      });
      return "refund_purpose_mismatch";
    }

    // SUCCEEDED is terminal and idempotent.
    if (request.status === "SUCCEEDED") {
      if (isTerminalFailed(stripeStatus)) {
        await deps.writeAuditLog({
          bookingId: payment.bookingId,
          stripePaymentId: payment.id,
          action: "refund_reconciled",
          newValue: {
            stripeRefundId: input.stripeRefundId,
            requestId: request.id,
            note: "ignored_failed_after_succeeded",
            stripeStatus: input.status,
          },
        });
        return "refund_succeeded_ignores_later_failure";
      }
      const sums = sumSucceededRefundCounters(ctx.requests);
      await ctx.setCountersAbsolute({
        rentalRefundedCents: sums.rentalRefundedCents,
        depositRefundedCents: sums.depositRefundedCents,
        refundedAmountCents: sums.refundedAmountCents,
      });
      return "refund_already_succeeded";
    }

    // M3: FAILED/CANCELLED must not be silently promoted by ordinary webhook success.
    if (request.status === "FAILED" || request.status === "CANCELLED") {
      if (!request.stripeRefundId) {
        await ctx.updateRequest(request.id, { stripeRefundId: input.stripeRefundId });
      }
      if (isSucceeded(stripeStatus)) {
        logRefundOpsEvent("refund.webhook_terminal_conflict", {
          bookingId: payment.bookingId,
          stripePaymentId: payment.id,
          requestId: request.id,
          stripeRefundId: input.stripeRefundId,
          priorStatus: request.status,
          stripeStatus: input.status,
        });
        await deps.writeAuditLog({
          bookingId: payment.bookingId,
          stripePaymentId: payment.id,
          action: "refund_reconciled",
          newValue: {
            stripeRefundId: input.stripeRefundId,
            requestId: request.id,
            priorStatus: request.status,
            note: "terminal_state_conflict_succeeded_evidence",
            opsEvent: "refund.webhook_terminal_conflict",
            requiresExplicitRecovery: true,
          },
        });
        // Mirror retained; FAILED request does not count as linked → ambiguity blocks new purpose refunds.
        return "refund_terminal_conflict";
      }
      return "refund_already_terminal";
    }

    if (isTerminalFailed(stripeStatus)) {
      await ctx.updateRequest(request.id, {
        status: "FAILED",
        stripeRefundId: input.stripeRefundId,
      });
      await deps.writeAuditLog({
        bookingId: payment.bookingId,
        stripePaymentId: payment.id,
        action: "refund_failed",
        newValue: {
          stripeRefundId: input.stripeRefundId,
          requestId: request.id,
          status: input.status,
        },
      });
      return "refund_marked_failed";
    }

    if (isSucceeded(stripeStatus)) {
      await ctx.updateRequest(request.id, {
        status: "SUCCEEDED",
        stripeRefundId: input.stripeRefundId,
      });

      const nextRequests = ctx.requests.map((r) =>
        r.id === request.id
          ? { ...r, status: "SUCCEEDED" as const, stripeRefundId: input.stripeRefundId }
          : r,
      );
      const sums = sumSucceededRefundCounters(nextRequests);
      await ctx.setCountersAbsolute({
        rentalRefundedCents: sums.rentalRefundedCents,
        depositRefundedCents: sums.depositRefundedCents,
        refundedAmountCents: sums.refundedAmountCents,
      });

      await deps.writeAuditLog({
        bookingId: payment.bookingId,
        stripePaymentId: payment.id,
        action: "refund_succeeded",
        newValue: {
          stripeRefundId: input.stripeRefundId,
          requestId: request.id,
          purpose: request.purpose,
          amountCents: request.amountCents,
          source: "webhook",
        },
      });
      return "refund_marked_succeeded";
    }

    if (!request.stripeRefundId) {
      await ctx.updateRequest(request.id, { stripeRefundId: input.stripeRefundId });
    }
    return "refund_recorded_pending";
  });
}

/**
 * charge.refunded carries aggregate charge totals only.
 * Never invents purpose allocations. Prefer purpose-succeeded absolute combined
 * when request accounting is present; flag conflicts instead of inflating.
 *
 * Booking paymentStatus is set to REFUNDED only when purpose-succeeded accounting
 * covers the full payment and no unmatched/conflict remains. Stripe's aggregate
 * `charge.refunded` flag alone must never mark a booking fully refunded.
 */
export function decideChargeRefundedEffect(input: {
  chargeRefundedAmountCents: number;
  chargeFullyRefunded: boolean;
  payment: PaymentRefundCounters;
  /** Absolute sum from SUCCEEDED purpose requests (post-lock). */
  succeededPurposeSumCents: number;
  unmatchedStripeRefundIds: string[];
}): {
  combinedRefundedAmountCents: number;
  /** When false, leave refundedAmountCents unchanged. */
  shouldWriteCombinedCounter: boolean;
  stripeStatus: "REFUNDED" | "PARTIALLY_REFUNDED";
  refundStatus: "FULL" | "PARTIAL" | "NONE";
  /** null = leave booking.paymentStatus unchanged */
  bookingPaymentStatus: "REFUNDED" | null;
  needsReconciliation: boolean;
  note: string;
} {
  const purposeSum = input.succeededPurposeSumCents;
  const hasUnmatched = input.unmatchedStripeRefundIds.length > 0;
  const chargeSaysMore = input.chargeRefundedAmountCents > purposeSum;
  const accountingFull =
    purposeSum > 0 && purposeSum >= input.payment.amountCents && !hasUnmatched && !chargeSaysMore;

  if (hasUnmatched) {
    return {
      // Do not invent purpose or inflate combined from aggregate alone.
      combinedRefundedAmountCents: Math.max(purposeSum, input.payment.refundedAmountCents),
      shouldWriteCombinedCounter: true,
      stripeStatus: accountingFull ? "REFUNDED" : "PARTIALLY_REFUNDED",
      refundStatus: accountingFull ? "FULL" : purposeSum > 0 || input.chargeRefundedAmountCents > 0 ? "PARTIAL" : "NONE",
      bookingPaymentStatus: null,
      needsReconciliation: true,
      note: "charge_refunded_unmatched_refunds_no_purpose_allocation",
    };
  }

  if (purposeSum > 0) {
    const purposeFull = purposeSum >= input.payment.amountCents;
    return {
      combinedRefundedAmountCents: purposeSum,
      shouldWriteCombinedCounter: true,
      stripeStatus: purposeFull && !chargeSaysMore ? "REFUNDED" : "PARTIALLY_REFUNDED",
      refundStatus: purposeFull && !chargeSaysMore ? "FULL" : "PARTIAL",
      // Stripe aggregate full-refund flag is insufficient without purpose coverage.
      bookingPaymentStatus: purposeFull && !chargeSaysMore ? "REFUNDED" : null,
      needsReconciliation: chargeSaysMore || (input.chargeFullyRefunded && !purposeFull),
      note: chargeSaysMore
        ? "charge_aggregate_exceeds_purpose_succeeded_sum"
        : purposeFull
          ? "charge_refunded_aligned_to_purpose_succeeded_sum"
          : "charge_refunded_purpose_partial_booking_unchanged",
    };
  }

  // No purpose-succeeded accounting yet: mirror aggregate without purpose split (fail-closed).
  // Never mark booking REFUNDED from the aggregate flag alone.
  return {
    combinedRefundedAmountCents: input.chargeRefundedAmountCents,
    shouldWriteCombinedCounter: true,
    stripeStatus: "PARTIALLY_REFUNDED",
    refundStatus: input.chargeRefundedAmountCents > 0 ? "PARTIAL" : "NONE",
    bookingPaymentStatus: null,
    needsReconciliation: input.chargeRefundedAmountCents > 0,
    note: "aggregate_charge_refund_no_purpose_allocation",
  };
}
