/**
 * Mocked reservation-first refund service tests (no DB / Stripe network).
 *
 *   npm run test:refund-service
 *
 * PostgreSQL FOR UPDATE concurrency is only statically reviewed / exercised
 * through the injectable withPaymentLock abstraction — not against a live DB.
 */

import assert from "node:assert/strict";

import type { CreateRefundInput } from "../src/lib/stripe/types";
import { planAbsoluteRefundCounterWrite } from "../src/lib/stripe/refund-counter-writer";

process.env.DATABASE_URL ??= "postgresql://localhost:5432/explore_malta_test_unused";

type CreateRefundDeps = import("../src/lib/stripe/refund-service").CreateRefundDeps;
type PaymentLockContext = import("../src/lib/stripe/refund-service").PaymentLockContext;
type CreateRefundFn = typeof import("../src/lib/stripe/refund-service").createRefund;

type RequestRow = PaymentLockContext["requests"][number];

let createRefund: CreateRefundFn;

function basePayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_1",
    bookingId: "booking_1",
    stripePaymentIntentId: "pi_1",
    stripeStatus: "SUCCEEDED",
    refundStatus: "NONE",
    amountCents: 43000,
    rentalAmountCents: 18000,
    depositAmountCents: 25000,
    refundedAmountCents: 0,
    rentalRefundedCents: 0,
    depositRefundedCents: 0,
    ...overrides,
  };
}

function completedBooking(overrides: Record<string, unknown> = {}) {
  return {
    status: "COMPLETED",
    depositMethod: "ONLINE",
    pickupDateTime: new Date("2026-06-10T10:00:00.000Z"),
    paymentProofUploadPath: null as string | null,
    totalDueOnline: 430,
    cancelledAt: null as Date | null,
    statusBeforeCancel: null as string | null,
    ...overrides,
  };
}

function createMockDeps(options: {
  payment?: ReturnType<typeof basePayment> | null;
  /** Pre-lock booking snapshot (early eligibility). */
  booking?: ReturnType<typeof completedBooking> | null;
  /** Locked booking snapshot; defaults to booking. */
  lockedBooking?: ReturnType<typeof completedBooking> | null;
  /** Locked payment overrides applied when entering withPaymentLock. */
  lockedPaymentPatch?: Record<string, unknown>;
  initialRequests?: RequestRow[];
  stripeRefunds?: Array<{ stripeRefundId: string; amountCents: number }>;
  stripeStatus?: string | null;
  stripeThrows?: boolean;
  /** Throw from upsertStripeRefundMirror after Stripe success. */
  mirrorThrows?: boolean;
  /** Throw from writeAuditLog when action is refund_succeeded. */
  auditThrowsOnSucceeded?: boolean;
  /**
   * Fail the Nth withPaymentLock call (1 = reservation, 2 = post-Stripe persist).
   * Used to simulate authoritative persist uncertainty.
   */
  lockFailOnCall?: number;
}) {
  const payment = options.payment === undefined ? basePayment() : options.payment;
  const booking = options.booking === undefined ? completedBooking() : options.booking;
  const lockedBooking =
    options.lockedBooking === undefined ? booking : options.lockedBooking;
  const requests = [...(options.initialRequests ?? [])];
  const stripeRefunds = [...(options.stripeRefunds ?? [])];
  const counters = { rental: 0, deposit: 0, combined: 0 };
  const audits: string[] = [];
  let stripeCalls = 0;
  let lockCalls = 0;
  let idSeq = 1;
  let mirrorCalls = 0;

  const deps: CreateRefundDeps = {
    findPaymentByBookingId: async () => payment,
    loadBookingEvidence: async () => booking,
    withPaymentLock: async (_id, fn) => {
      lockCalls += 1;
      if (options.lockFailOnCall === lockCalls) {
        throw new Error("lock_unavailable");
      }
      if (payment && options.lockedPaymentPatch) {
        Object.assign(payment, options.lockedPaymentPatch);
      }
      return fn({
        payment: payment!,
        booking: lockedBooking,
        requests,
        stripeRefunds,
        createRequest: async (row) => {
          const created: RequestRow = {
            id: row.id ?? `req_${idSeq++}`,
            stripePaymentId: row.stripePaymentId,
            clientRequestId: row.clientRequestId,
            purpose: row.purpose,
            amountCents: row.amountCents,
            status: row.status,
            stripeRefundId: row.stripeRefundId,
            initiatedBy: row.initiatedBy,
            notes: row.notes,
            metadata: row.metadata,
          };
          requests.push(created);
          return created;
        },
        updateRequest: async (id, data) => {
          const idx = requests.findIndex((r) => r.id === id);
          assert.ok(idx >= 0);
          requests[idx] = { ...requests[idx], ...data };
          return requests[idx];
        },
        setCountersAbsolute: async (input) => {
          counters.rental = input.rentalRefundedCents;
          counters.deposit = input.depositRefundedCents;
          counters.combined = input.refundedAmountCents;
          if (payment) {
            const plan = planAbsoluteRefundCounterWrite({
              amountCents: payment.amountCents as number,
              rentalRefundedCents: input.rentalRefundedCents,
              depositRefundedCents: input.depositRefundedCents,
              refundedAmountCents: input.refundedAmountCents,
            });
            payment.rentalRefundedCents = input.rentalRefundedCents;
            payment.depositRefundedCents = input.depositRefundedCents;
            payment.refundedAmountCents = input.refundedAmountCents;
            payment.refundStatus = plan.refundStatus;
            if (
              plan.desiredStripeStatus &&
              (plan.stripeStatusUpdateAllowlist as readonly string[]).includes(
                String(payment.stripeStatus),
              )
            ) {
              payment.stripeStatus = plan.desiredStripeStatus;
            }
          }
        },
      });
    },
    createStripeRefund: async () => {
      stripeCalls += 1;
      if (options.stripeThrows) {
        throw new Error("network timeout");
      }
      return { id: `re_${stripeCalls}`, status: options.stripeStatus ?? "succeeded" };
    },
    upsertStripeRefundMirror: async () => {
      mirrorCalls += 1;
      if (options.mirrorThrows) {
        throw new Error("mirror_unavailable");
      }
      return undefined;
    },
    writeAuditLog: async (args) => {
      if (options.auditThrowsOnSucceeded && args.action === "refund_succeeded") {
        throw new Error("audit_unavailable");
      }
      audits.push(args.action);
    },
  };

  return {
    deps,
    audits,
    getRequests: () => requests,
    getStripeCalls: () => stripeCalls,
    getMirrorCalls: () => mirrorCalls,
    getLockCalls: () => lockCalls,
    counters,
    payment,
  };
}

const baseInput: CreateRefundInput = {
  bookingId: "booking_1",
  purpose: "RENTAL",
  clientRequestId: "client-1",
  reason: "requested_by_customer",
  initiatedBy: "admin:1",
  amountEur: 50,
};

async function testSuccessfulRentalRefund() {
  const mock = createMockDeps({});
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "succeeded");
  assert.equal(mock.getStripeCalls(), 1);
  assert.equal(mock.counters.rental, 5000);
}

async function testIdempotentSameClientRequestId() {
  const mock = createMockDeps({});
  const first = await createRefund(baseInput, mock.deps);
  assert.equal(first.ok, true);
  const second = await createRefund(baseInput, mock.deps);
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.status, "succeeded");
  assert.equal(mock.getStripeCalls(), 1);
  assert.equal(mock.getRequests().length, 1);
  assert.equal(mock.audits.filter((a) => a === "refund_initiated").length, 1);
}

/** Successful replay while payment remains SUCCEEDED. */
async function testSuccessfulReplayWhileSucceeded() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_ok",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "SUCCEEDED",
        stripeRefundId: "re_ok",
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
    payment: basePayment({ stripeStatus: "SUCCEEDED", rentalRefundedCents: 5000, refundedAmountCents: 5000 }),
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "succeeded");
  assert.equal(result.refundId, "re_ok");
  assert.equal(mock.getStripeCalls(), 0);
  assert.equal(mock.getRequests().length, 1);
  assert.equal(mock.audits.filter((a) => a === "refund_initiated").length, 0);
}

/** Replay after payment counters/status moved to REFUNDED must still return the SUCCEEDED request. */
async function testSuccessfulReplayAfterRefunded() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_full",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 18000,
        status: "SUCCEEDED",
        stripeRefundId: "re_full",
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
    payment: basePayment({
      stripeStatus: "REFUNDED",
      rentalRefundedCents: 18000,
      refundedAmountCents: 18000,
      refundStatus: "FULL",
    }),
  });
  const result = await createRefund(
    { ...baseInput, amountEur: 180, clientRequestId: "client-1" },
    mock.deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "succeeded");
  assert.equal(result.refundId, "re_full");
  assert.equal(mock.getStripeCalls(), 0);
  assert.equal(mock.audits.filter((a) => a === "refund_initiated").length, 0);
}

/** Replay after DISPUTED (no ambiguity) must still return the SUCCEEDED request. */
async function testSuccessfulReplayAfterDisputed() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_disp",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "SUCCEEDED",
        stripeRefundId: "re_disp",
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
    payment: basePayment({
      stripeStatus: "DISPUTED",
      rentalRefundedCents: 5000,
      refundedAmountCents: 5000,
    }),
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "succeeded");
  assert.equal(mock.getStripeCalls(), 0);
}

/** Ambiguity wins over SUCCEEDED replay — must not claim success. */
async function testAmbiguityBlocksSucceededReplay() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 1000 }),
    stripeRefunds: [{ stripeRefundId: "re_orphan", amountCents: 1000 }],
    initialRequests: [
      {
        id: "req_ok",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "SUCCEEDED",
        stripeRefundId: "re_ok",
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "needs_reconciliation");
  assert.equal(mock.getStripeCalls(), 0);
}

/** Failed request remains terminal — no new reservation / Stripe call. */
async function testFailedRequestRemainsTerminal() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_fail",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "FAILED",
        stripeRefundId: "re_fail",
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "request_terminal");
  assert.equal(mock.getRequests().length, 1);
  assert.equal(mock.getStripeCalls(), 0);
  assert.equal(mock.audits.filter((a) => a === "refund_initiated").length, 0);
}

/**
 * Unique-key race: create throws P2002 after another reservation already exists
 * with the same clientRequestId and matching params → treat as replay.
 */
async function testUniqueKeyRaceTreatedAsReplay() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_winner",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "PENDING",
        stripeRefundId: null,
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
  });
  // Force the "existing" lookup to miss once, then create hits unique conflict.
  let findPasses = 0;
  const originalLock = mock.deps.withPaymentLock;
  mock.deps.withPaymentLock = async (id, fn) =>
    originalLock(id, async (ctx) => {
      const realFind = ctx.requests.find.bind(ctx.requests);
      const proxied = new Proxy(ctx.requests, {
        get(target, prop, receiver) {
          if (prop === "find") {
            return (predicate: (r: RequestRow) => boolean) => {
              findPasses += 1;
              if (findPasses === 1) return undefined;
              return realFind(predicate);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const createRequest = async () => {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      };
      return fn({ ...ctx, requests: proxied as RequestRow[], createRequest });
    });

  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "pending");
  assert.equal(result.requestId, "req_winner");
  assert.equal(mock.getStripeCalls(), 0);
  assert.equal(mock.getRequests().length, 1);
}

async function testOmitAmountAfterSucceededUsesStoredAmount() {
  const mock = createMockDeps({});
  const first = await createRefund(baseInput, mock.deps);
  assert.equal(first.ok, true);
  // Capacity now zero for additional rental; omit-amount retry must still resume SUCCEEDED.
  const second = await createRefund(
    { ...baseInput, amountEur: undefined },
    mock.deps,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.status, "succeeded");
  assert.equal(second.amountEur, 50);
  assert.equal(mock.getStripeCalls(), 1);
}

async function testOmitAmountWhilePendingUsesStoredAmount() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_pending",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "PENDING",
        stripeRefundId: null,
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
    stripeStatus: "pending",
  });
  // Another pending ate remaining capacity after original reservation.
  mock.getRequests().push({
    id: "req_other",
    stripePaymentId: "pay_1",
    clientRequestId: "other",
    purpose: "RENTAL",
    amountCents: 13000,
    status: "PENDING",
    stripeRefundId: null,
    initiatedBy: "admin:1",
    notes: null,
    metadata: { reason: "requested_by_customer" },
  });

  const result = await createRefund(
    { ...baseInput, amountEur: undefined },
    mock.deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "pending");
  assert.equal(result.amountEur, 50);
  assert.equal(mock.getRequests().filter((r) => r.clientRequestId === "client-1").length, 1);
}

async function testConflictExplicitAmount() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_existing",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "PENDING",
        stripeRefundId: null,
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
  });
  const result = await createRefund({ ...baseInput, amountEur: 60 }, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "request_conflict");
  assert.equal(mock.getStripeCalls(), 0);
}

async function testConflictPurpose() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_existing",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "SUCCEEDED",
        stripeRefundId: "re_1",
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
  });
  const result = await createRefund(
    { ...baseInput, purpose: "SECURITY_DEPOSIT", amountEur: 50 },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "request_conflict");
}

async function testHistoricalAmbiguityBlocks() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 1000 }),
    stripeRefunds: [{ stripeRefundId: "re_old", amountCents: 1000 }],
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "needs_reconciliation");
}

async function testPendingStripeKeepsReservation() {
  const mock = createMockDeps({ stripeStatus: "pending" });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "pending");
  assert.equal(mock.getRequests()[0]?.status, "PENDING");
}

async function testTimeoutKeepsPending() {
  const mock = createMockDeps({ stripeThrows: true });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "pending");
  assert.ok(mock.audits.includes("refund_ambiguous"));
  assert.ok(!mock.audits.includes("refund_failed"));
}

async function testFailedStripeReleasesReservation() {
  const mock = createMockDeps({ stripeStatus: "failed" });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "stripe_failed");
  assert.equal(mock.getRequests()[0]?.status, "FAILED");
}

async function testDepositRequiresCompletedOrPrePickup() {
  const blocked = createMockDeps({
    booking: completedBooking({ status: "CONFIRMED" }),
  });
  const blockedResult = await createRefund(
    { ...baseInput, purpose: "SECURITY_DEPOSIT", amountEur: 250 },
    blocked.deps,
  );
  assert.equal(blockedResult.ok, false);

  const allowed = createMockDeps({
    booking: completedBooking({
      status: "CANCELLED",
      cancelledAt: new Date("2026-06-09T10:00:00.000Z"),
      statusBeforeCancel: "CONFIRMED",
    }),
  });
  const allowedResult = await createRefund(
    { ...baseInput, purpose: "SECURITY_DEPOSIT", amountEur: 250, clientRequestId: "dep-1" },
    allowed.deps,
  );
  assert.equal(allowedResult.ok, true);
}

async function testAlreadyPaidRejected() {
  const mock = createMockDeps({
    booking: completedBooking({ paymentProofUploadPath: "/proof.jpg" }),
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ineligible");
}

async function testInPersonRejected() {
  const mock = createMockDeps({
    booking: completedBooking({ depositMethod: "IN_PERSON" }),
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ineligible");
}

async function testPendingReservesCapacityAgainstSecondRequest() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_pending",
        stripePaymentId: "pay_1",
        clientRequestId: "other",
        purpose: "RENTAL",
        amountCents: 15000,
        status: "PENDING",
        stripeRefundId: null,
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
  });
  const result = await createRefund(
    { ...baseInput, amountEur: 50, clientRequestId: "client-2" },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_capacity");
}

async function testLockedEligibilityControlsOutcome() {
  // Pre-lock booking looks COMPLETED (eligible), locked booking is CONFIRMED (ineligible for deposit).
  const mock = createMockDeps({
    booking: completedBooking({ status: "COMPLETED" }),
    lockedBooking: completedBooking({ status: "CONFIRMED" }),
  });
  const result = await createRefund(
    { ...baseInput, purpose: "SECURITY_DEPOSIT", amountEur: 250, clientRequestId: "dep-race" },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ineligible");
  assert.equal(mock.getStripeCalls(), 0);
}

async function testLockedPaymentStatusControlsOutcome() {
  const mock = createMockDeps({
    payment: basePayment({ stripeStatus: "SUCCEEDED" }),
    lockedPaymentPatch: { stripeStatus: "PENDING" },
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ineligible");
  assert.equal(mock.getStripeCalls(), 0);
}

/** M1: Mirror failure after durable SUCCEEDED must still report succeeded. */
async function testMirrorFailureAfterDurableSuccessReportsSucceeded() {
  const mock = createMockDeps({ mirrorThrows: true });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "succeeded");
  assert.equal(mock.getRequests()[0]?.status, "SUCCEEDED");
  assert.equal(mock.counters.rental, 5000);
  assert.equal(mock.getMirrorCalls(), 1);
}

/** M1: Audit failure after durable SUCCEEDED must still report succeeded. */
async function testAuditFailureAfterDurableSuccessReportsSucceeded() {
  const mock = createMockDeps({ auditThrowsOnSucceeded: true });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "succeeded");
  assert.equal(mock.getRequests()[0]?.status, "SUCCEEDED");
  assert.equal(mock.counters.rental, 5000);
}

/**
 * M1: When authoritative post-Stripe persist cannot complete (lock unavailable),
 * response stays pending — outcome is genuinely uncertain.
 */
async function testAuthoritativePersistUncertainReportsPending() {
  const mock = createMockDeps({ lockFailOnCall: 2 });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "pending");
  assert.equal(mock.getRequests()[0]?.status, "PENDING");
  assert.equal(mock.getStripeCalls(), 1);
  assert.equal(mock.counters.rental, 0);
}

/**
 * Stage 3.11: Understated stored counters must not authorize over-cap createRefund.
 * SUCCEEDED rental already 16000; counter says 0; propose +5000 → refuse before Stripe.
 */
async function testUnderstatedCountersRefuseOverCapCreateRefund() {
  const mock = createMockDeps({
    payment: basePayment({
      rentalRefundedCents: 0,
      refundedAmountCents: 0,
    }),
    initialRequests: [
      {
        id: "req_prior",
        stripePaymentId: "pay_1",
        clientRequestId: "prior-succeeded",
        purpose: "RENTAL",
        amountCents: 16000,
        status: "SUCCEEDED",
        stripeRefundId: "re_prior",
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
  });
  const beforeCount = mock.getRequests().length;
  const result = await createRefund(
    { ...baseInput, amountEur: 50, clientRequestId: "client-overcap" },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_capacity");
  assert.equal(mock.getStripeCalls(), 0);
  assert.equal(mock.getRequests().length, beforeCount);
  assert.equal(mock.counters.rental, 0);
}

/**
 * Stage 3.11: Overstated purpose counters must not falsely block a valid createRefund
 * when SUCCEEDED requests show remaining capacity (combined stays aligned to avoid ambiguity).
 */
async function testOverstatedCountersAllowValidCreateRefund() {
  const mock = createMockDeps({
    payment: basePayment({
      rentalRefundedCents: 18000,
      depositRefundedCents: 0,
      refundedAmountCents: 0,
    }),
  });
  const result = await createRefund(baseInput, mock.deps);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "succeeded");
  assert.equal(mock.getStripeCalls(), 1);
  assert.equal(mock.counters.rental, 5000);
}

/**
 * Stage 3.11 / Step 7: Idempotent resume of existing PENDING does not create a second
 * reservation or call Stripe again, even when capacity is exhausted by that PENDING row.
 */
async function testIdempotentRetryDoesNotDoubleCountOwnPending() {
  const mock = createMockDeps({
    initialRequests: [
      {
        id: "req_pending",
        stripePaymentId: "pay_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 18000,
        status: "PENDING",
        stripeRefundId: null,
        initiatedBy: "admin:1",
        notes: null,
        metadata: { reason: "requested_by_customer" },
      },
    ],
    stripeStatus: "pending",
  });
  const result = await createRefund(
    { ...baseInput, amountEur: undefined, clientRequestId: "client-1" },
    mock.deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "pending");
  assert.equal(result.amountEur, 180);
  assert.equal(mock.getRequests().length, 1);
  assert.equal(mock.getStripeCalls(), 0);
  assert.equal(mock.audits.filter((a) => a === "refund_initiated").length, 0);
}

/** New requests still fail channel eligibility (e.g. REFUNDED) when no prior request exists. */
async function testNewRefundStillFailsWhenRefunded() {
  const mock = createMockDeps({
    payment: basePayment({ stripeStatus: "REFUNDED" }),
  });
  const result = await createRefund(
    { ...baseInput, clientRequestId: "brand-new" },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "ineligible");
  assert.equal(mock.getStripeCalls(), 0);
  assert.equal(mock.getRequests().length, 0);
}

async function run() {
  ({ createRefund } = await import("../src/lib/stripe/refund-service"));
  await testSuccessfulRentalRefund();
  await testIdempotentSameClientRequestId();
  await testSuccessfulReplayWhileSucceeded();
  await testSuccessfulReplayAfterRefunded();
  await testSuccessfulReplayAfterDisputed();
  await testAmbiguityBlocksSucceededReplay();
  await testFailedRequestRemainsTerminal();
  await testOmitAmountAfterSucceededUsesStoredAmount();
  await testOmitAmountWhilePendingUsesStoredAmount();
  await testConflictExplicitAmount();
  await testConflictPurpose();
  await testHistoricalAmbiguityBlocks();
  await testPendingStripeKeepsReservation();
  await testTimeoutKeepsPending();
  await testFailedStripeReleasesReservation();
  await testDepositRequiresCompletedOrPrePickup();
  await testAlreadyPaidRejected();
  await testInPersonRejected();
  await testPendingReservesCapacityAgainstSecondRequest();
  await testLockedEligibilityControlsOutcome();
  await testLockedPaymentStatusControlsOutcome();
  await testMirrorFailureAfterDurableSuccessReportsSucceeded();
  await testAuditFailureAfterDurableSuccessReportsSucceeded();
  await testAuthoritativePersistUncertainReportsPending();
  await testUnderstatedCountersRefuseOverCapCreateRefund();
  await testOverstatedCountersAllowValidCreateRefund();
  await testIdempotentRetryDoesNotDoubleCountOwnPending();
  await testNewRefundStillFailsWhenRefunded();
  await testUniqueKeyRaceTreatedAsReplay();
  console.log("test-refund-service: all passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
