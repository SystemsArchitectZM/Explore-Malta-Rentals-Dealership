/**
 * Mocked Stripe refund webhook reconciliation (no DB / Stripe).
 *
 *   npm run test:refund-webhook-reconciliation
 */

import assert from "node:assert/strict";

import {
  decideChargeRefundedEffect,
  reconcileRefundWebhookEvent,
  type RefundWebhookDeps,
  type RefundWebhookPaymentRow,
  type RefundWebhookRequestRow,
} from "../src/lib/stripe/refund-webhook-reconciliation";
import { planAbsoluteRefundCounterWrite } from "../src/lib/stripe/refund-counter-writer";

function payment(
  overrides: Partial<RefundWebhookPaymentRow> & { stripeStatus?: string } = {},
): RefundWebhookPaymentRow & { stripeStatus: string; refundStatus?: string } {
  const { stripeStatus, ...rest } = overrides;
  return {
    id: "pay_1",
    bookingId: "booking_1",
    stripePaymentIntentId: "pi_1",
    amountCents: 43000,
    rentalAmountCents: 18000,
    depositAmountCents: 25000,
    refundedAmountCents: 0,
    rentalRefundedCents: 0,
    depositRefundedCents: 0,
    stripeStatus: stripeStatus ?? "SUCCEEDED",
    refundStatus: "NONE",
    ...rest,
  };
}

function createDeps(options: {
  payment: RefundWebhookPaymentRow | null;
  requests?: RefundWebhookRequestRow[];
  stripeRefunds?: Array<{ stripeRefundId: string; amountCents: number }>;
}) {
  const requests = [...(options.requests ?? [])];
  const stripeRefunds = [...(options.stripeRefunds ?? [])];
  const mirrors: string[] = [];
  const audits: Array<{ action: string; note?: string }> = [];
  let counters = {
    rental: options.payment?.rentalRefundedCents ?? 0,
    deposit: options.payment?.depositRefundedCents ?? 0,
    combined: options.payment?.refundedAmountCents ?? 0,
  };

  const deps: RefundWebhookDeps = {
    findPaymentByPaymentIntentId: async () => options.payment,
    withPaymentLock: async (_id, fn) => {
      if (!options.payment) throw new Error("missing payment");
      return fn({
        payment: options.payment,
        requests,
        stripeRefunds,
        upsertMirror: async (input) => {
          mirrors.push(input.stripeRefundId);
          if (!stripeRefunds.some((r) => r.stripeRefundId === input.stripeRefundId)) {
            stripeRefunds.push({
              stripeRefundId: input.stripeRefundId,
              amountCents: input.amountCents,
            });
          }
        },
        updateRequest: async (id, data) => {
          const idx = requests.findIndex((r) => r.id === id);
          assert.ok(idx >= 0);
          requests[idx] = { ...requests[idx], ...data };
        },
        setCountersAbsolute: async (input) => {
          const pay = options.payment as RefundWebhookPaymentRow & {
            stripeStatus: string;
            refundStatus?: string;
          };
          const plan = planAbsoluteRefundCounterWrite({
            amountCents: pay.amountCents,
            rentalRefundedCents: input.rentalRefundedCents,
            depositRefundedCents: input.depositRefundedCents,
            refundedAmountCents: input.refundedAmountCents,
          });
          counters = {
            rental: input.rentalRefundedCents,
            deposit: input.depositRefundedCents,
            combined: input.refundedAmountCents,
          };
          pay.rentalRefundedCents = input.rentalRefundedCents;
          pay.depositRefundedCents = input.depositRefundedCents;
          pay.refundedAmountCents = input.refundedAmountCents;
          pay.refundStatus = plan.refundStatus;
          if (
            plan.desiredStripeStatus &&
            (plan.stripeStatusUpdateAllowlist as readonly string[]).includes(pay.stripeStatus)
          ) {
            pay.stripeStatus = plan.desiredStripeStatus;
          }
        },
      });
    },
    writeAuditLog: async (args) => {
      audits.push({
        action: args.action,
        note: typeof args.newValue.note === "string" ? args.newValue.note : undefined,
      });
    },
  };

  return {
    deps,
    getRequests: () => requests,
    getCounters: () => counters,
    getMirrors: () => mirrors,
    getAudits: () => audits,
  };
}

async function testSucceededLinksByClientRequestId() {
  const mock = createDeps({
    payment: payment(),
    requests: [
      {
        id: "req_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "PENDING",
        stripeRefundId: null,
      },
    ],
  });

  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 5000,
      status: "succeeded",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: "client-1", purpose: "RENTAL" },
    },
    mock.deps,
  );

  assert.equal(action, "refund_marked_succeeded");
  assert.equal(mock.getRequests()[0]?.status, "SUCCEEDED");
  assert.equal(mock.getCounters().rental, 5000);
}

async function testDuplicateWebhookDoesNotDoubleCount() {
  const mock = createDeps({
    payment: payment({ rentalRefundedCents: 5000, refundedAmountCents: 5000 }),
    requests: [
      {
        id: "req_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "SUCCEEDED",
        stripeRefundId: "re_1",
      },
    ],
    stripeRefunds: [{ stripeRefundId: "re_1", amountCents: 5000 }],
  });

  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 5000,
      status: "succeeded",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: "client-1", purpose: "RENTAL" },
    },
    mock.deps,
  );

  assert.equal(action, "refund_already_succeeded");
  assert.equal(mock.getCounters().rental, 5000);
}

async function testLateSuccessAfterFailedDoesNotPromote() {
  const mock = createDeps({
    payment: payment(),
    requests: [
      {
        id: "req_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "FAILED",
        stripeRefundId: null,
      },
    ],
  });

  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 5000,
      status: "succeeded",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: "client-1", purpose: "RENTAL" },
    },
    mock.deps,
  );

  assert.equal(action, "refund_terminal_conflict");
  assert.equal(mock.getRequests()[0]?.status, "FAILED");
  assert.equal(mock.getRequests()[0]?.stripeRefundId, "re_1");
  assert.equal(mock.getCounters().rental, 0);
  assert.ok(
    mock.getAudits().some((a) => a.note === "terminal_state_conflict_succeeded_evidence"),
  );
}

async function testLateSuccessAfterCancelledDoesNotPromote() {
  const mock = createDeps({
    payment: payment(),
    requests: [
      {
        id: "req_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "CANCELLED",
        stripeRefundId: "re_1",
      },
    ],
  });

  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 5000,
      status: "succeeded",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: "client-1" },
    },
    mock.deps,
  );

  assert.equal(action, "refund_terminal_conflict");
  assert.equal(mock.getRequests()[0]?.status, "CANCELLED");
  assert.equal(mock.getCounters().rental, 0);
}

async function testFailedAfterSucceededIgnored() {
  const mock = createDeps({
    payment: payment({ rentalRefundedCents: 5000, refundedAmountCents: 5000 }),
    requests: [
      {
        id: "req_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "SUCCEEDED",
        stripeRefundId: "re_1",
      },
    ],
  });

  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 5000,
      status: "failed",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: "client-1" },
    },
    mock.deps,
  );

  assert.equal(action, "refund_succeeded_ignores_later_failure");
  assert.equal(mock.getRequests()[0]?.status, "SUCCEEDED");
  assert.equal(mock.getCounters().rental, 5000);
}

async function testUnmatchedHistoricalPreserved() {
  const mock = createDeps({
    payment: payment(),
    requests: [],
  });

  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_legacy",
      amountCents: 1000,
      status: "succeeded",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: {},
    },
    mock.deps,
  );

  assert.equal(action, "refund_recorded_unmatched");
  assert.equal(mock.getRequests().length, 0);
  assert.equal(mock.getCounters().rental, 0);
}

async function testFailedMarksRequestFailed() {
  const mock = createDeps({
    payment: payment(),
    requests: [
      {
        id: "req_1",
        clientRequestId: "client-1",
        purpose: "RENTAL",
        amountCents: 5000,
        status: "PENDING",
        stripeRefundId: "re_1",
      },
    ],
  });

  const action = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 5000,
      status: "failed",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: "client-1" },
    },
    mock.deps,
  );

  assert.equal(action, "refund_marked_failed");
  assert.equal(mock.getRequests()[0]?.status, "FAILED");
}

function testChargeRefundedDoesNotAllocatePurpose() {
  const withPurpose = decideChargeRefundedEffect({
    chargeRefundedAmountCents: 10000,
    chargeFullyRefunded: false,
    payment: payment({ rentalRefundedCents: 5000, depositRefundedCents: 0, refundedAmountCents: 5000 }),
    succeededPurposeSumCents: 5000,
    unmatchedStripeRefundIds: [],
  });
  assert.equal(withPurpose.combinedRefundedAmountCents, 5000);
  assert.equal(withPurpose.needsReconciliation, true);
  assert.equal(withPurpose.note, "charge_aggregate_exceeds_purpose_succeeded_sum");
  assert.equal(withPurpose.bookingPaymentStatus, null);

  const unmatched = decideChargeRefundedEffect({
    chargeRefundedAmountCents: 10000,
    chargeFullyRefunded: false,
    payment: payment({ rentalRefundedCents: 0, refundedAmountCents: 0 }),
    succeededPurposeSumCents: 0,
    unmatchedStripeRefundIds: ["re_old"],
  });
  assert.equal(unmatched.needsReconciliation, true);
  assert.equal(unmatched.combinedRefundedAmountCents, 0);
  assert.match(unmatched.note, /unmatched/);
  assert.equal(unmatched.bookingPaymentStatus, null);

  const aligned = decideChargeRefundedEffect({
    chargeRefundedAmountCents: 5000,
    chargeFullyRefunded: false,
    payment: payment({ rentalRefundedCents: 5000, refundedAmountCents: 9999 }),
    succeededPurposeSumCents: 5000,
    unmatchedStripeRefundIds: [],
  });
  // Post-lock purpose sum wins over stale pre-lock combined (9999).
  assert.equal(aligned.combinedRefundedAmountCents, 5000);
  assert.equal(aligned.needsReconciliation, false);
  assert.equal(aligned.bookingPaymentStatus, null);
}

/** H1: Stripe fully refunded + partial purpose success must not mark booking REFUNDED. */
function testChargeFullyRefundedButPurposePartialLeavesBooking() {
  const effect = decideChargeRefundedEffect({
    chargeRefundedAmountCents: 43000,
    chargeFullyRefunded: true,
    payment: payment({
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 0,
      refundedAmountCents: 18000,
    }),
    succeededPurposeSumCents: 18000,
    unmatchedStripeRefundIds: [],
  });
  assert.equal(effect.bookingPaymentStatus, null);
  assert.equal(effect.needsReconciliation, true);
  assert.equal(effect.combinedRefundedAmountCents, 18000);
  assert.equal(effect.stripeStatus, "PARTIALLY_REFUNDED");
  assert.equal(effect.refundStatus, "PARTIAL");
  // Aggregate exceeds purpose sum and/or purpose is partial — either note is fail-closed.
  assert.ok(
    effect.note === "charge_aggregate_exceeds_purpose_succeeded_sum" ||
      effect.note === "charge_refunded_purpose_partial_booking_unchanged",
  );
}

/** H1: Stripe fully refunded + unmatched mirrors must not mark booking REFUNDED. */
function testChargeFullyRefundedWithUnmatchedLeavesBooking() {
  const effect = decideChargeRefundedEffect({
    chargeRefundedAmountCents: 43000,
    chargeFullyRefunded: true,
    payment: payment({ amountCents: 43000, refundedAmountCents: 0 }),
    succeededPurposeSumCents: 0,
    unmatchedStripeRefundIds: ["re_dashboard"],
  });
  assert.equal(effect.bookingPaymentStatus, null);
  assert.equal(effect.needsReconciliation, true);
  assert.match(effect.note, /unmatched/);
}

/** H1: Purpose accounting covers full payment with no conflict → booking REFUNDED. */
function testChargeRefundedAccountingFullMarksBooking() {
  const effect = decideChargeRefundedEffect({
    chargeRefundedAmountCents: 43000,
    chargeFullyRefunded: true,
    payment: payment({
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 25000,
      refundedAmountCents: 43000,
    }),
    succeededPurposeSumCents: 43000,
    unmatchedStripeRefundIds: [],
  });
  assert.equal(effect.bookingPaymentStatus, "REFUNDED");
  assert.equal(effect.needsReconciliation, false);
  assert.equal(effect.stripeStatus, "REFUNDED");
  assert.equal(effect.refundStatus, "FULL");
  assert.equal(effect.combinedRefundedAmountCents, 43000);
  assert.equal(effect.note, "charge_refunded_aligned_to_purpose_succeeded_sum");
}

/**
 * H1: Duplicate charge.refunded decision is idempotent — same inputs yield the same
 * booking/counter effect (no corruption of status or counters).
 */
function testChargeRefundedDecisionIdempotent() {
  const input = {
    chargeRefundedAmountCents: 43000,
    chargeFullyRefunded: true,
    payment: payment({
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 25000,
      refundedAmountCents: 43000,
    }),
    succeededPurposeSumCents: 43000,
    unmatchedStripeRefundIds: [] as string[],
  };
  const first = decideChargeRefundedEffect(input);
  const second = decideChargeRefundedEffect(input);
  assert.deepEqual(first, second);
  assert.equal(first.bookingPaymentStatus, "REFUNDED");
  assert.equal(first.combinedRefundedAmountCents, 43000);

  const partialInput = {
    ...input,
    succeededPurposeSumCents: 18000,
    payment: payment({
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 0,
      refundedAmountCents: 18000,
    }),
  };
  const p1 = decideChargeRefundedEffect(partialInput);
  const p2 = decideChargeRefundedEffect(partialInput);
  assert.deepEqual(p1, p2);
  assert.equal(p1.bookingPaymentStatus, null);
  assert.equal(p1.combinedRefundedAmountCents, 18000);
}

/** Aggregate-only path: never mark booking REFUNDED from charge.refunded alone. */
function testAggregateOnlyNeverMarksBookingRefunded() {
  const effect = decideChargeRefundedEffect({
    chargeRefundedAmountCents: 43000,
    chargeFullyRefunded: true,
    payment: payment({ amountCents: 43000 }),
    succeededPurposeSumCents: 0,
    unmatchedStripeRefundIds: [],
  });
  assert.equal(effect.bookingPaymentStatus, null);
  assert.equal(effect.needsReconciliation, true);
  assert.equal(effect.note, "aggregate_charge_refund_no_purpose_allocation");
}

async function run() {
  await testSucceededLinksByClientRequestId();
  await testDuplicateWebhookDoesNotDoubleCount();
  await testLateSuccessAfterFailedDoesNotPromote();
  await testLateSuccessAfterCancelledDoesNotPromote();
  await testFailedAfterSucceededIgnored();
  await testUnmatchedHistoricalPreserved();
  await testFailedMarksRequestFailed();
  testChargeRefundedDoesNotAllocatePurpose();
  testChargeFullyRefundedButPurposePartialLeavesBooking();
  testChargeFullyRefundedWithUnmatchedLeavesBooking();
  testChargeRefundedAccountingFullMarksBooking();
  testChargeRefundedDecisionIdempotent();
  testAggregateOnlyNeverMarksBookingRefunded();
  console.log("test-refund-webhook-reconciliation: all passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
