/**
 * Mocked historical refund reconciliation — allocations, purpose caps, and
 * counters update inside one withPaymentLock callback (no post-commit counter helper).
 *
 * Does not prove real PostgreSQL locking.
 *
 *   npm run test:refund-reconciliation
 */

import assert from "node:assert/strict";

import { planAbsoluteRefundCounterWrite } from "../src/lib/stripe/refund-counter-writer";
import { detectHistoricalRefundAmbiguity } from "../src/lib/stripe/refund-accounting";

// Satisfy prisma module load; tests never query the database.
process.env.DATABASE_URL ??= "postgresql://localhost:5432/explore_malta_test_unused";

type ReconcileHistoricalRefundsDeps =
  import("../src/lib/stripe/refund-reconciliation").ReconcileHistoricalRefundsDeps;
type ReconcilePaymentLockContext =
  import("../src/lib/stripe/refund-reconciliation").ReconcilePaymentLockContext;
type ReconcileFn = typeof import("../src/lib/stripe/refund-reconciliation").reconcileHistoricalRefunds;

type RequestRow = ReconcilePaymentLockContext["requests"][number];

let reconcileHistoricalRefunds: ReconcileFn;

function basePayment(
  overrides: Partial<ReconcilePaymentLockContext["payment"]> & {
    stripeStatus?: string;
    refundStatus?: string;
  } = {},
) {
  return {
    id: "pay_1",
    bookingId: "booking_1",
    amountCents: 43000,
    rentalAmountCents: 18000,
    depositAmountCents: 25000,
    refundedAmountCents: 0,
    rentalRefundedCents: 0,
    depositRefundedCents: 0,
    stripeStatus: "SUCCEEDED",
    refundStatus: "NONE",
    ...overrides,
  };
}

function createMockDeps(options: {
  payment: ReturnType<typeof basePayment>;
  requests?: RequestRow[];
  stripeRefunds: Array<{ stripeRefundId: string; amountCents: number }>;
  /** Simulate lock/persistence failure after validation (should not report success). */
  failOnCreate?: boolean;
}) {
  const requests = [...(options.requests ?? [])];
  const stripeRefunds = [...options.stripeRefunds];
  let countersWrittenInsideLock = false;
  const counterSnapshots: Array<{ rental: number; deposit: number; combined: number }> = [];
  const sequence: string[] = [];
  let createCalls = 0;
  let inLock = false;

  const deps: ReconcileHistoricalRefundsDeps = {
    withPaymentLock: async (_id, fn) => {
      assert.equal(inLock, false, "nested withPaymentLock is not supported");
      inLock = true;
      countersWrittenInsideLock = false;
      try {
        const result = await fn({
          payment: options.payment,
          requests,
          stripeRefunds,
          createSucceededAllocation: async (row) => {
            createCalls += 1;
            if (options.failOnCreate) {
              throw Object.assign(new Error("persist_failed"), { code: "persist_failed" });
            }
            sequence.push(`alloc:${row.stripeRefundId}`);
            assert.equal(
              countersWrittenInsideLock,
              false,
              "counters must not be written before allocations finish",
            );
            const created: RequestRow = {
              id: `req_${row.stripeRefundId}`,
              stripePaymentId: options.payment.id,
              clientRequestId: row.clientRequestId,
              purpose: row.purpose,
              amountCents: row.amountCents,
              status: "SUCCEEDED",
              stripeRefundId: row.stripeRefundId,
            };
            requests.push(created);
            return created;
          },
          setCountersAbsolute: async (input) => {
            sequence.push("counters");
            countersWrittenInsideLock = true;
            assert.equal(inLock, true, "counters must be written while lock is held");
            counterSnapshots.push({
              rental: input.rentalRefundedCents,
              deposit: input.depositRefundedCents,
              combined: input.refundedAmountCents,
            });
            const plan = planAbsoluteRefundCounterWrite({
              amountCents: options.payment.amountCents,
              rentalRefundedCents: input.rentalRefundedCents,
              depositRefundedCents: input.depositRefundedCents,
              refundedAmountCents: input.refundedAmountCents,
            });
            options.payment.rentalRefundedCents = input.rentalRefundedCents;
            options.payment.depositRefundedCents = input.depositRefundedCents;
            options.payment.refundedAmountCents = input.refundedAmountCents;
            options.payment.refundStatus = plan.refundStatus;
            const currentStatus = options.payment.stripeStatus ?? "SUCCEEDED";
            if (
              plan.desiredStripeStatus &&
              (plan.stripeStatusUpdateAllowlist as readonly string[]).includes(currentStatus)
            ) {
              options.payment.stripeStatus = plan.desiredStripeStatus;
            }
          },
        });
        sequence.push("commit");
        return result;
      } finally {
        inLock = false;
      }
    },
    writeAuditLog: async () => undefined,
  };

  return {
    deps,
    getSequence: () => sequence,
    getCounters: () => counterSnapshots,
    getRequests: () => requests,
    getCreateCalls: () => createCalls,
    wasCountersWrittenInsideLock: () => countersWrittenInsideLock,
    payment: options.payment,
  };
}

async function testValidHistoricalRentalWithinCap() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 1000 }),
    stripeRefunds: [{ stripeRefundId: "re_old", amountCents: 1000 }],
    requests: [],
  });

  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Matched to rental from Stripe dashboard notes",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_old", purpose: "RENTAL" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reconciledCount, 1);
  assert.deepEqual(mock.getSequence(), ["alloc:re_old", "counters", "commit"]);
  assert.deepEqual(mock.getCounters()[0], { rental: 1000, deposit: 0, combined: 1000 });
  assert.equal(mock.getRequests()[0]?.purpose, "RENTAL");
}

async function testValidHistoricalDepositWithinCap() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 25000 }),
    stripeRefunds: [{ stripeRefundId: "re_dep", amountCents: 25000 }],
    requests: [],
  });

  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Deposit refund confirmed in Stripe Dashboard",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_dep", purpose: "SECURITY_DEPOSIT" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.reconciledCount, 1);
  assert.deepEqual(mock.getCounters()[0], { rental: 0, deposit: 25000, combined: 25000 });
  assert.ok(mock.getSequence().indexOf("counters") < mock.getSequence().indexOf("commit"));
}

async function testRentalAllocationExceedsRentalCap() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 20000 }),
    stripeRefunds: [{ stripeRefundId: "re_big", amountCents: 20000 }],
    requests: [],
  });
  const before = mock.getRequests().length;

  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Attempted over-cap rental allocation",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_big", purpose: "RENTAL" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_capacity");
  assert.equal(mock.getCreateCalls(), 0);
  assert.equal(mock.getRequests().length, before);
  assert.equal(mock.getCounters().length, 0);
}

async function testDepositAllocationExceedsDepositCap() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 26000 }),
    stripeRefunds: [{ stripeRefundId: "re_dep_big", amountCents: 26000 }],
    requests: [],
  });

  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Attempted over-cap deposit allocation",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_dep_big", purpose: "SECURITY_DEPOSIT" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_capacity");
  assert.equal(mock.getCreateCalls(), 0);
  assert.equal(mock.getRequests().length, 0);
}

async function testCombinedAllocationsExceedTotalPayment() {
  // UNSPECIFIED PENDING reduces combined capacity without reducing purpose caps,
  // so a batch can fit each purpose yet fail the combined check.
  const mock = createMockDeps({
    payment: basePayment({
      refundedAmountCents: 30000,
    }),
    stripeRefunds: [
      { stripeRefundId: "re_a", amountCents: 18000 },
      { stripeRefundId: "re_b", amountCents: 12000 },
    ],
    requests: [
      {
        id: "req_unspec_pending",
        stripePaymentId: "pay_1",
        clientRequestId: "unspec-pend",
        purpose: "UNSPECIFIED",
        amountCents: 20000,
        status: "PENDING",
        stripeRefundId: null,
      },
    ],
  });

  // After rental 18000, combined remaining vs UNSPECIFIED pending 20000 is 5000;
  // deposit 12000 exceeds combined.
  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Batch exceeds combined capacity under unspecified pending",
      initiatedBy: "admin:1",
      allocations: [
        { stripeRefundId: "re_a", purpose: "RENTAL" },
        { stripeRefundId: "re_b", purpose: "SECURITY_DEPOSIT" },
      ],
    },
    mock.deps,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_capacity");
  assert.equal(mock.getCreateCalls(), 0);
  assert.equal(mock.getRequests().length, 1);
}

async function testExistingSucceededAndPendingReduceCapacity() {
  const mock = createMockDeps({
    payment: basePayment({
      refundedAmountCents: 8000,
      rentalRefundedCents: 5000,
    }),
    stripeRefunds: [
      { stripeRefundId: "re_prior", amountCents: 5000 },
      { stripeRefundId: "re_new", amountCents: 8000 },
    ],
    requests: [
      {
        id: "req_ok",
        stripePaymentId: "pay_1",
        clientRequestId: "prior",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "SUCCEEDED",
        stripeRefundId: "re_prior",
      },
      {
        id: "req_pend",
        stripePaymentId: "pay_1",
        clientRequestId: "pend",
        purpose: "RENTAL",
        amountCents: 10000,
        status: "PENDING",
        stripeRefundId: null,
      },
    ],
  });

  // Rental remaining after succeeded 5000 + pending 10000 = 3000 available; 8000 fails.
  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Must respect prior succeeded and pending capacity",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_new", purpose: "RENTAL" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_capacity");
  assert.equal(mock.getCreateCalls(), 0);
  assert.equal(mock.getRequests().length, 2);
}

async function testAmbiguousRemainsUnresolvedWithoutGuessing() {
  const payment = basePayment({ refundedAmountCents: 1000 });
  const stripeRefunds = [{ stripeRefundId: "re_orphan", amountCents: 1000 }];
  const ambiguity = detectHistoricalRefundAmbiguity({
    payment,
    stripeRefunds,
    requests: [],
  });
  assert.equal(ambiguity.ambiguous, true);
  assert.ok(ambiguity.reasons.some((r) => r.startsWith("unmatched_stripe_refund:")));

  // Incomplete cover keeps unresolved — no purpose guess for the orphan.
  const mock = createMockDeps({
    payment,
    stripeRefunds: [
      { stripeRefundId: "re_orphan", amountCents: 1000 },
      { stripeRefundId: "re_other", amountCents: 500 },
    ],
    requests: [],
  });
  // payment refundedAmount only 1000 but two mirrors — adjust for integrity of ambiguity path
  mock.payment.refundedAmountCents = 1500;

  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Only covering one of two unmatched refunds",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_orphan", purpose: "RENTAL" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "incomplete_allocation");
  assert.equal(mock.getCreateCalls(), 0);
}

async function testReplayDoesNotDoubleAllocate() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 1000 }),
    stripeRefunds: [{ stripeRefundId: "re_old", amountCents: 1000 }],
    requests: [],
  });

  const first = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "First reconciliation pass",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_old", purpose: "RENTAL" }],
    },
    mock.deps,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.reconciledCount, 1);
  assert.equal(mock.getRequests().length, 1);

  const second = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Replay after already clear",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_old", purpose: "RENTAL" }],
    },
    mock.deps,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.reconciledCount, 0);
  assert.equal(mock.getRequests().length, 1);
  assert.equal(mock.getCreateCalls(), 1);
}

async function testCapViolationDoesNotPartialPersist() {
  const mock = createMockDeps({
    payment: basePayment({
      refundedAmountCents: 30000,
    }),
    stripeRefunds: [
      { stripeRefundId: "re_ok", amountCents: 10000 },
      { stripeRefundId: "re_over", amountCents: 20000 },
    ],
    requests: [],
  });

  // First rental 10000 fits; second rental 20000 exceeds remaining 8000 — fail before any create.
  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Second allocation over remaining rental capacity",
      initiatedBy: "admin:1",
      allocations: [
        { stripeRefundId: "re_ok", purpose: "RENTAL" },
        { stripeRefundId: "re_over", purpose: "RENTAL" },
      ],
    },
    mock.deps,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "no_capacity");
  assert.equal(mock.getCreateCalls(), 0);
  assert.equal(mock.getRequests().length, 0);
  assert.equal(mock.getCounters().length, 0);
}

async function testLegacyZeroDepositCannotAllocateDeposit() {
  const mock = createMockDeps({
    payment: basePayment({
      amountCents: 18000,
      rentalAmountCents: 18000,
      depositAmountCents: 0,
      refundedAmountCents: 5000,
    }),
    stripeRefunds: [{ stripeRefundId: "re_legacy", amountCents: 5000 }],
    requests: [],
  });

  const depositAttempt = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Legacy zero-deposit cannot take deposit purpose",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_legacy", purpose: "SECURITY_DEPOSIT" }],
    },
    mock.deps,
  );
  assert.equal(depositAttempt.ok, false);
  if (!depositAttempt.ok) {
    assert.equal(depositAttempt.code, "no_capacity");
  }
  assert.equal(mock.getCreateCalls(), 0);

  const rentalOk = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Legacy rental-only payment allocates to rental",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_legacy", purpose: "RENTAL" }],
    },
    mock.deps,
  );
  assert.equal(rentalOk.ok, true);
  if (!rentalOk.ok) return;
  assert.equal(rentalOk.reconciledCount, 1);
  assert.equal(mock.getRequests()[0]?.purpose, "RENTAL");
}

async function testPersistFailureDoesNotReportSuccess() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 1000 }),
    stripeRefunds: [{ stripeRefundId: "re_old", amountCents: 1000 }],
    requests: [],
    failOnCreate: true,
  });

  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Valid caps but persistence fails",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_old", purpose: "RENTAL" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, "persist_failed");
  assert.equal(mock.getRequests().length, 0);
  assert.equal(mock.getCounters().length, 0);
}

async function testAtomicAllocationAndCounters() {
  const mock = createMockDeps({
    payment: basePayment({ refundedAmountCents: 1000 }),
    stripeRefunds: [{ stripeRefundId: "re_old", amountCents: 1000 }],
    requests: [],
  });

  const result = await reconcileHistoricalRefunds(
    {
      stripePaymentId: "pay_1",
      evidence: "Matched to rental from Stripe dashboard notes",
      initiatedBy: "admin:1",
      allocations: [{ stripeRefundId: "re_old", purpose: "RENTAL" }],
    },
    mock.deps,
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(mock.getSequence(), ["alloc:re_old", "counters", "commit"]);
  assert.equal(mock.wasCountersWrittenInsideLock(), true);
}

async function run() {
  ({ reconcileHistoricalRefunds } = await import("../src/lib/stripe/refund-reconciliation"));
  await testValidHistoricalRentalWithinCap();
  await testValidHistoricalDepositWithinCap();
  await testRentalAllocationExceedsRentalCap();
  await testDepositAllocationExceedsDepositCap();
  await testCombinedAllocationsExceedTotalPayment();
  await testExistingSucceededAndPendingReduceCapacity();
  await testAmbiguousRemainsUnresolvedWithoutGuessing();
  await testReplayDoesNotDoubleAllocate();
  await testCapViolationDoesNotPartialPersist();
  await testLegacyZeroDepositCannotAllocateDeposit();
  await testPersistFailureDoesNotReportSuccess();
  await testAtomicAllocationAndCounters();
  console.log("test-refund-reconciliation: all passed");
  console.log(
    "Note: real PostgreSQL FOR UPDATE races are not simulated; only the app transaction boundary is asserted.",
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
