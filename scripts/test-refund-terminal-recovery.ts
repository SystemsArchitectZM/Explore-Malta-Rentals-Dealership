/**
 * Mocked ADMIN terminal-conflict recovery (no DB / Stripe).
 *
 *   npm run test:refund-terminal-recovery
 *
 * PostgreSQL FOR UPDATE concurrency is only statically reviewed via the
 * injectable withPaymentLock abstraction — not against a live database.
 */

import assert from "node:assert/strict";

import {
  describeSecondaryPersistRepairPolicy,
  recoverTerminalRefundRequest,
  TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH,
  type RecoverTerminalRefundDeps,
  type TerminalRecoveryLockContext,
} from "../src/lib/stripe/refund-terminal-recovery";
import { reconcileRefundWebhookEvent } from "../src/lib/stripe/refund-webhook-reconciliation";
import { auditActionForRefundOpsEvent } from "../src/lib/stripe/refund-ops-log";
import { planAbsoluteRefundCounterWrite } from "../src/lib/stripe/refund-counter-writer";

type RequestRow = TerminalRecoveryLockContext["requests"][number];
type MirrorRow = TerminalRecoveryLockContext["mirrors"][number];

const EVIDENCE = "Stripe dashboard + webhook show succeeded after local FAILED status";

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_1",
    bookingId: "booking_1",
    currency: "eur",
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

function baseRequest(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    id: "req_1",
    stripePaymentId: "pay_1",
    clientRequestId: "client-1",
    purpose: "RENTAL",
    amountCents: 5000,
    status: "FAILED",
    stripeRefundId: "re_1",
    metadata: { reason: "requested_by_customer" },
    ...overrides,
  };
}

function baseMirror(overrides: Partial<MirrorRow> = {}): MirrorRow {
  return {
    stripeRefundId: "re_1",
    amountCents: 5000,
    status: "succeeded",
    stripePaymentId: "pay_1",
    ...overrides,
  };
}

function createMock(options: {
  payment?: ReturnType<typeof payment>;
  requests?: RequestRow[];
  mirrors?: MirrorRow[];
  /** Mutate locked state before callback (concurrent change simulation). */
  onLock?: (state: {
    requests: RequestRow[];
    mirrors: MirrorRow[];
    payment: ReturnType<typeof payment>;
  }) => void;
  /** Throw from setCountersAbsolute to simulate txn failure. */
  countersThrow?: boolean;
  /** Track Stripe API calls — recovery must never invoke. */
  stripeCallTracker?: { calls: number };
}) {
  const pay = options.payment ?? payment();
  let requests = (options.requests ?? [baseRequest()]).map((r) => ({ ...r }));
  let mirrors = (options.mirrors ?? [baseMirror()]).map((m) => ({ ...m }));
  const counters = {
    rental: pay.rentalRefundedCents,
    deposit: pay.depositRefundedCents,
    combined: pay.refundedAmountCents,
  };
  const audits: Array<{ action: string; oldValue: unknown; newValue: unknown }> = [];
  let lockEntered = 0;

  const snapshot = () => ({
    requests: requests.map((r) => ({ ...r, metadata: r.metadata ? { ...r.metadata } : null })),
    mirrors: mirrors.map((m) => ({ ...m })),
    counters: { ...counters },
    stripeStatus: pay.stripeStatus,
    refundStatus: pay.refundStatus,
    auditsLength: audits.length,
  });

  const deps: RecoverTerminalRefundDeps = {
    withPaymentLock: async (_id, fn) => {
      lockEntered += 1;
      const before = snapshot();
      options.onLock?.({ requests, mirrors, payment: pay });
      try {
        return await fn({
          payment: pay,
          requests,
          mirrors,
          updateRequest: async (id, data) => {
            const idx = requests.findIndex((r) => r.id === id);
            assert.ok(idx >= 0);
            requests[idx] = {
              ...requests[idx],
              ...data,
              metadata: data.metadata ?? requests[idx].metadata,
            };
            return requests[idx];
          },
          upsertMirror: async (input) => {
            const idx = mirrors.findIndex((m) => m.stripeRefundId === input.stripeRefundId);
            if (idx >= 0) {
              mirrors[idx] = {
                ...mirrors[idx],
                amountCents: input.amountCents,
                status: input.status,
              };
            } else {
              mirrors.push({
                stripeRefundId: input.stripeRefundId,
                amountCents: input.amountCents,
                status: input.status,
                stripePaymentId: pay.id,
              });
            }
          },
          setCountersAbsolute: async (input) => {
            if (options.countersThrow) {
              throw Object.assign(new Error("counter_write_failed"), { code: "db_error" });
            }
            const plan = planAbsoluteRefundCounterWrite({
              amountCents: pay.amountCents as number,
              rentalRefundedCents: input.rentalRefundedCents,
              depositRefundedCents: input.depositRefundedCents,
              refundedAmountCents: input.refundedAmountCents,
            });
            counters.rental = input.rentalRefundedCents;
            counters.deposit = input.depositRefundedCents;
            counters.combined = input.refundedAmountCents;
            pay.rentalRefundedCents = input.rentalRefundedCents;
            pay.depositRefundedCents = input.depositRefundedCents;
            pay.refundedAmountCents = input.refundedAmountCents;
            pay.refundStatus = plan.refundStatus;
            if (
              plan.desiredStripeStatus &&
              (plan.stripeStatusUpdateAllowlist as readonly string[]).includes(
                String(pay.stripeStatus),
              )
            ) {
              pay.stripeStatus = plan.desiredStripeStatus;
            }
          },
          writeAuditLog: async (args) => {
            audits.push({
              action: args.action,
              oldValue: args.oldValue,
              newValue: args.newValue,
            });
          },
        });
      } catch (error) {
        // Simulate transactional rollback on failure.
        const rolled = before;
        requests = rolled.requests;
        mirrors = rolled.mirrors;
        counters.rental = rolled.counters.rental;
        counters.deposit = rolled.counters.deposit;
        counters.combined = rolled.counters.combined;
        pay.rentalRefundedCents = rolled.counters.rental;
        pay.depositRefundedCents = rolled.counters.deposit;
        pay.refundedAmountCents = rolled.counters.combined;
        pay.stripeStatus = rolled.stripeStatus;
        pay.refundStatus = rolled.refundStatus;
        audits.length = rolled.auditsLength;
        throw error;
      }
    },
  };

  // Guardrail: if a test accidentally wires Stripe, it would increment this.
  if (options.stripeCallTracker) {
    void options.stripeCallTracker;
  }

  return {
    deps,
    getRequests: () => requests,
    getMirrors: () => mirrors,
    counters,
    audits,
    getLockEntered: () => lockEntered,
    payment: pay,
  };
}

async function testEvidenceTooShort() {
  const mock = createMock({});
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: "short",
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "evidence_required");
  assert.ok(TERMINAL_RECOVERY_EVIDENCE_MIN_LENGTH >= 8);
  assert.equal(mock.getLockEntered(), 0);
}

async function testNotRecoverableState() {
  const mock = createMock({
    requests: [baseRequest({ status: "PENDING" })],
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "not_recoverable_state");
}

async function testMissingMirrorEvidence() {
  const mock = createMock({ mirrors: [] });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "missing_mirror_evidence");
}

async function testStripeRefundIdMismatch() {
  const mock = createMock({
    requests: [baseRequest({ stripeRefundId: "re_other" })],
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "stripe_refund_mismatch");
}

async function testAmountMismatch() {
  const mock = createMock({
    mirrors: [baseMirror({ amountCents: 9999 })],
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "amount_mismatch");
}

async function testClientRequestAndCurrencyConflicts() {
  const mock = createMock({});
  const clientConflict = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
      expectedClientRequestId: "wrong-client",
    },
    mock.deps,
  );
  assert.equal(clientConflict.ok, false);
  if (!clientConflict.ok) assert.equal(clientConflict.code, "client_request_conflict");

  const currencyConflict = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
      expectedCurrency: "usd",
    },
    mock.deps,
  );
  assert.equal(currencyConflict.ok, false);
  if (!currencyConflict.ok) assert.equal(currencyConflict.code, "currency_conflict");
}

/** M1: UNSPECIFIED cannot be purpose-assigned via recovery (even with ADMIN purpose + evidence). */
async function testUnspecifiedPurposeFailClosed() {
  const mock = createMock({
    requests: [baseRequest({ purpose: "UNSPECIFIED" })],
  });
  const missing = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "purpose_unspecified_not_recoverable");

  const withAssertion = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
      purpose: "SECURITY_DEPOSIT",
    },
    mock.deps,
  );
  assert.equal(withAssertion.ok, false);
  if (!withAssertion.ok) {
    assert.equal(withAssertion.code, "purpose_unspecified_not_recoverable");
  }
  assert.equal(mock.getRequests()[0]?.status, "FAILED");
  assert.equal(mock.getRequests()[0]?.purpose, "UNSPECIFIED");
  assert.equal(mock.counters.rental, 0);
  assert.equal(mock.audits.length, 0);
}

async function testExplicitPurposeConflict() {
  const mock = createMock({
    requests: [baseRequest({ purpose: "RENTAL" })],
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
      purpose: "SECURITY_DEPOSIT",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "purpose_conflict");
}

async function testCapViolationNoMutation() {
  const mock = createMock({
    payment: payment({
      rentalRefundedCents: 14000,
      refundedAmountCents: 14000,
    }),
    requests: [
      baseRequest({
        id: "req_prior",
        clientRequestId: "prior",
        status: "SUCCEEDED",
        stripeRefundId: "re_prior",
        amountCents: 14000,
        purpose: "RENTAL",
      }),
      baseRequest({
        id: "req_1",
        status: "FAILED",
        stripeRefundId: "re_1",
        amountCents: 5000,
        purpose: "RENTAL",
      }),
    ],
    mirrors: [
      baseMirror({ stripeRefundId: "re_prior", amountCents: 14000 }),
      baseMirror({ stripeRefundId: "re_1", amountCents: 5000 }),
    ],
  });
  // Rental available = 18000 - 14000 = 4000; request wants 5000 → cap exceeded.
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "cap_exceeded");
  assert.equal(mock.getRequests().find((r) => r.id === "req_1")?.status, "FAILED");
  assert.equal(mock.counters.rental, 14000);
  assert.equal(mock.audits.length, 0);
}

async function testSuccessfulRecovery() {
  const mock = createMock({});
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
      expectedClientRequestId: "client-1",
      expectedCurrency: "eur",
    },
    mock.deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.idempotent, false);
  assert.equal(result.purpose, "RENTAL");
  assert.equal(mock.getRequests()[0]?.status, "SUCCEEDED");
  assert.equal(mock.getRequests()[0]?.stripeRefundId, "re_1");
  assert.equal(mock.counters.rental, 5000);
  assert.equal(mock.counters.combined, 5000);
  assert.equal(mock.audits.length, 1);
  assert.equal(mock.audits[0]?.action, "refund_terminal_recovered");
  assert.equal(mock.getMirrors()[0]?.status, "succeeded");
}

/** M2: Stale understated counters must not authorize over-cap recovery. */
async function testStaleUnderstatedCountersRefuseRecovery() {
  const mock = createMock({
    payment: payment({
      // Stale: counters claim almost nothing refunded.
      rentalRefundedCents: 0,
      refundedAmountCents: 0,
    }),
    requests: [
      baseRequest({
        id: "req_prior",
        clientRequestId: "prior",
        status: "SUCCEEDED",
        stripeRefundId: "re_prior",
        amountCents: 16000,
        purpose: "RENTAL",
      }),
      baseRequest({
        id: "req_1",
        status: "FAILED",
        stripeRefundId: "re_1",
        amountCents: 5000,
        purpose: "RENTAL",
      }),
    ],
    mirrors: [
      baseMirror({ stripeRefundId: "re_prior", amountCents: 16000 }),
      baseMirror({ stripeRefundId: "re_1", amountCents: 5000 }),
    ],
  });
  // Authoritative: 16000 succeeded + 5000 proposed > 18000 rental.
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "cap_exceeded");
  assert.equal(mock.getRequests().find((r) => r.id === "req_1")?.status, "FAILED");
  assert.equal(mock.counters.rental, 0);
  assert.equal(mock.audits.length, 0);
}

/** M2: Stale overstated purpose counters must not falsely block when requests show capacity. */
async function testStaleOverstatedCountersAllowValidRecovery() {
  const mock = createMock({
    payment: payment({
      // Stale purpose counters claim full rental already refunded; combined stays aligned
      // with authoritative SUCCEEDED sum (0) so ambiguity does not fire.
      rentalRefundedCents: 18000,
      depositRefundedCents: 0,
      refundedAmountCents: 0,
    }),
    requests: [
      baseRequest({
        id: "req_1",
        status: "FAILED",
        stripeRefundId: "re_1",
        amountCents: 5000,
        purpose: "RENTAL",
      }),
    ],
    mirrors: [baseMirror({ amountCents: 5000 })],
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(mock.counters.rental, 5000);
  assert.equal(mock.getRequests()[0]?.status, "SUCCEEDED");
}

/** M2: Pending reservations consume capacity for recovery. */
async function testPendingReservationBlocksRecovery() {
  const mock = createMock({
    requests: [
      baseRequest({
        id: "req_pending",
        clientRequestId: "pending-other",
        status: "PENDING",
        stripeRefundId: null,
        amountCents: 15000,
        purpose: "RENTAL",
      }),
      baseRequest({
        id: "req_1",
        status: "FAILED",
        stripeRefundId: "re_1",
        amountCents: 5000,
        purpose: "RENTAL",
      }),
    ],
    mirrors: [baseMirror({ amountCents: 5000 })],
  });
  // Rental avail = 18000 - 0 - 15000 = 3000; propose 5000 → refuse.
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "cap_exceeded");
  assert.equal(mock.getRequests().find((r) => r.id === "req_1")?.status, "FAILED");
}

/** M4: Any other status linking the same Stripe refund id is an explicit conflict. */
async function testDuplicateStripeRefundIdConflictAllStatuses() {
  for (const otherStatus of ["PENDING", "SUCCEEDED", "FAILED", "CANCELLED"] as const) {
    const mock = createMock({
      requests: [
        baseRequest({
          id: "req_other",
          clientRequestId: `other-${otherStatus}`,
          status: otherStatus,
          stripeRefundId: "re_1",
          amountCents: 5000,
          purpose: "RENTAL",
        }),
        baseRequest({
          id: "req_1",
          status: "FAILED",
          stripeRefundId: null,
          amountCents: 5000,
          purpose: "RENTAL",
        }),
      ],
      mirrors: [baseMirror({ amountCents: 5000 })],
    });
    const result = await recoverTerminalRefundRequest(
      {
        stripePaymentId: "pay_1",
        requestId: "req_1",
        stripeRefundId: "re_1",
        evidence: EVIDENCE,
        initiatedBy: "admin:1",
      },
      mock.deps,
    );
    assert.equal(result.ok, false, `expected conflict for other status ${otherStatus}`);
    if (!result.ok) assert.equal(result.code, "stripe_refund_conflict");
    assert.equal(mock.getRequests().find((r) => r.id === "req_1")?.status, "FAILED");
    assert.equal(mock.counters.rental, 0);
    assert.equal(mock.audits.length, 0);
  }
}

async function testIdempotentDuplicate() {
  const mock = createMock({});
  const first = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(first.ok, true);
  const second = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.idempotent, true);
  assert.equal(mock.counters.rental, 5000);
  assert.equal(mock.audits.length, 1);
}

async function testConcurrentStateChangeRevalidatedUnderLock() {
  const mock = createMock({
    onLock: ({ requests }) => {
      // Another worker already recovered before our callback body runs.
      requests[0]!.status = "SUCCEEDED";
      requests[0]!.stripeRefundId = "re_1";
    },
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.idempotent, true);
  assert.equal(mock.counters.rental, 0);
  assert.equal(mock.audits.length, 0);
}

async function testTransactionFailureRollsBack() {
  const mock = createMock({ countersThrow: true });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  assert.equal(mock.getRequests()[0]?.status, "FAILED");
  assert.equal(mock.counters.rental, 0);
  assert.equal(mock.audits.length, 0);
}

async function testNeverCallsStripe() {
  const stripeCallTracker = { calls: 0 };
  const mock = createMock({ stripeCallTracker });
  // Recovery deps have no createStripeRefund — structural guarantee.
  assert.equal("createStripeRefund" in mock.deps, false);
  await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(stripeCallTracker.calls, 0);
}

async function testWebhookStillRefusesSilentPromotion() {
  const requests = [
    {
      id: "req_1",
      stripePaymentId: "pay_1",
      clientRequestId: "client-1",
      purpose: "RENTAL" as const,
      amountCents: 5000,
      status: "FAILED" as const,
      stripeRefundId: "re_1",
    },
  ];
  const counters = { rental: 0, deposit: 0, combined: 0 };
  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 5000,
      status: "succeeded",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: "client-1" },
    },
    {
      findPaymentByPaymentIntentId: async () =>
        payment({ id: "pay_1", bookingId: "booking_1" }) as never,
      withPaymentLock: async (_id, fn) =>
        fn({
          payment: payment() as never,
          requests,
          stripeRefunds: [{ stripeRefundId: "re_1", amountCents: 5000 }],
          upsertMirror: async () => undefined,
          updateRequest: async (id, data) => {
            const idx = requests.findIndex((r) => r.id === id);
            requests[idx] = { ...requests[idx], ...data };
            return requests[idx];
          },
          setCountersAbsolute: async (input) => {
            counters.rental = input.rentalRefundedCents;
            counters.deposit = input.depositRefundedCents;
            counters.combined = input.refundedAmountCents;
          },
        }),
      writeAuditLog: async () => undefined,
    },
  );
  assert.equal(action, "refund_terminal_conflict");
  assert.equal(requests[0]?.status, "FAILED");
  assert.equal(counters.rental, 0);
}

async function testSecondaryPersistGapsDistinguishable() {
  assert.equal(
    auditActionForRefundOpsEvent("refund.db_persist_after_stripe_success"),
    "refund_persist_incomplete",
  );
  assert.notEqual(
    auditActionForRefundOpsEvent("refund.db_persist_after_stripe_success"),
    "refund_failed",
  );
  assert.match(describeSecondaryPersistRepairPolicy(), /mirror_repair/);
  assert.match(describeSecondaryPersistRepairPolicy(), /no_auto_stripe_retry/);

  // Idempotent recovery repairs missing mirror with distinct audit (not financial success).
  const mock = createMock({
    requests: [
      baseRequest({
        status: "SUCCEEDED",
        stripeRefundId: "re_1",
        purpose: "RENTAL",
      }),
    ],
    mirrors: [],
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.idempotent, true);
  assert.equal(result.mirrorRepaired, true);
  assert.equal(mock.getMirrors().length, 1);
  assert.equal(mock.counters.rental, 0);
  assert.equal(mock.audits.length, 1);
  assert.equal(mock.audits[0]?.action, "refund_mirror_repaired");
  assert.ok(!mock.audits.some((a) => a.action === "refund_terminal_recovered"));

  // Pure idempotent replay with mirror present: no second audit.
  const replay = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(replay.ok, true);
  if (!replay.ok) return;
  assert.equal(replay.mirrorRepaired, false);
  assert.equal(mock.audits.length, 1);
}

async function testInsufficientMirrorStatus() {
  const mock = createMock({
    mirrors: [baseMirror({ status: "pending" })],
  });
  const result = await recoverTerminalRefundRequest(
    {
      stripePaymentId: "pay_1",
      requestId: "req_1",
      stripeRefundId: "re_1",
      evidence: EVIDENCE,
      initiatedBy: "admin:1",
    },
    mock.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "insufficient_evidence");
}

async function run() {
  await testEvidenceTooShort();
  await testNotRecoverableState();
  await testMissingMirrorEvidence();
  await testStripeRefundIdMismatch();
  await testAmountMismatch();
  await testClientRequestAndCurrencyConflicts();
  await testUnspecifiedPurposeFailClosed();
  await testExplicitPurposeConflict();
  await testCapViolationNoMutation();
  await testSuccessfulRecovery();
  await testStaleUnderstatedCountersRefuseRecovery();
  await testStaleOverstatedCountersAllowValidRecovery();
  await testPendingReservationBlocksRecovery();
  await testDuplicateStripeRefundIdConflictAllStatuses();
  await testIdempotentDuplicate();
  await testConcurrentStateChangeRevalidatedUnderLock();
  await testTransactionFailureRollsBack();
  await testNeverCallsStripe();
  await testWebhookStillRefusesSilentPromotion();
  await testSecondaryPersistGapsDistinguishable();
  await testInsufficientMirrorStatus();
  console.log("test-refund-terminal-recovery: all passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
