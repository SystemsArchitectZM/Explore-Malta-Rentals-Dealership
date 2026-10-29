import { requireAdminApiRole } from "@/lib/admin-auth";
import { reconcileHistoricalRefunds } from "@/lib/stripe/refund-reconciliation";

import { handleAdminReconcileRefunds } from "./handle-admin-reconcile-refunds";

/**
 * POST /api/admin/payments/[id]/reconcile-refunds
 * Explicit ADMIN allocation of unmatched historical Stripe refunds.
 * ADMIN role only.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  return handleAdminReconcileRefunds(request, id, {
    authorize: () => requireAdminApiRole(["ADMIN"]),
    reconcileHistoricalRefunds: (input) =>
      reconcileHistoricalRefunds({ ...input, stripePaymentId: id }),
  });
}
