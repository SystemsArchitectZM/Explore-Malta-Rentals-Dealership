import { NextResponse } from "next/server";
import { z } from "zod";

import { AdminForbiddenError, AdminUnauthorizedError } from "@/lib/admin-auth/errors";
import type { AdminSessionRecord } from "@/lib/admin-auth/types";
import type {
  ReconcileHistoricalRefundsInput,
  ReconcileHistoricalRefundsResult,
} from "@/lib/stripe/types";

const reconcileSchema = z.object({
  evidence: z.string().trim().min(8).max(2000),
  allocations: z
    .array(
      z.object({
        stripeRefundId: z.string().trim().min(3).max(128),
        purpose: z.enum(["RENTAL", "SECURITY_DEPOSIT"]),
      }),
    )
    .min(1)
    .max(50),
});

export type AdminReconcileRefundsDeps = {
  authorize: () => Promise<AdminSessionRecord>;
  reconcileHistoricalRefunds: (
    input: ReconcileHistoricalRefundsInput,
  ) => Promise<ReconcileHistoricalRefundsResult>;
};

/**
 * Explicit ADMIN historical refund allocation. Auth before any reconciliation work.
 */
export async function handleAdminReconcileRefunds(
  request: Request,
  stripePaymentId: string,
  deps: AdminReconcileRefundsDeps,
): Promise<NextResponse> {
  try {
    const session = await deps.authorize();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false as const, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = reconcileSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false as const,
          message: "Invalid reconciliation parameters",
          details: parsed.error.errors,
        },
        { status: 400 },
      );
    }

    const result = await deps.reconcileHistoricalRefunds({
      stripePaymentId,
      allocations: parsed.data.allocations,
      evidence: parsed.data.evidence,
      initiatedBy: `admin:${session.id}`,
    });

    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "incomplete_allocation" || result.code === "already_reconciled"
            ? 409
            : 422;
      return NextResponse.json(
        {
          success: false as const,
          message: result.error,
          code: result.code ?? null,
        },
        { status },
      );
    }

    return NextResponse.json({
      success: true as const,
      reconciledCount: result.reconciledCount,
      message:
        result.reconciledCount === 0
          ? "Payment already had no unresolved historical refund ambiguity"
          : `Reconciled ${result.reconciledCount} historical refund allocation(s)`,
    });
  } catch (error) {
    if (error instanceof AdminUnauthorizedError) {
      return NextResponse.json({ success: false as const, message: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof AdminForbiddenError) {
      return NextResponse.json({ success: false as const, message: "Forbidden" }, { status: 403 });
    }
    console.error("[api/admin/payments/reconcile-refunds] POST error", error);
    return NextResponse.json({ success: false as const, message: "Internal server error" }, { status: 500 });
  }
}
