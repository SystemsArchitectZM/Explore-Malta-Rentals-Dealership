import { NextResponse } from "next/server";
import { z } from "zod";

import { AdminForbiddenError, AdminUnauthorizedError } from "@/lib/admin-auth/errors";
import type { AdminSessionRecord } from "@/lib/admin-auth/types";
import {
  TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH,
} from "@/lib/stripe/refund-terminal-recovery";
import type {
  RecoverTerminalRefundInput,
  RecoverTerminalRefundResult,
} from "@/lib/stripe/types";

const recoverSchema = z.object({
  requestId: z.string().trim().min(1).max(128),
  stripeRefundId: z.string().trim().min(3).max(128),
  evidence: z
    .string()
    .trim()
    .min(TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH)
    .max(2000),
  purpose: z.enum(["RENTAL", "SECURITY_DEPOSIT"]).optional(),
  expectedClientRequestId: z.string().trim().min(1).max(128).optional(),
  expectedCurrency: z.string().trim().min(3).max(8).optional(),
});

export type AdminRecoverTerminalRefundDeps = {
  authorize: () => Promise<AdminSessionRecord>;
  recoverTerminalRefundRequest: (
    input: RecoverTerminalRefundInput,
  ) => Promise<RecoverTerminalRefundResult>;
};

/**
 * Explicit ADMIN recovery of FAILED/CANCELLED refund requests with persisted
 * succeeded StripeRefund mirror evidence. Auth before any recovery work.
 * Never calls Stripe.
 */
export async function handleAdminRecoverTerminalRefund(
  request: Request,
  stripePaymentId: string,
  deps: AdminRecoverTerminalRefundDeps,
): Promise<NextResponse> {
  try {
    const session = await deps.authorize();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false as const, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = recoverSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false as const,
          message: "Invalid recovery parameters",
          details: parsed.error.errors,
        },
        { status: 400 },
      );
    }

    const result = await deps.recoverTerminalRefundRequest({
      stripePaymentId,
      requestId: parsed.data.requestId,
      stripeRefundId: parsed.data.stripeRefundId,
      evidence: parsed.data.evidence,
      purpose: parsed.data.purpose,
      expectedClientRequestId: parsed.data.expectedClientRequestId,
      expectedCurrency: parsed.data.expectedCurrency,
      initiatedBy: `admin:${session.id}`,
    });

    if (!result.ok) {
      const status =
        result.code === "not_found"
          ? 404
          : result.code === "evidence_required"
            ? 400
            : result.code === "not_recoverable_state" ||
                result.code === "stripe_refund_mismatch" ||
                result.code === "stripe_refund_conflict" ||
                result.code === "purpose_conflict" ||
                result.code === "client_request_conflict" ||
                result.code === "payment_conflict" ||
                result.code === "currency_conflict" ||
                result.code === "needs_reconciliation" ||
                result.code === "already_reconciled"
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
      requestId: result.requestId,
      stripeRefundId: result.stripeRefundId,
      purpose: result.purpose,
      amountCents: result.amountCents,
      idempotent: result.idempotent,
      mirrorRepaired: result.mirrorRepaired,
      message: result.idempotent
        ? result.mirrorRepaired
          ? "Recovery already applied; repaired missing local refund mirror"
          : "Recovery already applied (idempotent)"
        : "Terminal refund request recovered to SUCCEEDED",
    });
  } catch (error) {
    if (error instanceof AdminUnauthorizedError) {
      return NextResponse.json({ success: false as const, message: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof AdminForbiddenError) {
      return NextResponse.json({ success: false as const, message: "Forbidden" }, { status: 403 });
    }
    console.error("[api/admin/payments/recover-terminal-refund] POST error", error);
    return NextResponse.json({ success: false as const, message: "Internal server error" }, { status: 500 });
  }
}
