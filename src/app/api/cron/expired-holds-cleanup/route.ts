import { cleanupUnpaidPendingPaymentBookings } from "@/lib/booking/cleanupUnpaidPendingPaymentBookings";
import { assertCronAuthorization } from "@/lib/cron/assert-cron-authorization";
import { cleanupExpiredHolds } from "@/lib/reservation-holds/cleanupExpiredHolds";

import { handleCronExpiredHoldsCleanup } from "./handle-cron-expired-holds-cleanup";

const deps = {
  authorize: (request: Request) => assertCronAuthorization(request),
  cleanupExpiredHolds,
  cleanupUnpaidPendingPaymentBookings,
};

/**
 * GET /api/cron/expired-holds-cleanup
 *
 * Vercel Cron invokes paths with HTTP GET and (when configured) sends
 * `Authorization: Bearer ${CRON_SECRET}`. Runs the same cleanup pair as
 * `npm run cleanup:expired-holds` (`cleanupExpiredHolds` then
 * `cleanupUnpaidPendingPaymentBookings`). Independent of Stripe webhook recovery.
 *
 * Known scalability risk: expired-hold selection is currently unbounded (no `take`).
 * No route-level `maxDuration` is set without confirmed Hobby function limits.
 *
 * Schedule (Hobby, UTC, at most once daily): see vercel.json. Opportunistic cleanup on
 * availability reads remains important between daily runs. Config in Git does not prove
 * the cron is active until production deploy + Vercel dashboard verification.
 */
export async function GET(request: Request) {
  return handleCronExpiredHoldsCleanup(request, deps);
}
