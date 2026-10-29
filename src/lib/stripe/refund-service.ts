import { randomUUID } from "node:crypto";

import { prisma } from "@/lib/prisma";
import { writePaymentAuditLog } from "./audit-service";
import { stripe } from "./stripe-client";
import {
  assertPurposeRefundFits,
  buildStripeRefundIdempotencyKey,
  computeAuthoritativeRefundAvailability,
  detectHistoricalRefundAmbiguity,
  eurosToCents,
  sumSucceededRefundCounters,
  type LinkedRefundRequest,
  type PaymentRefundCounters,
  type RefundPurposeAdmin,
} from "./refund-accounting";
import {
  evaluatePurposeRefundEligibility,
  evaluateStripeRefundChannelEligibility,
} from "./refund-eligibility";
import {
  auditActionForRefundOpsEvent,
  classifyStripeCreateOutcome,
  logRefundOpsEvent,
} from "./refund-ops-log";
import { applyAbsoluteRefundCounters } from "./refund-counter-writer";
import type { CreateRefundInput, CreateRefundResult } from "./types";

type RefundRequestRow = {
  id: string;
  stripePaymentId: string;
  clientRequestId: string;
  purpose: RefundPurposeAdmin | "UNSPECIFIED";
  amountCents: number;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stripeRefundId: string | null;
  initiatedBy: string | null;
  notes: string | null;
  metadata: Record<string, unknown> | null;
};

type PaymentLockSnapshot = PaymentRefundCounters & {
  id: string;
  bookingId: string;
  stripePaymentIntentId: string | null;
  stripeStatus: string;
  refundStatus: string;
};

export type BookingLockEvidence = {
  status: string;
  depositMethod: string;
  pickupDateTime: Date;
  paymentProofUploadPath: string | null;
  totalDueOnline: number;
  cancelledAt: Date | null;
  statusBeforeCancel: string | null;
};

export type PaymentLockContext = {
  payment: PaymentLockSnapshot;
  /** Booking evidence re-read under the same payment-row lock. */
  booking: BookingLockEvidence | null;
  requests: RefundRequestRow[];
  stripeRefunds: Array<{ stripeRefundId: string; amountCents: number }>;
  createRequest: (row: Omit<RefundRequestRow, "id"> & { id?: string }) => Promise<RefundRequestRow>;
  updateRequest: (
    id: string,
    data: Partial<Pick<RefundRequestRow, "status" | "stripeRefundId" | "metadata" | "notes">>,
  ) => Promise<RefundRequestRow>;
  /** Absolute counter write inside the same locked transaction. */
  setCountersAbsolute: (input: {
    bookingId: string;
    rentalRefundedCents: number;
    depositRefundedCents: number;
    refundedAmountCents: number;
  }) => Promise<void>;
};

export type CreateRefundDeps = {
  withPaymentLock: <T>(
    stripePaymentId: string,
    fn: (ctx: PaymentLockContext) => Promise<T>,
  ) => Promise<T>;
  findPaymentByBookingId: (bookingId: string) => Promise<PaymentLockSnapshot | null>;
  loadBookingEvidence: (bookingId: string) => Promise<BookingLockEvidence | null>;
  createStripeRefund: (input: {
    paymentIntentId: string;
    amountCents: number;
    reason: CreateRefundInput["reason"];
    idempotencyKey: string;
    metadata: Record<string, string>;
  }) => Promise<{ id: string; status: string | null }>;
  upsertStripeRefundMirror: (input: {
    stripePaymentId: string;
    stripeRefundId: string;
    amountCents: number;
    reason: CreateRefundInput["reason"];
    status: string;
    initiatedBy: string;
    notes: string | null;
  }) => Promise<void>;
  writeAuditLog: (args: {
    bookingId: string;
    stripePaymentId?: string;
    action: string;
    actor: string;
    newValue: Record<string, unknown>;
  }) => Promise<unknown>;
};

function mapRefundReason(
  reason: CreateRefundInput["reason"],
): "DUPLICATE" | "FRAUDULENT" | "REQUESTED_BY_CUSTOMER" {
  switch (reason) {
    case "duplicate":
      return "DUPLICATE";
    case "fraudulent":
      return "FRAUDULENT";
    default:
      return "REQUESTED_BY_CUSTOMER";
  }
}

function requestsToLinked(rows: RefundRequestRow[]): LinkedRefundRequest[] {
  return rows.map((r) => ({
    stripeRefundId: r.stripeRefundId,
    purpose: r.purpose,
    status: r.status,
    amountCents: r.amountCents,
  }));
}

function sameMaterialParams(
  existing: RefundRequestRow,
  input: {
    stripePaymentId: string;
    purpose: RefundPurposeAdmin;
    amountCents: number;
    reason: string;
  },
): boolean {
  const metaReason =
    existing.metadata && typeof existing.metadata.reason === "string"
      ? existing.metadata.reason
      : null;
  return (
    existing.stripePaymentId === input.stripePaymentId &&
    existing.purpose === input.purpose &&
    existing.amountCents === input.amountCents &&
    metaReason === input.reason
  );
}

/** Prisma client may lag Stage 1B generate; narrow via any for request model access. */
function refundRequestDb(client: typeof prisma) {
  return client as typeof prisma & {
    stripeRefundRequest: {
      findUnique: (args: unknown) => Promise<RefundRequestRow | null>;
      findMany: (args: unknown) => Promise<RefundRequestRow[]>;
      create: (args: unknown) => Promise<RefundRequestRow>;
      update: (args: unknown) => Promise<RefundRequestRow>;
    };
  };
}

function defaultCreateRefundDeps(): CreateRefundDeps {
  return {
    findPaymentByBookingId: async (bookingId) => {
      const row = await prisma.stripePayment.findUnique({
        where: { bookingId },
        select: {
          id: true,
          bookingId: true,
          stripePaymentIntentId: true,
          stripeStatus: true,
          refundStatus: true,
          amountCents: true,
          rentalAmountCents: true,
          depositAmountCents: true,
          refundedAmountCents: true,
          rentalRefundedCents: true,
          depositRefundedCents: true,
        },
      });
      return row as PaymentLockSnapshot | null;
    },
    loadBookingEvidence: async (bookingId) => {
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        select: {
          status: true,
          depositMethod: true,
          pickupDateTime: true,
          paymentProofUploadPath: true,
          totalDueOnline: true,
          statusHistory: {
            where: { newStatus: "CANCELLED" },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { createdAt: true, oldStatus: true },
          },
        },
      });
      if (!booking) return null;
      const cancelRow = booking.statusHistory[0] ?? null;
      const totalDueOnline =
        typeof booking.totalDueOnline === "number"
          ? booking.totalDueOnline
          : booking.totalDueOnline.toNumber();
      return {
        status: booking.status,
        depositMethod: booking.depositMethod,
        pickupDateTime: booking.pickupDateTime,
        paymentProofUploadPath: booking.paymentProofUploadPath,
        totalDueOnline,
        cancelledAt: cancelRow?.createdAt ?? null,
        statusBeforeCancel: cancelRow?.oldStatus ?? null,
      };
    },
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
            stripePaymentIntentId: true,
            stripeStatus: true,
            refundStatus: true,
            amountCents: true,
            rentalAmountCents: true,
            depositAmountCents: true,
            refundedAmountCents: true,
            rentalRefundedCents: true,
            depositRefundedCents: true,
          },
        })) as PaymentLockSnapshot | null;
        if (!payment) {
          throw new Error("PAYMENT_NOT_FOUND");
        }

        const txRr = refundRequestDb(tx as unknown as typeof prisma);
        const requests = (await txRr.stripeRefundRequest.findMany({
          where: { stripePaymentId },
          orderBy: { createdAt: "asc" },
        })) as RefundRequestRow[];

        const stripeRefunds = await tx.stripeRefund.findMany({
          where: { stripePaymentId },
          select: { stripeRefundId: true, amountCents: true },
        });

        const bookingRow = await tx.booking.findUnique({
          where: { id: payment.bookingId },
          select: {
            status: true,
            depositMethod: true,
            pickupDateTime: true,
            paymentProofUploadPath: true,
            totalDueOnline: true,
            statusHistory: {
              where: { newStatus: "CANCELLED" },
              orderBy: { createdAt: "asc" },
              take: 1,
              select: { createdAt: true, oldStatus: true },
            },
          },
        });
        let booking: BookingLockEvidence | null = null;
        if (bookingRow) {
          const cancelRow = bookingRow.statusHistory[0] ?? null;
          const totalDueOnline =
            typeof bookingRow.totalDueOnline === "number"
              ? bookingRow.totalDueOnline
              : bookingRow.totalDueOnline.toNumber();
          booking = {
            status: bookingRow.status,
            depositMethod: bookingRow.depositMethod,
            pickupDateTime: bookingRow.pickupDateTime,
            paymentProofUploadPath: bookingRow.paymentProofUploadPath,
            totalDueOnline,
            cancelledAt: cancelRow?.createdAt ?? null,
            statusBeforeCancel: cancelRow?.oldStatus ?? null,
          };
        }

        return fn({
          payment,
          booking,
          requests,
          stripeRefunds,
          createRequest: async (row) => {
            const now = new Date();
            return txRr.stripeRefundRequest.create({
              data: {
                id: row.id ?? randomUUID(),
                stripePaymentId: row.stripePaymentId,
                clientRequestId: row.clientRequestId,
                purpose: row.purpose,
                amountCents: row.amountCents,
                status: row.status,
                stripeRefundId: row.stripeRefundId,
                initiatedBy: row.initiatedBy,
                notes: row.notes,
                metadata: row.metadata ?? undefined,
                createdAt: now,
                updatedAt: now,
              },
            }) as Promise<RefundRequestRow>;
          },
          updateRequest: async (id, data) =>
            txRr.stripeRefundRequest.update({
              where: { id },
              data: {
                ...data,
                updatedAt: new Date(),
              },
            }) as Promise<RefundRequestRow>,
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
    createStripeRefund: async (input) => {
      const refund = await stripe.refunds.create(
        {
          payment_intent: input.paymentIntentId,
          amount: input.amountCents,
          reason: input.reason,
          metadata: input.metadata,
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return { id: refund.id, status: refund.status ?? null };
    },
    upsertStripeRefundMirror: async (input) => {
      await prisma.stripeRefund.upsert({
        where: { stripeRefundId: input.stripeRefundId },
        create: {
          id: randomUUID(),
          stripePaymentId: input.stripePaymentId,
          stripeRefundId: input.stripeRefundId,
          amountCents: input.amountCents,
          reason: mapRefundReason(input.reason),
          status: input.status,
          initiatedBy: input.initiatedBy,
          notes: input.notes,
          updatedAt: new Date(),
        },
        update: {
          status: input.status,
          updatedAt: new Date(),
        },
      });
    },
    writeAuditLog: async (args) =>
      writePaymentAuditLog({
        bookingId: args.bookingId,
        stripePaymentId: args.stripePaymentId,
        action: args.action as
          | "refund_initiated"
          | "refund_succeeded"
          | "refund_failed"
          | "refund_pending"
          | "refund_ambiguous"
          | "refund_persist_incomplete"
          | "refund_reconciled",
        actor: args.actor,
        newValue: args.newValue,
      }),
  };
}

type ReserveOutcome = {
  request: RefundRequestRow;
  /** True only when this call inserted a new PENDING reservation. */
  newlyCreated: boolean;
};

/**
 * Purpose-aware Stripe refund: reserve PENDING request under row lock, then call Stripe
 * outside the transaction with stable idempotency.
 *
 * Replay order (under payment row lock):
 *   1. Historical ambiguity → needs_reconciliation (before any success claim)
 *   2. Existing clientRequestId → conflict / return existing (skip new eligibility)
 *   3. New request only → channel + purpose eligibility, caps, create PENDING
 *
 * Pre-lock channel/purpose checks are intentionally omitted so a legitimate replay of a
 * SUCCEEDED request still works after the payment becomes REFUNDED or DISPUTED.
 */
export async function createRefund(
  input: CreateRefundInput,
  deps: CreateRefundDeps = defaultCreateRefundDeps(),
): Promise<CreateRefundResult> {
  const clientRequestId = input.clientRequestId?.trim();
  if (!clientRequestId) {
    return { ok: false, error: "clientRequestId is required", code: "invalid_request" };
  }
  if (input.purpose !== "RENTAL" && input.purpose !== "SECURITY_DEPOSIT") {
    return { ok: false, error: "purpose must be RENTAL or SECURITY_DEPOSIT", code: "invalid_purpose" };
  }

  const payment = await deps.findPaymentByBookingId(input.bookingId);
  if (!payment) {
    return { ok: false, error: "No payment record found for this booking", code: "not_found" };
  }

  const booking = await deps.loadBookingEvidence(input.bookingId);
  if (!booking) {
    return { ok: false, error: "Booking not found for payment", code: "not_found" };
  }

  let amountCents: number;
  try {
    if (input.amountEur == null) {
      // Deferred to lock section once availability is known — placeholder.
      amountCents = 0;
    } else {
      amountCents = eurosToCents(input.amountEur);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid refund amount",
      code: "invalid_amount",
    };
  }

  let reserved: RefundRequestRow;
  let newlyCreated: boolean;
  try {
    const outcome: ReserveOutcome = await deps.withPaymentLock(payment.id, async (ctx) => {
      if (!ctx.booking) {
        throw Object.assign(new Error("Booking not found for payment"), { code: "not_found" });
      }

      // Ambiguity uses authoritative SUCCEEDED purpose sums (Stage 3.9 alignment).
      // Combined takes max(stored, succeeded) so aggregate charge inflation still fail-closes.
      // Must run before any replay that could claim success.
      const succeededForAmbiguity = sumSucceededRefundCounters(ctx.requests);
      const ambiguity = detectHistoricalRefundAmbiguity({
        payment: {
          amountCents: ctx.payment.amountCents,
          rentalAmountCents: ctx.payment.rentalAmountCents,
          depositAmountCents: ctx.payment.depositAmountCents,
          rentalRefundedCents: succeededForAmbiguity.rentalRefundedCents,
          depositRefundedCents: succeededForAmbiguity.depositRefundedCents,
          refundedAmountCents: Math.max(
            ctx.payment.refundedAmountCents,
            succeededForAmbiguity.refundedAmountCents,
          ),
        },
        stripeRefunds: ctx.stripeRefunds,
        requests: requestsToLinked(ctx.requests),
      });
      if (ambiguity.ambiguous) {
        throw Object.assign(new Error("Payment has unresolved historical refund ambiguity"), {
          code: "needs_reconciliation",
        });
      }

      // Idempotent resume: match existing request before eligibility intended for new refunds.
      const existing = ctx.requests.find((r) => r.clientRequestId === clientRequestId);
      if (existing) {
        if (existing.stripePaymentId !== ctx.payment.id) {
          throw Object.assign(
            new Error("clientRequestId already used with different refund parameters"),
            { code: "request_conflict" },
          );
        }
        if (existing.purpose !== input.purpose) {
          throw Object.assign(
            new Error("clientRequestId already used with different refund parameters"),
            { code: "request_conflict" },
          );
        }
        const amountForMatch =
          input.amountEur == null ? existing.amountCents : amountCents;
        if (
          !sameMaterialParams(existing, {
            stripePaymentId: ctx.payment.id,
            purpose: input.purpose,
            amountCents: amountForMatch,
            reason: input.reason,
          })
        ) {
          throw Object.assign(
            new Error("clientRequestId already used with different refund parameters"),
            { code: "request_conflict" },
          );
        }
        return { request: existing, newlyCreated: false };
      }

      // New refund only: channel + purpose eligibility from locked payment/booking.
      const lockedChannel = evaluateStripeRefundChannelEligibility({
        stripeStatus: ctx.payment.stripeStatus,
        stripePaymentIntentId: ctx.payment.stripePaymentIntentId,
        depositMethod: ctx.booking.depositMethod,
        paymentProofUploadPath: ctx.booking.paymentProofUploadPath,
        totalDueOnline: ctx.booking.totalDueOnline,
      });
      if (!lockedChannel.ok) {
        throw Object.assign(new Error(lockedChannel.error), { code: "ineligible" });
      }

      const lockedPurpose = evaluatePurposeRefundEligibility({
        purpose: input.purpose,
        booking: {
          status: ctx.booking.status,
          depositMethod: ctx.booking.depositMethod,
          pickupDateTime: ctx.booking.pickupDateTime,
          cancelledAt: ctx.booking.cancelledAt,
          statusBeforeCancel: ctx.booking.statusBeforeCancel,
        },
      });
      if (!lockedPurpose.ok) {
        throw Object.assign(new Error(lockedPurpose.error), { code: "ineligible" });
      }

      // Caps from SUCCEEDED request sums + PENDING reservations — not stale payment counters.
      const availability = computeAuthoritativeRefundAvailability({
        payment: ctx.payment,
        requests: ctx.requests,
      });

      const resolvedAmount =
        input.amountEur == null
          ? input.purpose === "RENTAL"
            ? availability.rentalAvailableCents
            : availability.depositAvailableCents
          : amountCents;

      if (resolvedAmount <= 0) {
        throw Object.assign(new Error("No remaining refundable amount for this purpose"), {
          code: "no_capacity",
        });
      }

      try {
        assertPurposeRefundFits({
          purpose: input.purpose,
          amountCents: resolvedAmount,
          availability,
        });
      } catch (error) {
        throw Object.assign(
          error instanceof Error ? error : new Error("Refund exceeds available capacity"),
          { code: "no_capacity" },
        );
      }

      try {
        const created = await ctx.createRequest({
          stripePaymentId: ctx.payment.id,
          clientRequestId,
          purpose: input.purpose,
          amountCents: resolvedAmount,
          status: "PENDING",
          stripeRefundId: null,
          initiatedBy: input.initiatedBy,
          notes: input.notes ?? null,
          metadata: {
            reason: input.reason,
            bookingId: input.bookingId,
          },
        });
        return { request: created, newlyCreated: true };
      } catch (error) {
        // Unique clientRequestId race under concurrent callers: re-read under the same lock.
        const prismaCode =
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : null;
        if (prismaCode === "P2002") {
          const raced = ctx.requests.find((r) => r.clientRequestId === clientRequestId);
          if (raced && raced.stripePaymentId === ctx.payment.id) {
            const amountForMatch =
              input.amountEur == null ? raced.amountCents : amountCents;
            if (
              sameMaterialParams(raced, {
                stripePaymentId: ctx.payment.id,
                purpose: input.purpose,
                amountCents: amountForMatch,
                reason: input.reason,
              })
            ) {
              return { request: raced, newlyCreated: false };
            }
          }
          throw Object.assign(
            new Error("clientRequestId already used with different refund parameters"),
            { code: "request_conflict" },
          );
        }
        throw error;
      }
    });
    reserved = outcome.request;
    newlyCreated = outcome.newlyCreated;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to reserve refund",
      code,
    };
  }

  amountCents = reserved.amountCents;

  // Only the first reservation emits refund_initiated — replays must not duplicate it.
  if (newlyCreated) {
    await deps.writeAuditLog({
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      action: "refund_initiated",
      actor: input.initiatedBy,
      newValue: {
        clientRequestId,
        requestId: reserved.id,
        purpose: input.purpose,
        amountCents,
        reason: input.reason,
      },
    });
  }

  // Terminal / in-flight replay — return without calling Stripe again.
  if (reserved.status === "SUCCEEDED") {
    return {
      ok: true,
      status: "succeeded",
      refundId: reserved.stripeRefundId,
      requestId: reserved.id,
      clientRequestId,
      amountEur: amountCents / 100,
      purpose: input.purpose,
    };
  }
  if (reserved.status === "FAILED" || reserved.status === "CANCELLED") {
    return {
      ok: false,
      error: `Refund request is ${reserved.status.toLowerCase()}`,
      code: "request_terminal",
    };
  }
  if (!newlyCreated && reserved.status === "PENDING") {
    return {
      ok: true,
      status: "pending",
      refundId: reserved.stripeRefundId,
      requestId: reserved.id,
      clientRequestId,
      amountEur: amountCents / 100,
      purpose: input.purpose,
    };
  }

  const idempotencyKey = buildStripeRefundIdempotencyKey(payment.id, clientRequestId);

  let stripeResult: { id: string; status: string | null };
  try {
    stripeResult = await deps.createStripeRefund({
      paymentIntentId: payment.stripePaymentIntentId!,
      amountCents,
      reason: input.reason,
      idempotencyKey,
      metadata: {
        bookingId: input.bookingId,
        stripePaymentId: payment.id,
        clientRequestId,
        purpose: input.purpose,
        refundRequestId: reserved.id,
        initiatedBy: input.initiatedBy,
      },
    });
  } catch {
    const opsEvent = classifyStripeCreateOutcome({ kind: "throw" });
    logRefundOpsEvent(opsEvent, {
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      clientRequestId,
      requestId: reserved.id,
      purpose: input.purpose,
      amountCents,
    });
    // Keep PENDING — do not release reservation on ambiguous/network errors.
    await deps.writeAuditLog({
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      action: auditActionForRefundOpsEvent(opsEvent),
      actor: input.initiatedBy,
      newValue: {
        clientRequestId,
        requestId: reserved.id,
        opsEvent,
        note: "stripe_create_ambiguous_timeout_or_network",
      },
    });
    return {
      ok: true,
      status: "pending",
      refundId: reserved.stripeRefundId,
      requestId: reserved.id,
      clientRequestId,
      amountEur: amountCents / 100,
      purpose: input.purpose,
    };
  }

  const stripeStatus = (stripeResult.status ?? "").toLowerCase();

  if (stripeStatus === "failed" || stripeStatus === "canceled" || stripeStatus === "cancelled") {
    const opsEvent = classifyStripeCreateOutcome({ kind: "status", status: stripeStatus });
    try {
      await deps.withPaymentLock(payment.id, async (ctx) => {
        await ctx.updateRequest(reserved.id, {
          status: "FAILED",
          stripeRefundId: stripeResult.id,
        });
      });
    } catch {
      logRefundOpsEvent("refund.stripe_definitive_failure", {
        requestId: reserved.id,
        stripeRefundId: stripeResult.id,
        note: "failed_to_persist_FAILED_status",
      });
    }
    logRefundOpsEvent(opsEvent, {
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      clientRequestId,
      requestId: reserved.id,
      stripeRefundId: stripeResult.id,
      stripeStatus,
    });
    await deps.writeAuditLog({
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      action: auditActionForRefundOpsEvent(opsEvent),
      actor: input.initiatedBy,
      newValue: {
        clientRequestId,
        requestId: reserved.id,
        stripeRefundId: stripeResult.id,
        opsEvent,
      },
    });
    return { ok: false, error: "Stripe refund failed", code: "stripe_failed" };
  }

  if (stripeStatus !== "succeeded") {
    // pending / requires_action / unknown — retain reservation
    const opsEvent = classifyStripeCreateOutcome({ kind: "status", status: stripeStatus });
    try {
      await deps.withPaymentLock(payment.id, async (ctx) => {
        const current = ctx.requests.find((r) => r.id === reserved.id);
        if (current?.status === "SUCCEEDED") return current;
        await ctx.updateRequest(reserved.id, { stripeRefundId: stripeResult.id });
      });
    } catch {
      logRefundOpsEvent(opsEvent, {
        requestId: reserved.id,
        stripeRefundId: stripeResult.id,
        note: "failed_to_attach_stripeRefundId_while_pending",
      });
    }
    logRefundOpsEvent(opsEvent, {
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      clientRequestId,
      requestId: reserved.id,
      stripeRefundId: stripeResult.id,
      stripeStatus,
    });
    await deps.writeAuditLog({
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      action: auditActionForRefundOpsEvent(opsEvent),
      actor: input.initiatedBy,
      newValue: {
        clientRequestId,
        requestId: reserved.id,
        stripeRefundId: stripeResult.id,
        opsEvent,
        stripeStatus,
      },
    });
    return {
      ok: true,
      status: "pending",
      refundId: stripeResult.id,
      requestId: reserved.id,
      clientRequestId,
      amountEur: amountCents / 100,
      purpose: input.purpose,
    };
  }

  // Stripe succeeded — persist request + counters under lock first (authoritative).
  // Mirror/audit are secondary: their failure must not misreport durable SUCCEEDED as pending.
  let durableSucceeded = false;
  try {
    await deps.withPaymentLock(payment.id, async (ctx) => {
      const current = ctx.requests.find((r) => r.id === reserved.id);
      if (!current) {
        throw new Error("Refund request missing after Stripe success");
      }
      if (current.status !== "SUCCEEDED") {
        await ctx.updateRequest(reserved.id, {
          status: "SUCCEEDED",
          stripeRefundId: stripeResult.id,
        });
        current.status = "SUCCEEDED";
        current.stripeRefundId = stripeResult.id;
      }

      const counters = sumSucceededRefundCounters(
        ctx.requests.map((req) =>
          req.id === current.id
            ? { ...req, status: "SUCCEEDED" as const, stripeRefundId: stripeResult.id }
            : req,
        ),
      );
      await ctx.setCountersAbsolute({
        bookingId: input.bookingId,
        rentalRefundedCents: counters.rentalRefundedCents,
        depositRefundedCents: counters.depositRefundedCents,
        refundedAmountCents: counters.refundedAmountCents,
      });
    });
    durableSucceeded = true;
  } catch {
    // Authoritative persist failed or is uncertain — leave PENDING for webhook/retry.
    logRefundOpsEvent("refund.db_persist_after_stripe_success", {
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      clientRequestId,
      requestId: reserved.id,
      stripeRefundId: stripeResult.id,
      purpose: input.purpose,
      amountCents,
      note: "authoritative_request_persist_uncertain",
    });
    try {
      await deps.writeAuditLog({
        bookingId: input.bookingId,
        stripePaymentId: payment.id,
        action: auditActionForRefundOpsEvent("refund.db_persist_after_stripe_success"),
        actor: input.initiatedBy,
        newValue: {
          clientRequestId,
          requestId: reserved.id,
          stripeRefundId: stripeResult.id,
          opsEvent: "refund.db_persist_after_stripe_success",
          note: "authoritative_request_persist_uncertain",
        },
      });
    } catch {
      // Audit must not change financial response.
    }
    return {
      ok: true,
      status: "pending",
      refundId: stripeResult.id,
      requestId: reserved.id,
      clientRequestId,
      amountEur: amountCents / 100,
      purpose: input.purpose,
    };
  }

  try {
    await deps.upsertStripeRefundMirror({
      stripePaymentId: payment.id,
      stripeRefundId: stripeResult.id,
      amountCents,
      reason: input.reason,
      status: "succeeded",
      initiatedBy: input.initiatedBy,
      notes: input.notes ?? null,
    });
  } catch {
    logRefundOpsEvent("refund.db_persist_after_stripe_success", {
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      clientRequestId,
      requestId: reserved.id,
      stripeRefundId: stripeResult.id,
      note: "secondary_mirror_persist_failed_after_succeeded",
    });
  }

  try {
    await deps.writeAuditLog({
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      action: "refund_succeeded",
      actor: input.initiatedBy,
      newValue: {
        clientRequestId,
        requestId: reserved.id,
        stripeRefundId: stripeResult.id,
        purpose: input.purpose,
        amountCents,
        durableSucceeded,
      },
    });
  } catch {
    logRefundOpsEvent("refund.db_persist_after_stripe_success", {
      bookingId: input.bookingId,
      stripePaymentId: payment.id,
      clientRequestId,
      requestId: reserved.id,
      stripeRefundId: stripeResult.id,
      note: "secondary_audit_persist_failed_after_succeeded",
    });
  }

  return {
    ok: true,
    status: "succeeded",
    refundId: stripeResult.id,
    requestId: reserved.id,
    clientRequestId,
    amountEur: amountCents / 100,
    purpose: input.purpose,
  };
}

/**
 * Absolute recompute of purpose + combined counters from SUCCEEDED requests.
 * Prevents double-count when API success and webhook both run.
 */
export async function reconcileSucceededCountersFromRequests(
  stripePaymentId: string,
  bookingId: string,
  deps: Pick<CreateRefundDeps, "withPaymentLock"> = defaultCreateRefundDeps(),
): Promise<void> {
  await deps.withPaymentLock(stripePaymentId, async (ctx) => {
    const counters = sumSucceededRefundCounters(ctx.requests);
    await ctx.setCountersAbsolute({
      bookingId,
      rentalRefundedCents: counters.rentalRefundedCents,
      depositRefundedCents: counters.depositRefundedCents,
      refundedAmountCents: counters.refundedAmountCents,
    });
  });
}
