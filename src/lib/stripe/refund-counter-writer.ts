/**
 * Status-preserving StripePayment refund-counter writes.
 *
 * Counters / refundStatus always update when called with valid amounts.
 * stripeStatus updates only via an atomic allowlist so DISPUTED and unpaid
 * rows cannot be overwritten, and REFUNDED cannot regress to PARTIALLY_REFUNDED.
 *
 * No Prisma client import — callers pass an open transaction client.
 */

import {
  REFUND_PRESERVABLE_STRIPE_PAYMENT_STATUSES,
  deriveRefundStripeStatus,
  type DerivedRefundStripeStatus,
  type RefundPreservableStripePaymentStatus,
} from "./payment-status-rules";

export type RefundCounterRefundStatus = "FULL" | "PARTIAL" | "NONE";

export type AbsoluteRefundCounterWriteInput = {
  stripePaymentId: string;
  bookingId: string;
  /** Payment total (locked snapshot). Used only for derivation / full check. */
  amountCents: number;
  rentalRefundedCents: number;
  depositRefundedCents: number;
  refundedAmountCents: number;
  /**
   * When true (default), set Booking.paymentStatus = REFUNDED if the absolute
   * combined counter covers the payment amount.
   */
  updateBookingIfFullyRefunded?: boolean;
};

export type AbsoluteRefundCounterWritePlan = {
  refundStatus: RefundCounterRefundStatus;
  desiredStripeStatus: DerivedRefundStripeStatus | null;
  /**
   * Statuses that may receive `desiredStripeStatus` via updateMany.
   * Empty when no status write should be attempted (zero refunded).
   */
  stripeStatusUpdateAllowlist: readonly RefundPreservableStripePaymentStatus[];
  isFullyRefunded: boolean;
};

export type AbsoluteRefundCounterWriteResult = AbsoluteRefundCounterWritePlan & {
  /** Rows matched by the conditional stripeStatus updateMany (0 or 1). */
  stripeStatusWriteCount: number;
  bookingUpdated: boolean;
};

/**
 * Minimal transaction surface used by the writer. Matches Prisma interactive
 * transaction clients without importing the generated client here.
 */
export type RefundCounterWriterTx = {
  stripePayment: {
    update: (args: {
      where: { id: string };
      data: {
        rentalRefundedCents?: number;
        depositRefundedCents?: number;
        refundedAmountCents?: number;
        refundStatus: RefundCounterRefundStatus;
        updatedAt: Date;
      };
    }) => Promise<unknown>;
    updateMany: (args: {
      where: {
        id: string;
        stripeStatus: { in: RefundPreservableStripePaymentStatus[] };
      };
      data: {
        stripeStatus: DerivedRefundStripeStatus;
        updatedAt: Date;
      };
    }) => Promise<{ count: number }>;
  };
  booking: {
    update: (args: {
      where: { id: string };
      data: { paymentStatus: "REFUNDED" };
    }) => Promise<unknown>;
  };
};

export type ChargeRefundedAggregateWriteInput = {
  stripePaymentId: string;
  bookingId: string;
  amountCents: number;
  /** Locked StripePayment.refundedAmountCents — never assume zero if missing. */
  storedRefundedAmountCents: number;
  decidedCombinedRefundedAmountCents: number;
  shouldWriteCombinedCounter: boolean;
  /** Preserve decideChargeRefundedEffect booking semantics. */
  bookingPaymentStatus: "REFUNDED" | null;
};

export type ChargeRefundedAggregateWriteResult = {
  refundedAmountCentsWritten: number | null;
  refundStatus: RefundCounterRefundStatus;
  desiredStripeStatus: DerivedRefundStripeStatus | null;
  stripeStatusWriteCount: number;
  bookingUpdated: boolean;
};

/**
 * Non-decreasing combined counter for late / replayed charge.refunded aggregates.
 */
export function nonDecreasingRefundedAmountCents(
  storedRefundedAmountCents: number,
  incomingRefundedAmountCents: number,
): number {
  if (
    typeof storedRefundedAmountCents !== "number" ||
    !Number.isFinite(storedRefundedAmountCents) ||
    !Number.isInteger(storedRefundedAmountCents) ||
    !Number.isSafeInteger(storedRefundedAmountCents) ||
    storedRefundedAmountCents < 0
  ) {
    throw new Error("storedRefundedAmountCents must be a non-negative safe integer");
  }
  if (
    typeof incomingRefundedAmountCents !== "number" ||
    !Number.isFinite(incomingRefundedAmountCents) ||
    !Number.isInteger(incomingRefundedAmountCents) ||
    !Number.isSafeInteger(incomingRefundedAmountCents) ||
    incomingRefundedAmountCents < 0
  ) {
    throw new Error("incomingRefundedAmountCents must be a non-negative safe integer");
  }
  return Math.max(storedRefundedAmountCents, incomingRefundedAmountCents);
}

/**
 * Pure plan for absolute counter writes. Throws on invalid amounts (same
 * validation as `deriveRefundStripeStatus`).
 *
 * Zero refunded → refundStatus NONE, no stripeStatus write.
 * Partial → PARTIALLY_REFUNDED allowlist excludes REFUNDED (no regression).
 * Full / overage → REFUNDED allowlist is the full preservable set.
 */
export function planAbsoluteRefundCounterWrite(input: {
  amountCents: number;
  rentalRefundedCents: number;
  depositRefundedCents: number;
  refundedAmountCents: number;
}): AbsoluteRefundCounterWritePlan {
  // Validate purpose counters with the same safe-integer rules as derivation.
  for (const [label, value] of [
    ["rentalRefundedCents", input.rentalRefundedCents],
    ["depositRefundedCents", input.depositRefundedCents],
  ] as const) {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      !Number.isSafeInteger(value) ||
      value < 0
    ) {
      throw new Error(`${label} must be a non-negative safe integer number of cents`);
    }
  }

  const derived = deriveRefundStripeStatus({
    amountCents: input.amountCents,
    refundedAmountCents: input.refundedAmountCents,
  });

  if (!derived.ok) {
    return {
      refundStatus: "NONE",
      desiredStripeStatus: null,
      stripeStatusUpdateAllowlist: [],
      isFullyRefunded: false,
    };
  }

  const isFullyRefunded = derived.stripeStatus === "REFUNDED";
  const stripeStatusUpdateAllowlist: readonly RefundPreservableStripePaymentStatus[] =
    derived.stripeStatus === "REFUNDED"
      ? REFUND_PRESERVABLE_STRIPE_PAYMENT_STATUSES
      : (["SUCCEEDED", "PARTIALLY_REFUNDED"] as const);

  return {
    refundStatus: isFullyRefunded ? "FULL" : "PARTIAL",
    desiredStripeStatus: derived.stripeStatus,
    stripeStatusUpdateAllowlist,
    isFullyRefunded,
  };
}

/**
 * Writes absolute purpose + combined counters, then conditionally updates
 * stripeStatus. Counter failure aborts the transaction (caller’s txn).
 * A zero-row status updateMany is success — status was intentionally preserved.
 */
export async function applyAbsoluteRefundCounters(
  tx: RefundCounterWriterTx,
  input: AbsoluteRefundCounterWriteInput,
): Promise<AbsoluteRefundCounterWriteResult> {
  const plan = planAbsoluteRefundCounterWrite({
    amountCents: input.amountCents,
    rentalRefundedCents: input.rentalRefundedCents,
    depositRefundedCents: input.depositRefundedCents,
    refundedAmountCents: input.refundedAmountCents,
  });

  const now = new Date();

  await tx.stripePayment.update({
    where: { id: input.stripePaymentId },
    data: {
      rentalRefundedCents: input.rentalRefundedCents,
      depositRefundedCents: input.depositRefundedCents,
      refundedAmountCents: input.refundedAmountCents,
      refundStatus: plan.refundStatus,
      updatedAt: now,
    },
  });

  let stripeStatusWriteCount = 0;
  if (plan.desiredStripeStatus && plan.stripeStatusUpdateAllowlist.length > 0) {
    const statusResult = await tx.stripePayment.updateMany({
      where: {
        id: input.stripePaymentId,
        stripeStatus: { in: [...plan.stripeStatusUpdateAllowlist] },
      },
      data: {
        stripeStatus: plan.desiredStripeStatus,
        updatedAt: now,
      },
    });
    stripeStatusWriteCount = statusResult.count;
  }

  let bookingUpdated = false;
  const shouldUpdateBooking = input.updateBookingIfFullyRefunded !== false;
  if (shouldUpdateBooking && plan.isFullyRefunded) {
    await tx.booking.update({
      where: { id: input.bookingId },
      data: { paymentStatus: "REFUNDED" },
    });
    bookingUpdated = true;
  }

  return {
    ...plan,
    stripeStatusWriteCount,
    bookingUpdated,
  };
}

/**
 * charge.refunded path: never write purpose counters; never reduce the stored
 * combined counter; never overwrite DISPUTED / unpaid / REFUNDED→partial.
 */
export async function applyChargeRefundedAggregateWrite(
  tx: RefundCounterWriterTx,
  input: ChargeRefundedAggregateWriteInput,
): Promise<ChargeRefundedAggregateWriteResult> {
  const effectiveCombined = input.shouldWriteCombinedCounter
    ? nonDecreasingRefundedAmountCents(
        input.storedRefundedAmountCents,
        input.decidedCombinedRefundedAmountCents,
      )
    : input.storedRefundedAmountCents;

  const plan = planAbsoluteRefundCounterWrite({
    amountCents: input.amountCents,
    // Purpose counters unused on this path; pass zeros for validation only.
    rentalRefundedCents: 0,
    depositRefundedCents: 0,
    refundedAmountCents: effectiveCombined,
  });

  const now = new Date();

  await tx.stripePayment.update({
    where: { id: input.stripePaymentId },
    data: {
      ...(input.shouldWriteCombinedCounter
        ? { refundedAmountCents: effectiveCombined }
        : {}),
      refundStatus: plan.refundStatus,
      updatedAt: now,
    },
  });

  let stripeStatusWriteCount = 0;
  if (plan.desiredStripeStatus && plan.stripeStatusUpdateAllowlist.length > 0) {
    const statusResult = await tx.stripePayment.updateMany({
      where: {
        id: input.stripePaymentId,
        stripeStatus: { in: [...plan.stripeStatusUpdateAllowlist] },
      },
      data: {
        stripeStatus: plan.desiredStripeStatus,
        updatedAt: now,
      },
    });
    stripeStatusWriteCount = statusResult.count;
  }

  let bookingUpdated = false;
  if (input.bookingPaymentStatus === "REFUNDED") {
    await tx.booking.update({
      where: { id: input.bookingId },
      data: { paymentStatus: "REFUNDED" },
    });
    bookingUpdated = true;
  }

  return {
    refundedAmountCentsWritten: input.shouldWriteCombinedCounter ? effectiveCombined : null,
    refundStatus: plan.refundStatus,
    desiredStripeStatus: plan.desiredStripeStatus,
    stripeStatusWriteCount,
    bookingUpdated,
  };
}
