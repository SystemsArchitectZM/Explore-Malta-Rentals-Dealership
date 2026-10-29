import { NextResponse } from "next/server";
import type { Prisma, StripePaymentStatus } from "@/generated/prisma/index";
import { requireAdminApi, AdminUnauthorizedError } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import { buildAdminPaymentListRefundMetrics } from "@/features/admin/lib/stripe-payment-list-availability";
import type { LinkedRefundRequest, PaymentRefundCounters } from "@/lib/stripe/refund-accounting";

/**
 * GET /api/admin/payments
 * Returns paginated list of Stripe payments with booking info and refund capacity.
 * Query: ?page=1&limit=20&status=SUCCEEDED&search=EMR-xxx
 */
export async function GET(request: Request) {
  try {
    await requireAdminApi();

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") ?? "20", 10)));
    const status = searchParams.get("status");
    const search = searchParams.get("search")?.trim();

    const where: Prisma.StripePaymentWhereInput = {};

    if (status) {
      where.stripeStatus = status as StripePaymentStatus;
    }

    if (search) {
      where.OR = [
        { Booking: { bookingReference: { contains: search, mode: "insensitive" } } },
        { Booking: { customerEmail: { contains: search, mode: "insensitive" } } },
        { Booking: { customerFullName: { contains: search, mode: "insensitive" } } },
      ];
    }

    const [payments, total] = await Promise.all([
      prisma.stripePayment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          Booking: {
            select: {
              bookingReference: true,
              customerFullName: true,
              customerEmail: true,
              pickupDateTime: true,
              returnDateTime: true,
              vehicleNameSnapshot: true,
              status: true,
              paymentStatus: true,
              depositMethod: true,
            },
          },
          StripeRefund: {
            select: { stripeRefundId: true, amountCents: true, status: true, createdAt: true },
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      prisma.stripePayment.count({ where }),
    ]);

    // Stage 1B client may lag generate — access request model via cast.
    const rr = prisma as typeof prisma & {
      stripeRefundRequest: {
        findMany: (args: unknown) => Promise<
          Array<{
            stripePaymentId: string;
            stripeRefundId: string | null;
            purpose: string;
            status: string;
            amountCents: number;
          }>
        >;
      };
    };

    const paymentIds = payments.map((p) => p.id);
    let requests: Array<{
      stripePaymentId: string;
      stripeRefundId: string | null;
      purpose: string;
      status: string;
      amountCents: number;
    }> = [];
    try {
      requests = await rr.stripeRefundRequest.findMany({
        where: { stripePaymentId: { in: paymentIds } },
      });
    } catch {
      requests = [];
    }

    const requestsByPayment = new Map<string, typeof requests>();
    for (const row of requests) {
      const list = requestsByPayment.get(row.stripePaymentId) ?? [];
      list.push(row);
      requestsByPayment.set(row.stripePaymentId, list);
    }

    return NextResponse.json({
      success: true as const,
      payments: payments.map((p) => {
        const counters: PaymentRefundCounters = {
          amountCents: p.amountCents,
          rentalAmountCents: p.rentalAmountCents,
          depositAmountCents: p.depositAmountCents,
          refundedAmountCents: p.refundedAmountCents,
          rentalRefundedCents: p.rentalRefundedCents,
          depositRefundedCents: p.depositRefundedCents,
        };
        const paymentRequests = (requestsByPayment.get(p.id) ?? []).map((r) => ({
          stripeRefundId: r.stripeRefundId,
          purpose: r.purpose as LinkedRefundRequest["purpose"],
          status: r.status as LinkedRefundRequest["status"],
          amountCents: r.amountCents,
        }));
        const metrics = buildAdminPaymentListRefundMetrics({
          payment: counters,
          requests: paymentRequests,
          stripeRefunds: p.StripeRefund.map((r) => ({
            stripeRefundId: r.stripeRefundId,
            amountCents: r.amountCents,
          })),
        });

        return {
          id: p.id,
          bookingId: p.bookingId,
          bookingReference: p.Booking.bookingReference,
          customerName: p.Booking.customerFullName,
          customerEmail: p.Booking.customerEmail,
          vehicleName: p.Booking.vehicleNameSnapshot,
          pickupDate: p.Booking.pickupDateTime,
          returnDate: p.Booking.returnDateTime,
          amountEur: p.amountCents / 100,
          rentalAmountEur: p.rentalAmountCents / 100,
          depositAmountEur: p.depositAmountCents / 100,
          rentalRefundedEur: p.rentalRefundedCents / 100,
          depositRefundedEur: p.depositRefundedCents / 100,
          rentalAvailableEur: metrics.rentalAvailableCents / 100,
          depositAvailableEur: metrics.depositAvailableCents / 100,
          combinedAvailableEur: metrics.combinedAvailableCents / 100,
          availabilityReliable: metrics.availabilityReliable,
          currency: p.currency,
          stripeStatus: p.stripeStatus,
          refundStatus: p.refundStatus,
          refundedAmountEur: p.refundedAmountCents / 100,
          bookingStatus: p.Booking.status,
          bookingPaymentStatus: p.Booking.paymentStatus,
          depositMethod: p.Booking.depositMethod,
          stripeCheckoutSessionId: p.stripeCheckoutSessionId,
          stripePaymentIntentId: p.stripePaymentIntentId,
          needsReconciliation: metrics.needsReconciliation,
          reconciliationReasons: metrics.reconciliationReasons,
          unmatchedRefundIds: metrics.unmatchedRefundIds,
          refunds: p.StripeRefund.map((r) => ({
            stripeRefundId: r.stripeRefundId,
            amountEur: r.amountCents / 100,
            status: r.status,
            createdAt: r.createdAt,
          })),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        };
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof AdminUnauthorizedError) {
      return NextResponse.json({ success: false as const, message: "Unauthorized" }, { status: 401 });
    }
    console.error("[api/admin/payments] GET error", error);
    return NextResponse.json({ success: false as const, message: "Internal server error" }, { status: 500 });
  }
}
