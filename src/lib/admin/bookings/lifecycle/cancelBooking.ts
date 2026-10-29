import type { PaymentStatus, Prisma, PrismaClient } from "@/generated/prisma/index";
import type { AdminBookingDetail } from "@/lib/admin/bookings/types";
import type { CancelBookingInput } from "@/lib/admin/bookings/lifecycle/booking-lifecycle-schema";
import { resolvePaymentStatusOnCancel } from "@/lib/admin/bookings/lifecycle/resolve-payment-status-on-cancel";
import { recordBookingStatusChange } from "@/lib/admin/bookings/lifecycle/recordBookingStatusChange";
import { notifyBookingCancelled } from "@/lib/admin/notifications";
import { restoreLoyaltyCreditForUnpaidBooking } from "@/lib/loyalty/loyalty-credit";

/** Mirrors UNPAID_RELEASE_PAYMENT_STATUSES — kept local to avoid importing Prisma-backed release module. */
const UNPAID_CANCEL_PAYMENT_STATUSES: PaymentStatus[] = ["PENDING", "FAILED"];

export type CancelBookingResult =
  | { ok: true; booking: AdminBookingDetail }
  | {
      ok: false;
      reason: "not_found" | "invalid_status";
    };

type CancelBookingDb = {
  booking: Pick<PrismaClient["booking"], "findUnique">;
  $transaction: PrismaClient["$transaction"];
};

type OccupancyTx = Pick<Prisma.TransactionClient, "$executeRaw" | "$executeRawUnsafe">;

/** Optional overrides for unit tests — production callers omit this. */
export type CancelBookingDeps = {
  db?: CancelBookingDb;
  getBookingDetail?: (bookingId: string) => Promise<AdminBookingDetail | null>;
  deleteOccupancyForBooking?: (tx: OccupancyTx, bookingId: string) => Promise<void>;
};

class CancelConflictError extends Error {
  constructor() {
    super("CANCEL_CONFLICT");
    this.name = "CancelConflictError";
  }
}

/**
 * Cancels a CONFIRMED or PENDING_PAYMENT booking.
 *
 * For PENDING_PAYMENT, the status transition is conditional on the booking still
 * being unpaid. If payment confirmation wins the race, zero rows are updated,
 * loyalty is not restored, and the caller receives `invalid_status`.
 */
export async function cancelBooking(
  bookingId: string,
  input: CancelBookingInput,
  adminUserId: string,
  deps: CancelBookingDeps = {},
): Promise<CancelBookingResult> {
  const db =
    deps.db ??
    ((await import("@/lib/prisma")).prisma as unknown as CancelBookingDb);
  const loadDetail =
    deps.getBookingDetail ??
    (await import("@/lib/admin/bookings/getAdminBookingById")).getAdminBookingById;
  const deleteOccupancy =
    deps.deleteOccupancyForBooking ??
    (await import("@/lib/vehicle-unit-occupancy")).deleteOccupancyForBooking;

  const existing = await db.booking.findUnique({
    where: { id: bookingId },
    select: {
      id: true,
      status: true,
      paymentStatus: true,
      securityDepositStatus: true,
      vehicleUnitId: true,
    },
  });

  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  // A credit redeemed on a confirmed booking stays redeemed if that booking is later cancelled.
  // A pending booking never became a completed sale, so cancelling it returns the credit.
  if (existing.status !== "CONFIRMED" && existing.status !== "PENDING_PAYMENT") {
    return { ok: false, reason: "invalid_status" };
  }

  // Stale unpaid snapshot: payment already completed — do not treat as unpaid cancel.
  if (
    existing.status === "PENDING_PAYMENT" &&
    !UNPAID_CANCEL_PAYMENT_STATUSES.includes(existing.paymentStatus)
  ) {
    return { ok: false, reason: "invalid_status" };
  }

  const nextPaymentStatus = resolvePaymentStatusOnCancel(
    existing.paymentStatus,
    input.refundPayment,
  );

  let nextDepositStatus = existing.securityDepositStatus;
  if (input.depositOutcome === "REFUNDED" && existing.securityDepositStatus === "COLLECTED") {
    nextDepositStatus = "REFUNDED";
  } else if (input.depositOutcome === "DEDUCTED" && existing.securityDepositStatus === "COLLECTED") {
    nextDepositStatus = "DEDUCTED";
  }

  try {
    await db.$transaction(async (tx) => {
      const cancelWhere =
        existing.status === "PENDING_PAYMENT"
          ? {
              id: bookingId,
              status: "PENDING_PAYMENT" as const,
              paymentStatus: { in: [...UNPAID_CANCEL_PAYMENT_STATUSES] },
            }
          : {
              id: bookingId,
              status: "CONFIRMED" as const,
            };

      const cancelled = await tx.booking.updateMany({
        where: cancelWhere,
        data: {
          status: "CANCELLED",
          paymentStatus: nextPaymentStatus,
          securityDepositStatus: nextDepositStatus,
          depositRefundAmount:
            input.depositOutcome === "REFUNDED" ? (input.depositRefundAmount ?? null) : null,
          depositDeductionAmount:
            input.depositOutcome === "DEDUCTED" ? (input.depositDeductionAmount ?? null) : null,
          depositDeductionReason:
            input.depositOutcome === "DEDUCTED" ? input.depositDeductionReason?.trim() || null : null,
        },
      });

      if (cancelled.count !== 1) {
        throw new CancelConflictError();
      }

      if (existing.vehicleUnitId) {
        await tx.vehicleUnit.update({
          where: { id: existing.vehicleUnitId },
          data: { status: "AVAILABLE" },
        });
      }

      await deleteOccupancy(tx, bookingId);

      // Restore only after the unpaid → CANCELLED transition succeeded in this tx.
      if (existing.status === "PENDING_PAYMENT") {
        await restoreLoyaltyCreditForUnpaidBooking(tx, bookingId);
      }

      await recordBookingStatusChange(tx, {
        bookingId,
        oldStatus: existing.status,
        newStatus: "CANCELLED",
        adminUserId,
        note: input.note,
      });
    });
  } catch (error) {
    if (error instanceof CancelConflictError) {
      return { ok: false, reason: "invalid_status" };
    }
    throw error;
  }

  const booking = await loadDetail(bookingId);
  if (!booking) {
    return { ok: false, reason: "not_found" };
  }

  await notifyBookingCancelled(booking, adminUserId);

  return { ok: true, booking };
}
