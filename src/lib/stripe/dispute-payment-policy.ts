/**
 * Pure dispute → payment association and status-transition rules.
 * No Prisma / Stripe I/O — used by webhook handlers and focused unit tests.
 *
 * StripePayment.stripePaymentIntentId is the stable join key (unique).
 * StripeTransaction.stripeTransactionId stores the Checkout Session id, NOT a
 * charge id — never look up disputes by charge against that column.
 */

import {
  type PaidLineageStripePaymentStatus,
  type StripePaymentStatusValue,
  isPaidLineageStripePaymentStatus,
  isUnpaidStripePaymentStatus,
} from "./payment-status-rules";

/**
 * Statuses that may atomically move to (or remain) DISPUTED.
 * Includes DISPUTED for idempotent replays. Excludes unpaid statuses so a
 * premature dispute waits for the success path (retryable throw).
 */
export const DISPUTE_MARKABLE_STRIPE_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "DISPUTED",
] as const satisfies readonly PaidLineageStripePaymentStatus[];

export type DisputeMarkableStripePaymentStatus =
  (typeof DISPUTE_MARKABLE_STRIPE_PAYMENT_STATUSES)[number];

/** Stripe Dispute.status values that are inquiry / early-warning style. */
export const DISPUTE_WARNING_STATUSES = [
  "warning_needs_response",
  "warning_under_review",
  "warning_closed",
] as const;

export type DisputePaymentIntentRef = string | { id?: string | null } | null | undefined;

/**
 * Prefer `dispute.payment_intent` (string or expanded object). Never treat a
 * charge id as a PaymentIntent id.
 */
export function resolveDisputePaymentIntentId(
  paymentIntent: DisputePaymentIntentRef,
): string | null {
  if (typeof paymentIntent === "string") {
    const trimmed = paymentIntent.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (paymentIntent && typeof paymentIntent === "object") {
    const id = paymentIntent.id;
    if (typeof id === "string") {
      const trimmed = id.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }
  return null;
}

export function isDisputeWarningStatus(status: string | null | undefined): boolean {
  return (
    typeof status === "string" &&
    (DISPUTE_WARNING_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Inquiry (`warning_*`) and standard charge disputes both mark DISPUTED on create.
 * Closure never clears status in this phase — callers must not use this for closed.
 */
export function shouldMarkDisputedOnDisputeCreated(
  disputeStatus: string | null | undefined,
): boolean {
  // All created events (including warning_*) participate; unknown status still marks.
  void disputeStatus;
  return true;
}

export function isDisputeMarkableStripePaymentStatus(
  status: string,
): status is DisputeMarkableStripePaymentStatus {
  return (DISPUTE_MARKABLE_STRIPE_PAYMENT_STATUSES as readonly string[]).includes(status);
}

export function disputeMarkableStripeStatusFilter(): {
  in: DisputeMarkableStripePaymentStatus[];
} {
  return { in: [...DISPUTE_MARKABLE_STRIPE_PAYMENT_STATUSES] };
}

export type DisputeCreatedLookupDecision =
  | { kind: "mark_disputed"; paymentIntentId: string }
  | { kind: "retry_unmatched"; reason: "missing_payment_intent" | "payment_not_found" }
  | {
      kind: "retry_premature";
      reason: "payment_not_paid_lineage";
      paymentIntentId: string;
      stripeStatus: string;
    };

/**
 * Decide how charge.dispute.created should proceed after reading the payment row.
 * Callers throw a plain Error for retry_* so the webhook classifier retries.
 */
export function decideDisputeCreatedLookup(input: {
  paymentIntentId: string | null;
  payment: { id: string; bookingId: string; stripeStatus: string } | null;
}): DisputeCreatedLookupDecision {
  if (!input.paymentIntentId) {
    return { kind: "retry_unmatched", reason: "missing_payment_intent" };
  }
  if (!input.payment) {
    return { kind: "retry_unmatched", reason: "payment_not_found" };
  }
  if (!isDisputeMarkableStripePaymentStatus(input.payment.stripeStatus)) {
    return {
      kind: "retry_premature",
      reason: "payment_not_paid_lineage",
      paymentIntentId: input.paymentIntentId,
      stripeStatus: input.payment.stripeStatus,
    };
  }
  return { kind: "mark_disputed", paymentIntentId: input.paymentIntentId };
}

/**
 * Messages thrown for retryable dispute failures. Kept stable for ops log grep.
 */
export function disputeCreatedRetryErrorMessage(
  decision: Extract<
    DisputeCreatedLookupDecision,
    { kind: "retry_unmatched" | "retry_premature" }
  >,
): string {
  if (decision.kind === "retry_unmatched") {
    if (decision.reason === "missing_payment_intent") {
      return "DISPUTE_PAYMENT_INTENT_MISSING: dispute has no payment_intent; retry until payload is usable";
    }
    return "DISPUTE_PAYMENT_NOT_FOUND: no StripePayment for dispute payment_intent; retry until checkout persists the intent";
  }
  return `DISPUTE_PAYMENT_NOT_READY: payment stripeStatus=${decision.stripeStatus} is not dispute-markable; retry until paid lineage`;
}

/** Sanity: unpaid and dispute-markable sets must not overlap; paid lineage is markable. */
export function assertDisputeStatusSetsPartitionKnownStatuses(
  statuses: readonly StripePaymentStatusValue[],
): void {
  for (const status of statuses) {
    const markable = isDisputeMarkableStripePaymentStatus(status);
    const unpaid = isUnpaidStripePaymentStatus(status);
    if (markable && unpaid) {
      throw new Error(`${status} cannot be both dispute-markable and unpaid`);
    }
    if (isPaidLineageStripePaymentStatus(status) && !markable) {
      throw new Error(`${status} is paid lineage but not dispute-markable`);
    }
  }
}
