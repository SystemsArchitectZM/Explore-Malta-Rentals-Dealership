import { requireAdminApiRole } from "@/lib/admin-auth";
import { createRefund } from "@/lib/stripe/refund-service";
import { prisma } from "@/lib/prisma";

import { handleAdminPaymentRefund } from "./handle-admin-payment-refund";

/**
 * POST /api/admin/payments/[id]/refund
 * Initiates a full or partial refund. [id] is the StripePayment.id.
 * ADMIN role only — STAFF receives 403; unauthenticated receives 401.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  return handleAdminPaymentRefund(request, id, {
    authorize: () => requireAdminApiRole(["ADMIN"]),
    findPaymentBookingId: async (stripePaymentId) => {
      const stripePayment = await prisma.stripePayment.findUnique({
        where: { id: stripePaymentId },
        select: { bookingId: true },
      });
      return stripePayment?.bookingId ?? null;
    },
    createRefund,
  });
}
