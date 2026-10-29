/**
 * ADMIN terminal-conflict recovery for StripeRefundRequest rows left FAILED/CANCELLED
 * after Stripe later reports a succeeded refund.
 *
 * Never calls Stripe. Validates only against persisted request + StripeRefund mirror evidence.
 * All mutations run under the existing payment FOR UPDATE lock / transaction abstraction.
 */

import { randomUUID } from "node:crypto";

import type { Prisma } from "@/generated/prisma";

import {
  assertPaymentAllocationIntegrity,
  assertPurposeRefundFits,
  computeAuthoritativeRefundAvailability,
  detectHistoricalRefundAmbiguity,
  sumSucceededRefundCounters,
  type PaymentRefundCounters,
  type RefundPurposeAdmin,
} from "./refund-accounting";
import { applyAbsoluteRefundCounters } from "./refund-counter-writer";
import { logRefundOpsEvent } from "./refund-ops-log";
import type { AuditAction, RecoverTerminalRefundInput, RecoverTerminalRefundResult } from "./types";

type PrismaClient = typeof import("@/lib/prisma").prisma;

/** Documented minimum evidence length (matches historical reconcile). */
export const TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH = 8;

type RequestRow = {
  id: string;
  stripePaymentId: string;
  clientRequestId: string;
  purpose: RefundPurposeAdmin | "UNSPECIFIED";
  amountCents: number;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  stripeRefundId: string | null;
  metadata: Record<string, unknown> | null;
};

type MirrorRow = {
  stripeRefundId: string;
  amountCents: number;
  status: string;
  stripePaymentId: string;
};

export type TerminalRecoveryLockContext = {
  payment: PaymentRefundCounters & {
    id: string;
    bookingId: string;
    currency: string;
  };
  requests: RequestRow[];
  mirrors: MirrorRow[];
  updateRequest: (
    id: string,
    data: {
      status?: "SUCCEEDED";
      stripeRefundId?: string;
      purpose?: RefundPurposeAdmin;
      metadata?: Record<string, unknown>;
      notes?: string;
    },
  ) => Promise<RequestRow>;
  upsertMirror: (input: {
    stripeRefundId: string;
    amountCents: number;
    status: string;
    notes: string | null;
    initiatedBy: string;
  }) => Promise<void>;
  setCountersAbsolute: (input: {
    bookingId: string;
    rentalRefundedCents: number;
    depositRefundedCents: number;
    refundedAmountCents: number;
  }) => Promise<void>;
  /** Must participate in the same locked transaction; failures abort recovery. */
  writeAuditLog: (args: {
    action: Extract<AuditAction, "refund_terminal_recovered" | "refund_mirror_repaired">;
    actor: string;
    oldValue: Record<string, unknown>;
    newValue: Record<string, unknown>;
  }) => Promise<void>;
};

export type RecoverTerminalRefundDeps = {
  withPaymentLock: <T>(
    stripePaymentId: string,
    fn: (ctx: TerminalRecoveryLockContext) => Promise<T>,
  ) => Promise<T>;
};

function refundRequestDb(client: PrismaClient) {
  return client as PrismaClient & {
    stripeRefundRequest: {
      findMany: (args: unknown) => Promise<RequestRow[]>;
      update: (args: unknown) => Promise<RequestRow>;
    };
  };
}

function isSucceededMirrorStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "succeeded" || s === "success";
}

function asMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function recoveryMarker(meta: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!meta) return null;
  const marker = meta.terminal_recovery;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  return marker as Record<string, unknown>;
}

function defaultDeps(): RecoverTerminalRefundDeps {
  // Lazy-load Prisma so mocked unit tests can import this module without DATABASE_URL.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require("@/lib/prisma") as typeof import("@/lib/prisma");
  return {
    withPaymentLock: async (stripePaymentId, fn) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "StripePayment" WHERE id = ${stripePaymentId} FOR UPDATE
        `;

        const payment = await tx.stripePayment.findUnique({
          where: { id: stripePaymentId },
          select: {
            id: true,
            bookingId: true,
            currency: true,
            amountCents: true,
            rentalAmountCents: true,
            depositAmountCents: true,
            refundedAmountCents: true,
            rentalRefundedCents: true,
            depositRefundedCents: true,
          },
        });
        if (!payment) {
          throw Object.assign(new Error("Payment not found"), { code: "not_found" });
        }

        const txRr = refundRequestDb(tx as unknown as PrismaClient);
        const rawRequests = await txRr.stripeRefundRequest.findMany({
          where: { stripePaymentId },
        });
        const requests: RequestRow[] = rawRequests.map((r) => ({
          ...r,
          metadata: asMetadata(r.metadata),
        }));

        const mirrors = (await tx.stripeRefund.findMany({
          where: { stripePaymentId },
          select: {
            stripeRefundId: true,
            amountCents: true,
            status: true,
            stripePaymentId: true,
          },
        })) as MirrorRow[];

        return fn({
          payment,
          requests,
          mirrors,
          updateRequest: async (id, data) => {
            const updated = (await txRr.stripeRefundRequest.update({
              where: { id },
              data: {
                ...data,
                metadata: data.metadata ?? undefined,
                updatedAt: new Date(),
              },
            })) as RequestRow;
            const idx = requests.findIndex((r) => r.id === id);
            const normalized: RequestRow = {
              ...updated,
              metadata: asMetadata(updated.metadata) ?? data.metadata ?? null,
            };
            if (idx >= 0) requests[idx] = normalized;
            return normalized;
          },
          upsertMirror: async (input) => {
            await tx.stripeRefund.upsert({
              where: { stripeRefundId: input.stripeRefundId },
              create: {
                id: randomUUID(),
                stripePaymentId,
                stripeRefundId: input.stripeRefundId,
                amountCents: input.amountCents,
                reason: "ADMIN_INITIATED",
                status: input.status,
                initiatedBy: input.initiatedBy,
                notes: input.notes,
                updatedAt: new Date(),
              },
              update: {
                status: input.status,
                notes: input.notes,
                updatedAt: new Date(),
              },
            });
            const existing = mirrors.find((m) => m.stripeRefundId === input.stripeRefundId);
            if (existing) {
              existing.status = input.status;
              existing.amountCents = input.amountCents;
            } else {
              mirrors.push({
                stripeRefundId: input.stripeRefundId,
                amountCents: input.amountCents,
                status: input.status,
                stripePaymentId,
              });
            }
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
          writeAuditLog: async (args) => {
            await tx.paymentAuditLog.create({
              data: {
                id: randomUUID(),
                bookingId: payment.bookingId,
                stripePaymentId,
                action: args.action,
                actor: args.actor,
                oldValue: args.oldValue as Prisma.InputJsonValue,
                newValue: args.newValue as Prisma.InputJsonValue,
              },
            });
          },
        });
      }),
  };
}

/**
 * Terminal recovery retains only an already-typed RENTAL / SECURITY_DEPOSIT purpose.
 * UNSPECIFIED is fail-closed: free-text evidence is attestation, not allocation proof.
 * Use historical reconciliation to allocate unmatched mirrors with explicit purpose.
 */
function resolvePurpose(
  request: RequestRow,
  selected: RefundPurposeAdmin | undefined,
):
  | { ok: true; purpose: RefundPurposeAdmin; purposeDecision: "retained" }
  | { ok: false; error: string; code: string } {
  if (request.purpose === "UNSPECIFIED") {
    return {
      ok: false,
      error:
        "UNSPECIFIED terminal requests cannot be purpose-assigned via recovery; use historical reconciliation with explicit allocations",
      code: "purpose_unspecified_not_recoverable",
    };
  }

  if (request.purpose === "RENTAL" || request.purpose === "SECURITY_DEPOSIT") {
    if (selected && selected !== request.purpose) {
      return {
        ok: false,
        error: `Request purpose ${request.purpose} conflicts with selected purpose ${selected}`,
        code: "purpose_conflict",
      };
    }
    return { ok: true, purpose: request.purpose, purposeDecision: "retained" };
  }

  return { ok: false, error: "Invalid purpose", code: "invalid_purpose" };
}

/** Any other request already linked to this Stripe refund id (all statuses). */
function findConflictingStripeRefundLink(
  requests: RequestRow[],
  targetRequestId: string,
  stripeRefundId: string,
): RequestRow | undefined {
  return requests.find(
    (r) => r.id !== targetRequestId && r.stripeRefundId === stripeRefundId,
  );
}

/**
 * Promote a terminal-conflict FAILED/CANCELLED request to SUCCEEDED using persisted
 * StripeRefund mirror evidence only (no Stripe API).
 */
export async function recoverTerminalRefundRequest(
  input: RecoverTerminalRefundInput,
  deps: RecoverTerminalRefundDeps = defaultDeps(),
): Promise<RecoverTerminalRefundResult> {
  const evidence = input.evidence?.trim() ?? "";
  if (evidence.length < TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH) {
    return {
      ok: false,
      error: `Recovery requires explicit audited evidence (min ${TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH} characters)`,
      code: "evidence_required",
    };
  }

  const stripeRefundId = input.stripeRefundId?.trim() ?? "";
  const requestId = input.requestId?.trim() ?? "";
  if (!stripeRefundId || !requestId) {
    return { ok: false, error: "requestId and stripeRefundId are required", code: "invalid_request" };
  }

  try {
    return await deps.withPaymentLock(input.stripePaymentId, async (ctx) => {
      assertPaymentAllocationIntegrity(ctx.payment);

      if (input.expectedCurrency) {
        const expected = input.expectedCurrency.trim().toLowerCase();
        if (ctx.payment.currency.trim().toLowerCase() !== expected) {
          throw Object.assign(
            new Error(
              `Currency conflict: payment is ${ctx.payment.currency}, expected ${input.expectedCurrency}`,
            ),
            { code: "currency_conflict" },
          );
        }
      }

      const request = ctx.requests.find((r) => r.id === requestId);
      if (!request) {
        throw Object.assign(new Error("Refund request not found on this payment"), {
          code: "not_found",
        });
      }
      if (request.stripePaymentId !== ctx.payment.id) {
        throw Object.assign(new Error("Request does not belong to this payment"), {
          code: "payment_conflict",
        });
      }

      if (
        input.expectedClientRequestId &&
        input.expectedClientRequestId.trim() !== request.clientRequestId
      ) {
        throw Object.assign(new Error("clientRequestId does not match the refund request"), {
          code: "client_request_conflict",
        });
      }

      // Idempotent replay: already recovered / already SUCCEEDED with same Stripe refund.
      if (request.status === "SUCCEEDED") {
        if (request.stripeRefundId !== stripeRefundId) {
          throw Object.assign(
            new Error("Request already SUCCEEDED with a different Stripe refund id"),
            { code: "stripe_refund_mismatch" },
          );
        }

        const conflictOnReplay = findConflictingStripeRefundLink(
          ctx.requests,
          request.id,
          stripeRefundId,
        );
        if (conflictOnReplay) {
          throw Object.assign(
            new Error(`Stripe refund already linked to request ${conflictOnReplay.id}`),
            { code: "stripe_refund_conflict" },
          );
        }

        const purposeResolved = resolvePurpose(request, input.purpose);
        if (!purposeResolved.ok) {
          throw Object.assign(new Error(purposeResolved.error), { code: purposeResolved.code });
        }

        let mirrorRepaired = false;
        const mirror = ctx.mirrors.find((m) => m.stripeRefundId === stripeRefundId);
        if (!mirror) {
          // Secondary mirror gap after durable SUCCEEDED — repair bookkeeping only.
          await ctx.upsertMirror({
            stripeRefundId,
            amountCents: request.amountCents,
            status: "succeeded",
            notes: `mirror_repaired_after_succeeded:${evidence}`,
            initiatedBy: input.initiatedBy,
          });
          mirrorRepaired = true;
          logRefundOpsEvent("refund.db_persist_after_stripe_success", {
            bookingId: ctx.payment.bookingId,
            stripePaymentId: ctx.payment.id,
            requestId: request.id,
            stripeRefundId,
            note: "secondary_mirror_repaired_on_idempotent_recovery",
            amountCents: request.amountCents,
          });
          const repairedAt = new Date().toISOString();
          await ctx.writeAuditLog({
            action: "refund_mirror_repaired",
            actor: input.initiatedBy,
            oldValue: { mirrorPresent: false },
            newValue: {
              kind: "mirror_repair",
              requestId: request.id,
              stripePaymentId: ctx.payment.id,
              stripeRefundId,
              amountCents: request.amountCents,
              purpose: purposeResolved.purpose,
              evidence,
              repairedAt,
              requestStatus: "SUCCEEDED",
            },
          });
        } else if (mirror.amountCents !== request.amountCents) {
          throw Object.assign(new Error("Mirror amount does not match request amount"), {
            code: "amount_mismatch",
          });
        } else if (mirror.stripePaymentId !== ctx.payment.id) {
          throw Object.assign(new Error("Mirror belongs to a different payment"), {
            code: "payment_conflict",
          });
        } else if (!isSucceededMirrorStatus(mirror.status)) {
          const priorMirrorStatus = mirror.status;
          await ctx.upsertMirror({
            stripeRefundId,
            amountCents: request.amountCents,
            status: "succeeded",
            notes: `mirror_status_aligned_on_idempotent_recovery:${evidence}`,
            initiatedBy: input.initiatedBy,
          });
          mirrorRepaired = true;
          const repairedAt = new Date().toISOString();
          await ctx.writeAuditLog({
            action: "refund_mirror_repaired",
            actor: input.initiatedBy,
            oldValue: { mirrorPresent: true, status: priorMirrorStatus },
            newValue: {
              kind: "mirror_status_align",
              requestId: request.id,
              stripePaymentId: ctx.payment.id,
              stripeRefundId,
              amountCents: request.amountCents,
              purpose: purposeResolved.purpose,
              evidence,
              repairedAt,
              requestStatus: "SUCCEEDED",
            },
          });
        }

        // No duplicate financial-success audit on pure replay.
        return {
          ok: true as const,
          requestId: request.id,
          stripeRefundId,
          purpose: purposeResolved.purpose,
          amountCents: request.amountCents,
          idempotent: true,
          mirrorRepaired,
        };
      }

      if (request.status !== "FAILED" && request.status !== "CANCELLED") {
        throw Object.assign(
          new Error(`Request status ${request.status} is not recoverable (need FAILED or CANCELLED)`),
          { code: "not_recoverable_state" },
        );
      }

      if (request.stripeRefundId && request.stripeRefundId !== stripeRefundId) {
        throw Object.assign(
          new Error("Request already linked to a different Stripe refund id"),
          { code: "stripe_refund_mismatch" },
        );
      }

      const mirror = ctx.mirrors.find((m) => m.stripeRefundId === stripeRefundId);
      if (!mirror) {
        throw Object.assign(
          new Error("No persisted StripeRefund mirror evidence for this refund id"),
          { code: "missing_mirror_evidence" },
        );
      }
      if (mirror.stripePaymentId !== ctx.payment.id) {
        throw Object.assign(new Error("Mirror belongs to a different payment"), {
          code: "payment_conflict",
        });
      }
      if (mirror.amountCents !== request.amountCents) {
        throw Object.assign(
          new Error(
            `Amount mismatch: request ${request.amountCents} cents vs mirror ${mirror.amountCents} cents`,
          ),
          { code: "amount_mismatch" },
        );
      }
      if (!isSucceededMirrorStatus(mirror.status)) {
        throw Object.assign(
          new Error(
            `Persisted mirror status "${mirror.status}" is not succeeded — recovery refused`,
          ),
          { code: "insufficient_evidence" },
        );
      }

      const otherLink = findConflictingStripeRefundLink(ctx.requests, request.id, stripeRefundId);
      if (otherLink) {
        throw Object.assign(
          new Error(`Stripe refund already linked to request ${otherLink.id}`),
          { code: "stripe_refund_conflict" },
        );
      }

      const purposeResolved = resolvePurpose(request, input.purpose);
      if (!purposeResolved.ok) {
        throw Object.assign(new Error(purposeResolved.error), { code: purposeResolved.code });
      }

      // Fail-closed on other unmatched / ambiguous history (exclude the mirror we are linking).
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
        stripeRefunds: ctx.mirrors
          .filter((m) => m.stripeRefundId !== stripeRefundId)
          .map((m) => ({ stripeRefundId: m.stripeRefundId, amountCents: m.amountCents })),
        requests: ctx.requests,
      });
      if (ambiguity.ambiguous) {
        throw Object.assign(
          new Error(
            `Payment has unresolved historical refund ambiguity (${ambiguity.reasons.join(",")})`,
          ),
          { code: "needs_reconciliation" },
        );
      }

      // Caps from authoritative SUCCEEDED sums + PENDING — not stale payment counters.
      // Target is FAILED/CANCELLED so it is not in pending or succeeded; exclude id for safety.
      const availability = computeAuthoritativeRefundAvailability({
        payment: ctx.payment,
        requests: ctx.requests,
        excludePendingRequestIds: [request.id],
      });
      try {
        assertPurposeRefundFits({
          purpose: purposeResolved.purpose,
          amountCents: request.amountCents,
          availability,
        });
      } catch (error) {
        throw Object.assign(
          new Error(error instanceof Error ? error.message : "Refund cap exceeded"),
          { code: "cap_exceeded" },
        );
      }

      const prior = {
        status: request.status,
        purpose: request.purpose,
        stripeRefundId: request.stripeRefundId,
        amountCents: request.amountCents,
        clientRequestId: request.clientRequestId,
      };

      const nowIso = new Date().toISOString();
      const nextMetadata: Record<string, unknown> = {
        ...(request.metadata ?? {}),
        terminal_recovery: {
          recoveredAt: nowIso,
          priorStatus: request.status,
          stripeRefundId,
          amountCents: request.amountCents,
          purposeDecision: purposeResolved.purposeDecision,
          purpose: purposeResolved.purpose,
          evidence,
          initiatedBy: input.initiatedBy,
          priorPurpose: request.purpose,
        },
      };

      await ctx.updateRequest(request.id, {
        status: "SUCCEEDED",
        stripeRefundId,
        purpose: purposeResolved.purpose,
        metadata: nextMetadata,
        notes: evidence,
      });

      await ctx.upsertMirror({
        stripeRefundId,
        amountCents: request.amountCents,
        status: "succeeded",
        notes: evidence,
        initiatedBy: input.initiatedBy,
      });

      const counters = sumSucceededRefundCounters(ctx.requests);
      await ctx.setCountersAbsolute({
        bookingId: ctx.payment.bookingId,
        rentalRefundedCents: counters.rentalRefundedCents,
        depositRefundedCents: counters.depositRefundedCents,
        refundedAmountCents: counters.refundedAmountCents,
      });

      await ctx.writeAuditLog({
        action: "refund_terminal_recovered",
        actor: input.initiatedBy,
        oldValue: prior,
        newValue: {
          status: "SUCCEEDED",
          stripeRefundId,
          purpose: purposeResolved.purpose,
          purposeDecision: purposeResolved.purposeDecision,
          amountCents: request.amountCents,
          evidence,
          counters,
          recoveredAt: nowIso,
          priorRecoveryMarker: recoveryMarker(request.metadata),
        },
      });

      return {
        ok: true as const,
        requestId: request.id,
        stripeRefundId,
        purpose: purposeResolved.purpose,
        amountCents: request.amountCents,
        idempotent: false,
        mirrorRepaired: false,
      };
    });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : undefined;
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Terminal recovery failed",
      code,
    };
  }
}

/**
 * Secondary mirror/audit gaps after Stripe success (Stage 3.6):
 * - Authoritative state is StripeRefundRequest.status === SUCCEEDED under the payment lock.
 * - Missing/outdated StripeRefund mirrors are incomplete local bookkeeping, not refund failure.
 * - Idempotent recovery with matching SUCCEEDED evidence may repair the mirror only.
 * - Audit rows written outside the createRefund lock can still be missing; recovery writes its
 *   own atomic audit for terminal promotion, but cannot invent a missing historical success audit
 *   without a schema/outbox change. Ops event refund.db_persist_after_stripe_success remains
 *   the distinguishable signal (maps to refund_persist_incomplete, never refund_failed).
 */
export function describeSecondaryPersistRepairPolicy(): string {
  return "mirror_repair_on_idempotent_succeeded_only_with_refund_mirror_repaired_audit; audit_gap_requires_ops_review_no_auto_stripe_retry; unspecified_terminal_not_recoverable";
}

/** Test/helper: default deps intentionally unused outside production wiring. */
export const __testing = {
  isSucceededMirrorStatus,
  resolvePurpose,
  findConflictingStripeRefundLink,
  TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH,
  defaultDepsUnusedOutsideProd: defaultDeps,
};
