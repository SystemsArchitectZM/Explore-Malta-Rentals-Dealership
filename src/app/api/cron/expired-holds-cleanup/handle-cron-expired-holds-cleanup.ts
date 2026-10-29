import { NextResponse } from "next/server";

import type { CleanupUnpaidPendingPaymentBookingsResult } from "@/lib/booking/cleanupUnpaidPendingPaymentBookings";
import { CronUnauthorizedError } from "@/lib/cron/assert-cron-authorization";
import type { CleanupExpiredHoldsResult } from "@/lib/reservation-holds/cleanupExpiredHolds";

export const CRON_EXPIRED_HOLDS_ACTOR = "cron:expired-holds-cleanup";

export type CronExpiredHoldsCleanupDeps = {
  authorize: (request: Request) => void;
  cleanupExpiredHolds: () => Promise<CleanupExpiredHoldsResult>;
  cleanupUnpaidPendingPaymentBookings: () => Promise<CleanupUnpaidPendingPaymentBookingsResult>;
};

/**
 * GET handler body for Vercel Cron. Auth before any cleanup. Reuses the same services
 * as `scripts/cleanup-expired-holds.ts`. Independent of webhook recovery.
 *
 * Known risk (unchanged): `cleanupExpiredHolds` selects all expired ACTIVE holds with
 * no batch limit; a large backlog can stress a single Function invocation.
 */
export async function handleCronExpiredHoldsCleanup(
  request: Request,
  deps: CronExpiredHoldsCleanupDeps,
): Promise<NextResponse> {
  try {
    deps.authorize(request);

    const holdResult = await deps.cleanupExpiredHolds();
    const unpaidResult = await deps.cleanupUnpaidPendingPaymentBookings();

    const errorCount = holdResult.errors.length + unpaidResult.errors.length;
    if (errorCount > 0) {
      return NextResponse.json(
        {
          success: false as const,
          code: "CLEANUP_ERRORS",
          message: "Cleanup completed with one or more item errors",
          actor: CRON_EXPIRED_HOLDS_ACTOR,
          holds: {
            expiredHoldsFound: holdResult.expiredHoldsFound,
            holdsExpired: holdResult.holdsExpired,
            occupancyRowsReleased: holdResult.occupancyRowsReleased,
            orphanOccupancyReleased: holdResult.orphanOccupancyReleased,
            errorCount: holdResult.errors.length,
          },
          unpaid: {
            candidatesFound: unpaidResult.candidatesFound,
            bookingsReleased: unpaidResult.bookingsReleased,
            errorCount: unpaidResult.errors.length,
          },
        },
        { status: 500 },
      );
    }

    return NextResponse.json({
      success: true as const,
      actor: CRON_EXPIRED_HOLDS_ACTOR,
      holds: {
        expiredHoldsFound: holdResult.expiredHoldsFound,
        holdsExpired: holdResult.holdsExpired,
        occupancyRowsReleased: holdResult.occupancyRowsReleased,
        orphanOccupancyReleased: holdResult.orphanOccupancyReleased,
        errorCount: 0,
      },
      unpaid: {
        candidatesFound: unpaidResult.candidatesFound,
        bookingsReleased: unpaidResult.bookingsReleased,
        errorCount: 0,
      },
    });
  } catch (error) {
    if (error instanceof CronUnauthorizedError) {
      return NextResponse.json(
        { success: false as const, code: "UNAUTHORIZED", message: "Unauthorized" },
        { status: 401 },
      );
    }
    console.error("[api/cron/expired-holds-cleanup] GET error");
    return NextResponse.json(
      { success: false as const, code: "INTERNAL_ERROR", message: "Internal server error" },
      { status: 500 },
    );
  }
}
