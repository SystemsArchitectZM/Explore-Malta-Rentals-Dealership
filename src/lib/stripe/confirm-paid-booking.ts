import type { Prisma } from "@/generated/prisma/index";
import { notifyPaymentReceived } from "@/lib/admin/notifications";
import { prisma } from "@/lib/prisma";
import { deliverBookingConfirmationIfNeeded } from "@/lib/email/deliverBookingConfirmation";
import type { SendBookingConfirmationResult } from "@/lib/email/types";
import {
  UNPAID_STRIPE_PAYMENT_STATUSES,
  isConfirmationEligibleStripePaymentStatus,
  isPaidLineageStripePaymentStatus,
  type UnpaidStripePaymentStatus,
} from "./payment-status-rules";
import {
  validateCheckoutSessionForConfirmation,
  validatePaymentIntentForConfirmation,
  type StoredPaymentIntegrityFields,
} from "./payment-confirmation-integrity";

type BookingDb = Pick<Prisma.TransactionClient, "booking" | "bookingStatusHistory">;

type StripePaymentIntegrityRow = StoredPaymentIntegrityFields & {
  stripeStatus: string;
};

type StripePaymentDb = {
  stripePayment: {
    updateMany: (args: {
      where: {
        bookingId: string;
        stripeStatus: { in: UnpaidStripePaymentStatus[] };
      };
      data: {
        stripeStatus: "SUCCEEDED";
        updatedAt: Date;
        stripePaymentIntentId?: string;
        stripeCheckoutSessionId?: string;
      };
    }) => Promise<{ count: number }>;
    findUnique: (args: {
      where: { bookingId: string };
      select?: {
        stripeStatus?: true;
        amountCents?: true;
        rentalAmountCents?: true;
        depositAmountCents?: true;
        currency?: true;
        stripeCheckoutSessionId?: true;
        stripePaymentIntentId?: true;
      };
    }) => Promise<StripePaymentIntegrityRow | { stripeStatus: string } | null>;
  };
};

export type SyncPaidBookingIntegrityEvidence =
  | {
      source: "checkout_session";
      session: {
        id: string;
        payment_status: string;
        amount_total: number | null;
        currency: string | null;
      };
    }
  | {
      source: "payment_intent";
      intent: {
        id: string;
        amount: number | null;
        currency: string | null;
      };
    };

/** Booking.paymentStatus values that must not be overwritten to PAID. */
export const BOOKING_PAYMENT_STATUSES_BLOCKING_PAID = ["PAID", "REFUNDED"] as const;

export type MarkBookingPaidResult = {
  paymentStatusUpdated: boolean;
  confirmedFromPending: boolean;
};

export type SyncPaidBookingResult = {
  /** True when StripePayment.stripeStatus was written to SUCCEEDED. */
  paymentUpdated: boolean;
  /** Current stripeStatus after the sync attempt (best-effort). */
  stripeStatus: string | null;
  confirmation: DeliverConfirmationForStripePaymentResult;
};

export type DeliverConfirmationForStripePaymentResult =
  | SendBookingConfirmationResult
  | { success: true; deliveryMode: "skipped_ineligible_payment" };

export type SyncPaidBookingAndSendConfirmationDeps = {
  withTransaction: (
    fn: (tx: BookingDb & StripePaymentDb) => Promise<{ paymentUpdated: boolean }>,
  ) => Promise<{ paymentUpdated: boolean }>;
  getStripePaymentStatus: (bookingId: string) => Promise<string | null>;
  deliverConfirmation: (bookingId: string) => Promise<SendBookingConfirmationResult>;
};

/**
 * Atomic where-clause for promoting StripePayment → SUCCEEDED.
 * Only unpaid statuses are eligible; paid-lineage rows are left unchanged.
 */
export function unpaidStripeStatusesAllowingSucceededWrite(): UnpaidStripePaymentStatus[] {
  return [...UNPAID_STRIPE_PAYMENT_STATUSES];
}

/**
 * Marks the booking paid and promotes a soft-reserve to Confirmed.
 * Safe to call repeatedly: already-paid, refunded, confirmed, or cancelled
 * bookings are left as-is for the relevant fields.
 */
export async function markBookingPaidAndConfirmIfPending(
  db: BookingDb,
  bookingId: string,
  note: string,
): Promise<MarkBookingPaidResult> {
  const paid = await db.booking.updateMany({
    where: {
      id: bookingId,
      paymentStatus: { notIn: [...BOOKING_PAYMENT_STATUSES_BLOCKING_PAID] },
    },
    data: { paymentStatus: "PAID" },
  });

  const confirmed = await db.booking.updateMany({
    where: {
      id: bookingId,
      status: "PENDING_PAYMENT",
      paymentStatus: { not: "REFUNDED" },
    },
    data: { status: "CONFIRMED", paymentStatus: "PAID" },
  });

  if (confirmed.count > 0) {
    await db.bookingStatusHistory.create({
      data: {
        bookingId,
        oldStatus: "PENDING_PAYMENT",
        newStatus: "CONFIRMED",
        note,
        changedByAdminId: null,
      },
    });
  }

  return {
    paymentStatusUpdated: paid.count > 0 || confirmed.count > 0,
    confirmedFromPending: confirmed.count > 0,
  };
}

/**
 * Delivers the booking confirmation email only when the Stripe payment is
 * SUCCEEDED or PARTIALLY_REFUNDED. REFUNDED / DISPUTED / unpaid / unknown skip
 * without claiming a successful send.
 */
export async function deliverBookingConfirmationIfStripePaymentAllows(
  bookingId: string,
  deps: {
    getStripePaymentStatus: (bookingId: string) => Promise<string | null>;
    deliverConfirmation: (bookingId: string) => Promise<SendBookingConfirmationResult>;
  } = {
    getStripePaymentStatus: async (id) => {
      const row = await prisma.stripePayment.findUnique({
        where: { bookingId: id },
        select: { stripeStatus: true },
      });
      return row?.stripeStatus ?? null;
    },
    deliverConfirmation: deliverBookingConfirmationIfNeeded,
  },
): Promise<DeliverConfirmationForStripePaymentResult> {
  const stripeStatus = await deps.getStripePaymentStatus(bookingId);
  if (!stripeStatus || !isConfirmationEligibleStripePaymentStatus(stripeStatus)) {
    return { success: true, deliveryMode: "skipped_ineligible_payment" };
  }
  return deps.deliverConfirmation(bookingId);
}

function defaultSyncDeps(): SyncPaidBookingAndSendConfirmationDeps {
  return {
    withTransaction: async (fn) =>
      prisma.$transaction(async (tx) => fn(tx)),
    getStripePaymentStatus: async (bookingId) => {
      const row = await prisma.stripePayment.findUnique({
        where: { bookingId },
        select: { stripeStatus: true },
      });
      return row?.stripeStatus ?? null;
    },
    deliverConfirmation: deliverBookingConfirmationIfNeeded,
  };
}

/**
 * Marks the booking and Stripe payment as paid, confirms a pending booking,
 * then sends the confirmation email when the payment status allows it.
 * Safe to call from webhooks, the success-page verifier, and reconciliation.
 *
 * StripePayment → SUCCEEDED only from unpaid statuses (atomic updateMany).
 * Booking.paymentStatus REFUNDED is never moved back to PAID.
 *
 * Unpaid → SUCCEEDED requires `integrity` evidence matching the stored payment.
 * Paid-lineage duplicates skip amount revalidation.
 */
export async function syncPaidBookingAndSendConfirmation(
  input: {
    bookingId: string;
    paymentIntentId?: string | null;
    checkoutSessionId?: string | null;
    integrity?: SyncPaidBookingIntegrityEvidence | null;
  },
  deps: SyncPaidBookingAndSendConfirmationDeps = defaultSyncDeps(),
): Promise<SyncPaidBookingResult> {
  const { paymentUpdated } = await deps.withTransaction(async (tx) => {
    const payment = await tx.stripePayment.findUnique({
      where: { bookingId: input.bookingId },
      select: {
        stripeStatus: true,
        amountCents: true,
        rentalAmountCents: true,
        depositAmountCents: true,
        currency: true,
        stripeCheckoutSessionId: true,
        stripePaymentIntentId: true,
      },
    });

    if (!payment) {
      throw new Error(`No StripePayment record found for bookingId=${input.bookingId}`);
    }

    const isUnpaidTarget = unpaidStripeStatusesAllowingSucceededWrite().includes(
      payment.stripeStatus as UnpaidStripePaymentStatus,
    );

    if (isUnpaidTarget) {
      if (!input.integrity) {
        throw new Error(
          `PAYMENT_INTEGRITY_REQUIRED: refusing to confirm unpaid booking ${input.bookingId} without Stripe charge evidence`,
        );
      }
      if (!("amountCents" in payment) || typeof payment.amountCents !== "number") {
        throw new Error(
          `PAYMENT_INTEGRITY_REQUIRED: stored payment row incomplete for booking ${input.bookingId}`,
        );
      }
      const stored = payment as StripePaymentIntegrityRow;
      const check =
        input.integrity.source === "checkout_session"
          ? validateCheckoutSessionForConfirmation(stored, input.integrity.session)
          : validatePaymentIntentForConfirmation(stored, input.integrity.intent);
      if (!check.ok) {
        throw new Error(`PAYMENT_INTEGRITY_MISMATCH: ${check.code}: ${check.message}`);
      }
    }

    const updated = await tx.stripePayment.updateMany({
      where: {
        bookingId: input.bookingId,
        stripeStatus: { in: unpaidStripeStatusesAllowingSucceededWrite() },
      },
      data: {
        stripeStatus: "SUCCEEDED",
        updatedAt: new Date(),
        ...(input.paymentIntentId ? { stripePaymentIntentId: input.paymentIntentId } : {}),
        ...(input.checkoutSessionId ? { stripeCheckoutSessionId: input.checkoutSessionId } : {}),
      },
    });

    await markBookingPaidAndConfirmIfPending(
      tx,
      input.bookingId,
      "[stripe] Payment succeeded — booking confirmed",
    );

    return { paymentUpdated: updated.count > 0 };
  });

  const stripeStatus = await deps.getStripePaymentStatus(input.bookingId);
  const confirmation = await deliverBookingConfirmationIfStripePaymentAllows(input.bookingId, {
    getStripePaymentStatus: async () => stripeStatus,
    deliverConfirmation: deps.deliverConfirmation,
  });

  if (paymentUpdated) {
    const booking = await prisma.booking.findUnique({
      where: { id: input.bookingId },
      select: {
        id: true,
        bookingReference: true,
        customerFullName: true,
        vehicleNameSnapshot: true,
      },
    });
    if (booking) {
      await notifyPaymentReceived({
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
        customerFullName: booking.customerFullName,
        vehicleName: booking.vehicleNameSnapshot,
      });
    }
  }

  return { paymentUpdated, stripeStatus, confirmation };
}

/**
 * Whether the success-page / verifier should invoke the paid-booking sync.
 * REFUNDED and DISPUTED must not be synced (no status regression, no email).
 * Unpaid and confirmation-eligible lineage statuses may sync.
 */
export function shouldSyncPaidBookingForStripeStatus(stripeStatus: string): boolean {
  if (isPaidLineageStripePaymentStatus(stripeStatus)) {
    return isConfirmationEligibleStripePaymentStatus(stripeStatus);
  }
  return true;
}
