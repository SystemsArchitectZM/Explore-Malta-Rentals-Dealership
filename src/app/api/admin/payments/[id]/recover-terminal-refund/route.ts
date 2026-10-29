import { requireAdminApiRole } from "@/lib/admin-auth";
import { recoverTerminalRefundRequest } from "@/lib/stripe/refund-terminal-recovery";

import { handleAdminRecoverTerminalRefund } from "./handle-admin-recover-terminal-refund";

/**
 * POST /api/admin/payments/[id]/recover-terminal-refund
 * Explicit ADMIN recovery of a FAILED/CANCELLED StripeRefundRequest when a
 * persisted succeeded StripeRefund mirror already exists for the same payment.
 * Never calls Stripe. ADMIN role only.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  return handleAdminRecoverTerminalRefund(request, id, {
    authorize: () => requireAdminApiRole(["ADMIN"]),
    recoverTerminalRefundRequest: (input) =>
      recoverTerminalRefundRequest({ ...input, stripePaymentId: id }),
  });
}
