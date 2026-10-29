import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { writePaymentAuditLog } from "./audit-service";
import {
  assertPaymentAllocationIntegrity,
  assertPurposeRefundFits,
  computeAuthoritativeRefundAvailability,
  detectHistoricalRefundAmbiguity,
  sumSucceededRefundCounters,
  type LinkedRefundRequest,
  type PaymentRefundCounters,
  type RefundPurposeAdmin,
} from "./refund-accounting";
import { applyAbsoluteRefundCounters } from "./refund-counter-writer";
import type {
  ReconcileHistoricalRefundsInput,
  ReconcileHistoricalRefundsResult,
} from "./types";

type RefundRequestRow = {
  id: string;
  stripePaymentId: string;
  clientRequestId: string;
  purpose: RefundPurposeAdmin | "UNSPECIFIED";
  amountCents: number;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stripeRefundId: string | null;
};

export type ReconcilePaymentLockContext = {
  payment: PaymentRefundCounters & { id: string; bookingId: string };
  requests: RefundRequestRow[];
  stripeRefunds: Array<{ stripeRefundId: string; amountCents: number }>;
  createSucceededAllocation: (row: {
    stripeRefundId: string;
    purpose: RefundPurposeAdmin;
    amountCents: number;
    clientRequestId: string;
    initiatedBy: string;
    notes: string;
    evidence: string;
  }) => Promise<RefundRequestRow>;
  /** Absolute counter write inside the same locked transaction (caller must not open a nested txn). */
  setCountersAbsolute: (input: {
    bookingId: string;
    rentalRefundedCents: number;
    depositRefundedCents: number;
    refundedAmountCents: number;
  }) => Promise<void>;
};

export type ReconcileHistoricalRefundsDeps = {
  withPaymentLock: <T>(
    stripePaymentId: string,
    fn: (ctx: ReconcilePaymentLockContext) => Promise<T>,
  ) => Promise<T>;
  writeAuditLog: (args: {
    bookingId: string;
    stripePaymentId: string;
    action: "refund_reconciled";
    actor: string;
    newValue: Record<string, unknown>;
  }) => Promise<void>;
};

function refundRequestDb(client: typeof prisma) {
  return client as typeof prisma & {
    stripeRefundRequest: {
      findMany: (args: unknown) => Promise<RefundRequestRow[]>;
      create: (args: unknown) => Promise<RefundRequestRow>;
      findUnique: (args: unknown) => Promise<RefundRequestRow | null>;
    };
  };
}

function defaultReconcileDeps(): ReconcileHistoricalRefundsDeps {
  return {
    withPaymentLock: async (stripePaymentId, fn) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "StripePayment" WHERE id = ${stripePaymentId} FOR UPDATE
        `;
        const payment = (await tx.stripePayment.findUnique({
          where: { id: stripePaymentId },
          select: {
            id: true,
            bookingId: true,
            amountCents: true,
            rentalAmountCents: true,
            depositAmountCents: true,
            refundedAmountCents: true,
            rentalRefundedCents: true,
            depositRefundedCents: true,
          },
        })) as (PaymentRefundCounters & { id: string; bookingId: string }) | null;
        if (!payment) {
          throw Object.assign(new Error("Payment not found"), { code: "not_found" });
        }

        const txRr = refundRequestDb(tx as unknown as typeof prisma);
        const requests = (await txRr.stripeRefundRequest.findMany({
          where: { stripePaymentId },
        })) as RefundRequestRow[];
        const stripeRefunds = await tx.stripeRefund.findMany({
          where: { stripePaymentId },
          select: { stripeRefundId: true, amountCents: true },
        });

        return fn({
          payment,
          requests,
          stripeRefunds,
          createSucceededAllocation: async (row) => {
            const now = new Date();
            const created = (await txRr.stripeRefundRequest.create({
              data: {
                id: randomUUID(),
                stripePaymentId: payment.id,
                clientRequestId: row.clientRequestId,
                purpose: row.purpose,
                amountCents: row.amountCents,
                status: "SUCCEEDED",
                stripeRefundId: row.stripeRefundId,
                initiatedBy: row.initiatedBy,
                notes: row.notes,
                metadata: {
                  kind: "historical_reconciliation",
                  evidence: row.evidence,
                },
                createdAt: now,
                updatedAt: now,
              },
            })) as RefundRequestRow;
            requests.push(created);
            return created;
          },
          setCountersAbsolute: async ({
            bookingId,
            rentalRefundedCents,
            depositRefundedCents,
            refundedAmountCents,
          }) => {
            await applyAbsoluteRefundCounters(tx, {
              stripePaymentId,
              bookingId,
              amountCents: payment.amountCents,
              rentalRefundedCents,
              depositRefundedCents,
              refundedAmountCents,
            });
          },
        });
      }),
    writeAuditLog: async (args) => {
      await writePaymentAuditLog({
        bookingId: args.bookingId,
        stripePaymentId: args.stripePaymentId,
        action: args.action,
        actor: args.actor,
        newValue: args.newValue,
      });
    },
  };
}

function throwNoCapacity(error: unknown): never {
  throw Object.assign(
    error instanceof Error ? error : new Error("Refund exceeds available capacity"),
    { code: "no_capacity" },
  );
}

/**
 * Explicit ADMIN reconciliation of unmatched historical StripeRefund rows.
 * Allocations and absolute counter recompute commit in one locked transaction.
 *
 * Purpose caps: every proposed allocation is checked with
 * `computeAuthoritativeRefundAvailability` + `assertPurposeRefundFits` (same contract
 * as createRefund) against SUCCEEDED sums and PENDING reservations — including
 * prior allocations in this batch — before any row is persisted.
 */
export async function reconcileHistoricalRefunds(
  input: ReconcileHistoricalRefundsInput,
  deps: ReconcileHistoricalRefundsDeps = defaultReconcileDeps(),
): Promise<ReconcileHistoricalRefundsResult> {
  const evidence = input.evidence?.trim();
  if (!evidence || evidence.length < 8) {
    return {
      ok: false,
      error: "Reconciliation requires explicit audited evidence (min 8 characters)",
      code: "evidence_required",
    };
  }
  if (!input.allocations.length) {
    return { ok: false, error: "At least one refund allocation is required", code: "invalid_request" };
  }

  const seen = new Set<string>();
  for (const row of input.allocations) {
    if (seen.has(row.stripeRefundId)) {
      return { ok: false, error: "Duplicate stripeRefundId in allocations", code: "invalid_request" };
    }
    seen.add(row.stripeRefundId);
    if (row.purpose !== "RENTAL" && row.purpose !== "SECURITY_DEPOSIT") {
      return { ok: false, error: "Allocation purpose must be RENTAL or SECURITY_DEPOSIT", code: "invalid_purpose" };
    }
  }

  try {
    const result = await deps.withPaymentLock(input.stripePaymentId, async (ctx) => {
      assertPaymentAllocationIntegrity(ctx.payment);

      const ambiguity = detectHistoricalRefundAmbiguity({
        payment: ctx.payment,
        stripeRefunds: ctx.stripeRefunds,
        requests: ctx.requests as LinkedRefundRequest[],
      });
      if (!ambiguity.ambiguous) {
        return { reconciledCount: 0, bookingId: ctx.payment.bookingId, alreadyClear: true as const };
      }

      const refundById = new Map(ctx.stripeRefunds.map((r) => [r.stripeRefundId, r]));
      const linked = new Set(
        ctx.requests
          .filter((r) => r.stripeRefundId && (r.status === "SUCCEEDED" || r.status === "PENDING"))
          .map((r) => r.stripeRefundId as string),
      );

      const unmatchedIds = ctx.stripeRefunds
        .map((r) => r.stripeRefundId)
        .filter((id) => !linked.has(id));

      const allocationIds = input.allocations.map((a) => a.stripeRefundId).sort();
      const expectedIds = [...unmatchedIds].sort();
      if (
        allocationIds.length !== expectedIds.length ||
        allocationIds.some((id, i) => id !== expectedIds[i])
      ) {
        throw Object.assign(
          new Error("Allocations must cover exactly the unmatched historical Stripe refund IDs"),
          { code: "incomplete_allocation" },
        );
      }

      // Dry-run purpose/combined caps for the whole batch before any insert so a
      // mid-batch violation cannot leave a partial allocation in this transaction.
      const simulatedRequests: Array<{
        id: string;
        purpose: RefundPurposeAdmin | "UNSPECIFIED";
        status: string;
        amountCents: number;
      }> = ctx.requests.map((r) => ({
        id: r.id,
        purpose: r.purpose,
        status: r.status,
        amountCents: r.amountCents,
      }));

      const planned: Array<{
        stripeRefundId: string;
        purpose: RefundPurposeAdmin;
        amountCents: number;
      }> = [];

      for (const allocation of input.allocations) {
        const mirror = refundById.get(allocation.stripeRefundId);
        if (!mirror) {
          throw Object.assign(new Error(`Unknown stripeRefundId ${allocation.stripeRefundId}`), {
            code: "invalid_request",
          });
        }

        const alreadyLinked = ctx.requests.some(
          (r) =>
            r.stripeRefundId === allocation.stripeRefundId &&
            (r.status === "SUCCEEDED" || r.status === "PENDING"),
        );
        if (alreadyLinked) {
          throw Object.assign(new Error(`Refund ${allocation.stripeRefundId} already linked`), {
            code: "already_reconciled",
          });
        }

        const availability = computeAuthoritativeRefundAvailability({
          payment: ctx.payment,
          requests: simulatedRequests,
        });
        try {
          assertPurposeRefundFits({
            purpose: allocation.purpose,
            amountCents: mirror.amountCents,
            availability,
          });
        } catch (error) {
          throwNoCapacity(error);
        }

        planned.push({
          stripeRefundId: allocation.stripeRefundId,
          purpose: allocation.purpose,
          amountCents: mirror.amountCents,
        });
        simulatedRequests.push({
          id: `planned:${allocation.stripeRefundId}`,
          purpose: allocation.purpose,
          status: "SUCCEEDED",
          amountCents: mirror.amountCents,
        });
      }

      let created = 0;
      for (const row of planned) {
        await ctx.createSucceededAllocation({
          stripeRefundId: row.stripeRefundId,
          purpose: row.purpose,
          amountCents: row.amountCents,
          clientRequestId: `reconcile:${ctx.payment.id}:${row.stripeRefundId}`,
          initiatedBy: input.initiatedBy,
          notes: evidence,
          evidence,
        });
        created += 1;
      }

      // Absolute counters from all SUCCEEDED requests — same locked transaction as inserts.
      const counters = sumSucceededRefundCounters(ctx.requests);
      await ctx.setCountersAbsolute({
        bookingId: ctx.payment.bookingId,
        rentalRefundedCents: counters.rentalRefundedCents,
        depositRefundedCents: counters.depositRefundedCents,
        refundedAmountCents: counters.refundedAmountCents,
      });

      return {
        reconciledCount: created,
        bookingId: ctx.payment.bookingId,
        alreadyClear: false as const,
        counters,
      };
    });

    if (!result.alreadyClear && result.reconciledCount > 0) {
      await deps.writeAuditLog({
        bookingId: result.bookingId,
        stripePaymentId: input.stripePaymentId,
        action: "refund_reconciled",
        actor: input.initiatedBy,
        newValue: {
          reconciledCount: result.reconciledCount,
          evidence,
          allocations: input.allocations,
          counters: "counters" in result ? result.counters : undefined,
        },
      });
    }

    return { ok: true, reconciledCount: result.reconciledCount };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Reconciliation failed",
      code,
    };
  }
}
