import { NextResponse } from "next/server";
import { z } from "zod";

import { AdminForbiddenError, AdminUnauthorizedError } from "@/lib/admin-auth/errors";
import type { AdminSessionRecord } from "@/lib/admin-auth/types";
import type { CreateRefundInput, CreateRefundResult } from "@/lib/stripe/types";

const refundSchema = z.object({
  amountEur: z.number().positive().optional(),
  purpose: z.enum(["RENTAL", "SECURITY_DEPOSIT"]),
  clientRequestId: z
    .string()
    .trim()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_.:-]+$/, "clientRequestId contains invalid characters"),
  reason: z.enum(["duplicate", "fraudulent", "requested_by_customer"]).default("requested_by_customer"),
  notes: z.string().max(500).optional(),
});

export type AdminPaymentRefundDeps = {
  authorize: () => Promise<AdminSessionRecord>;
  findPaymentBookingId: (stripePaymentId: string) => Promise<string | null>;
  createRefund: (input: CreateRefundInput) => Promise<CreateRefundResult>;
};

/**
 * Shared refund POST logic so authorization can be unit-tested without Stripe.
 * Auth runs before any payment lookup or refund service call.
 */
export async function handleAdminPaymentRefund(
  request: Request,
  stripePaymentId: string,
  deps: AdminPaymentRefundDeps,
): Promise<NextResponse> {
  try {
    const session = await deps.authorize();

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false as const, message: "Invalid request body" }, { status: 400 });
    }

    const parsed = refundSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false as const, message: "Invalid refund parameters", details: parsed.error.errors },
        { status: 400 },
      );
    }

    const bookingId = await deps.findPaymentBookingId(stripePaymentId);
    if (!bookingId) {
      return NextResponse.json({ success: false as const, message: "Payment record not found" }, { status: 404 });
    }

    const result = await deps.createRefund({
      bookingId,
      amountEur: parsed.data.amountEur,
      purpose: parsed.data.purpose,
      clientRequestId: parsed.data.clientRequestId,
      reason: parsed.data.reason,
      initiatedBy: `admin:${session.id}`,
      notes: parsed.data.notes,
    });

    if (!result.ok) {
      const status =
        result.code === "needs_reconciliation"
          ? 409
          : result.code === "request_conflict"
            ? 409
            : result.code === "not_found"
              ? 404
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
      status: result.status,
      refundId: result.refundId,
      requestId: result.requestId,
      clientRequestId: result.clientRequestId,
      purpose: result.purpose,
      amountEur: result.amountEur,
      message:
        result.status === "pending"
          ? `Refund of €${result.amountEur.toFixed(2)} reserved and awaiting Stripe confirmation`
          : `Refund of €${result.amountEur.toFixed(2)} succeeded`,
    });
  } catch (error) {
    if (error instanceof AdminUnauthorizedError) {
      return NextResponse.json({ success: false as const, message: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof AdminForbiddenError) {
      return NextResponse.json({ success: false as const, message: "Forbidden" }, { status: 403 });
    }
    console.error("[api/admin/payments/refund] POST error", error);
    return NextResponse.json({ success: false as const, message: "Internal server error" }, { status: 500 });
  }
}
