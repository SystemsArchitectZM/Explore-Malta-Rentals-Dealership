import type { BookingStatus, PaymentStatus, Prisma } from "@/generated/prisma/index";
import { restoreLoyaltyCreditForUnpaidBooking } from "@/lib/loyalty/loyalty-credit";
import { deleteOccupancyForBooking } from "@/lib/vehicle-unit-occupancy";

type ReleaseDb = Pick<
  Prisma.TransactionClient,
  | "booking"
  | "vehicleUnit"
  | "bookingStatusHistory"
  | "customerLoyaltyCredit"
  | "$executeRaw"
  | "$executeRawUnsafe"
>;

export type ReleaseUnpaidBookingResult =
  | { ok: true; released: true; previousStatus: BookingStatus }
  | { ok: true; released: false; reason: "not_found" | "not_releasable" }
  | { ok: false; error: string };

const RELEASABLE_STATUSES: BookingStatus[] = ["PENDING_PAYMENT", "CONFIRMED"];

/** Booking.paymentStatus values treated as unpaid for soft-reserve release. */
export const UNPAID_RELEASE_PAYMENT_STATUSES: PaymentStatus[] = ["PENDING", "FAILED"];

/**
 * Cancels an unpaid online booking and frees the vehicle unit occupancy.
 * Idempotent: already-cancelled bookings are reported as not_releasable.
 *
 * Loyalty restoration runs only after a conditional status transition succeeds
 * inside the caller's transaction, so a concurrent payment confirmation that
 * moves the booking to PAID/CONFIRMED wins and prevents credit restoration.
 */
export async function releaseUnpaidBooking(
  db: ReleaseDb,
  bookingId: string,
  options: {
    note?: string;
    actorLabel?: string;
    /** When true, also release legacy CONFIRMED+unpaid online bookings. */
    allowConfirmedUnpaid?: boolean;
  } = {},
): Promise<ReleaseUnpaidBookingResult> {
  try {
    const booking = await db.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        totalDueOnline: true,
        vehicleUnitId: true,
      },
    });

    if (!booking) {
      return { ok: true, released: false, reason: "not_found" };
    }

    const totalDueOnline =
      typeof booking.totalDueOnline === "number"
        ? booking.totalDueOnline
        : booking.totalDueOnline.toNumber();

    const isPendingUnpaid =
      booking.status === "PENDING_PAYMENT" &&
      UNPAID_RELEASE_PAYMENT_STATUSES.includes(booking.paymentStatus);

    const isLegacyConfirmedUnpaid =
      options.allowConfirmedUnpaid === true &&
      booking.status === "CONFIRMED" &&
      totalDueOnline > 0 &&
      UNPAID_RELEASE_PAYMENT_STATUSES.includes(booking.paymentStatus);

    if (!isPendingUnpaid && !isLegacyConfirmedUnpaid) {
      return { ok: true, released: false, reason: "not_releasable" };
    }

    if (!RELEASABLE_STATUSES.includes(booking.status)) {
      return { ok: true, released: false, reason: "not_releasable" };
    }

    const previousStatus = booking.status;

    // Conditional write: refuse to cancel if payment confirmation won the race.
    const cancelled = await db.booking.updateMany({
      where: {
        id: bookingId,
        status: previousStatus,
        paymentStatus: { in: [...UNPAID_RELEASE_PAYMENT_STATUSES] },
      },
      data: {
        status: "CANCELLED",
        paymentStatus: "FAILED",
      },
    });

    if (cancelled.count !== 1) {
      return { ok: true, released: false, reason: "not_releasable" };
    }

    const restoredCredit = await restoreLoyaltyCreditForUnpaidBooking(db, booking.id);
    const note =
      options.note?.trim() ||
      "Released unpaid online booking after payment failure or checkout expiry";
    const noteWithCredit = restoredCredit.restored
      ? `${note} €5 loyalty credit returned to available because payment was not completed.`
      : note;

    if (booking.vehicleUnitId) {
      await db.vehicleUnit.update({
        where: { id: booking.vehicleUnitId },
        data: { status: "AVAILABLE" },
      });
    }

    await deleteOccupancyForBooking(db, bookingId);

    await db.bookingStatusHistory.create({
      data: {
        bookingId,
        oldStatus: previousStatus,
        newStatus: "CANCELLED",
        note: options.actorLabel ? `[${options.actorLabel}] ${noteWithCredit}` : noteWithCredit,
        changedByAdminId: null,
      },
    });

    return { ok: true, released: true, previousStatus };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
