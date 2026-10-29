/**
 * Pure refund accounting + eligibility tests (no DB / Stripe).
 *
 *   npm run test:refund-accounting
 */

import assert from "node:assert/strict";

import {
  assertPurposeRefundFits,
  assertPositiveIntegerCents,
  buildStripeRefundIdempotencyKey,
  computeAuthoritativeRefundAvailability,
  computeRefundAvailability,
  detectHistoricalRefundAmbiguity,
  eurosToCents,
  sumSucceededRefundCounters,
  type PaymentRefundCounters,
} from "../src/lib/stripe/refund-accounting";
import {
  evaluatePurposeRefundEligibility,
  evaluateStripeRefundChannelEligibility,
} from "../src/lib/stripe/refund-eligibility";

const basePayment: PaymentRefundCounters = {
  amountCents: 43000,
  rentalAmountCents: 18000,
  depositAmountCents: 25000,
  refundedAmountCents: 0,
  rentalRefundedCents: 0,
  depositRefundedCents: 0,
};

function testCapacityAndCaps() {
  const availability = computeRefundAvailability(basePayment, [
    { purpose: "RENTAL", amountCents: 5000, status: "PENDING" },
  ]);
  assert.equal(availability.rentalAvailableCents, 13000);
  assert.equal(availability.depositAvailableCents, 25000);
  assert.equal(availability.combinedAvailableCents, 38000);

  assert.doesNotThrow(() =>
    assertPurposeRefundFits({
      purpose: "RENTAL",
      amountCents: 13000,
      availability,
    }),
  );
  assert.throws(() =>
    assertPurposeRefundFits({
      purpose: "RENTAL",
      amountCents: 13001,
      availability,
    }),
  );
  assert.throws(() =>
    assertPurposeRefundFits({
      purpose: "SECURITY_DEPOSIT",
      amountCents: 25001,
      availability,
    }),
  );
}

/** Deposit-only Checkout: rental allocation 0, deposit 25000. */
function testDepositOnlyRefundCaps() {
  const depositOnly: PaymentRefundCounters = {
    amountCents: 25000,
    rentalAmountCents: 0,
    depositAmountCents: 25000,
    refundedAmountCents: 0,
    rentalRefundedCents: 0,
    depositRefundedCents: 0,
  };
  const availability = computeRefundAvailability(depositOnly, []);
  assert.equal(availability.rentalAvailableCents, 0);
  assert.equal(availability.depositAvailableCents, 25000);
  assert.equal(availability.combinedAvailableCents, 25000);

  assert.throws(() =>
    assertPurposeRefundFits({
      purpose: "RENTAL",
      amountCents: 1,
      availability,
    }),
  );
  assert.doesNotThrow(() =>
    assertPurposeRefundFits({
      purpose: "SECURITY_DEPOSIT",
      amountCents: 25000,
      availability,
    }),
  );
  assert.throws(() =>
    assertPurposeRefundFits({
      purpose: "SECURITY_DEPOSIT",
      amountCents: 25001,
      availability,
    }),
  );
}

function testIntegerValidation() {
  assert.equal(eurosToCents(10.5), 1050);
  assert.throws(() => assertPositiveIntegerCents(0, "x"));
  assert.throws(() => assertPositiveIntegerCents(1.5, "x"));
  assert.throws(() => assertPositiveIntegerCents(Number.NaN, "x"));
}

function testHistoricalAmbiguity() {
  const clear = detectHistoricalRefundAmbiguity({
    payment: basePayment,
    stripeRefunds: [],
    requests: [],
  });
  assert.equal(clear.ambiguous, false);

  const unmatched = detectHistoricalRefundAmbiguity({
    payment: { ...basePayment, refundedAmountCents: 1000, rentalRefundedCents: 0 },
    stripeRefunds: [{ stripeRefundId: "re_old", amountCents: 1000 }],
    requests: [],
  });
  assert.equal(unmatched.ambiguous, true);
  assert.ok(unmatched.reasons.some((r) => r.startsWith("unmatched_stripe_refund:")));
  assert.ok(unmatched.reasons.includes("unallocated_combined_refunded_amount"));
}

function testIdempotencyKey() {
  assert.equal(
    buildStripeRefundIdempotencyKey("pay_1", "req_1"),
    "refund:pay_1:req_1",
  );
}

function testSumSucceededCounters() {
  const sums = sumSucceededRefundCounters([
    { purpose: "RENTAL", status: "SUCCEEDED", amountCents: 5000 },
    { purpose: "SECURITY_DEPOSIT", status: "SUCCEEDED", amountCents: 25000 },
    { purpose: "RENTAL", status: "PENDING", amountCents: 1000 },
    { purpose: "RENTAL", status: "FAILED", amountCents: 2000 },
  ]);
  assert.equal(sums.rentalRefundedCents, 5000);
  assert.equal(sums.depositRefundedCents, 25000);
  assert.equal(sums.refundedAmountCents, 30000);
}

/** Stale payment counters must not drive authoritative availability. */
function testAuthoritativeAvailabilityIgnoresStaleCounters() {
  const understated = computeAuthoritativeRefundAvailability({
    payment: {
      amountCents: 43000,
      rentalAmountCents: 18000,
      depositAmountCents: 25000,
    },
    requests: [
      {
        id: "req_ok",
        purpose: "RENTAL",
        status: "SUCCEEDED",
        amountCents: 10000,
      },
      {
        id: "req_pending",
        purpose: "RENTAL",
        status: "PENDING",
        amountCents: 3000,
      },
    ],
  });
  // Payment counters are not passed — succeeded 10000 + pending 3000 → rental avail 5000.
  assert.equal(understated.rentalAvailableCents, 5000);
  assert.equal(understated.combinedAvailableCents, 30000);

  const withExclude = computeAuthoritativeRefundAvailability({
    payment: {
      amountCents: 43000,
      rentalAmountCents: 18000,
      depositAmountCents: 25000,
    },
    requests: [
      {
        id: "req_terminal",
        purpose: "RENTAL",
        status: "PENDING",
        amountCents: 5000,
      },
    ],
    excludePendingRequestIds: ["req_terminal"],
  });
  assert.equal(withExclude.rentalAvailableCents, 18000);
}

function testChannelAndDepositEligibility() {
  const eligibleBase = {
    stripePaymentIntentId: "pi_1",
    depositMethod: "ONLINE",
  } as const;

  assert.equal(
    evaluateStripeRefundChannelEligibility({
      ...eligibleBase,
      stripeStatus: "SUCCEEDED",
    }).ok,
    true,
  );

  // G1: subsequent refunds remain channel-eligible after a partial refund.
  const partiallyRefunded = evaluateStripeRefundChannelEligibility({
    ...eligibleBase,
    stripeStatus: "PARTIALLY_REFUNDED",
  });
  assert.equal(partiallyRefunded.ok, true);

  for (const stripeStatus of [
    "REFUNDED",
    "DISPUTED",
    "PENDING",
    "PROCESSING",
    "FAILED",
    "CANCELLED",
    "EXPIRED",
    "NOT_A_STATUS",
    "",
  ] as const) {
    const blocked = evaluateStripeRefundChannelEligibility({
      ...eligibleBase,
      stripeStatus,
    });
    assert.equal(blocked.ok, false, `${stripeStatus} must remain channel-ineligible`);
    if (blocked.ok) return;
    assert.equal(blocked.error, `Cannot refund a payment with status: ${stripeStatus}`);
  }

  assert.equal(
    evaluateStripeRefundChannelEligibility({
      ...eligibleBase,
      stripeStatus: "SUCCEEDED",
      paymentProofUploadPath: "/proof.jpg",
    }).ok,
    false,
  );
  assert.equal(
    evaluateStripeRefundChannelEligibility({
      ...eligibleBase,
      stripeStatus: "PARTIALLY_REFUNDED",
      paymentProofUploadPath: "/proof.jpg",
    }).ok,
    false,
  );
  assert.equal(
    evaluateStripeRefundChannelEligibility({
      ...eligibleBase,
      stripeStatus: "SUCCEEDED",
      depositMethod: "IN_PERSON",
    }).ok,
    false,
  );
  assert.equal(
    evaluateStripeRefundChannelEligibility({
      ...eligibleBase,
      stripeStatus: "PARTIALLY_REFUNDED",
      depositMethod: "IN_PERSON",
    }).ok,
    false,
  );
  assert.equal(
    evaluateStripeRefundChannelEligibility({
      stripeStatus: "PARTIALLY_REFUNDED",
      stripePaymentIntentId: null,
      depositMethod: "ONLINE",
    }).ok,
    false,
  );
  assert.equal(
    evaluateStripeRefundChannelEligibility({
      ...eligibleBase,
      stripeStatus: "PARTIALLY_REFUNDED",
      totalDueOnline: 0,
    }).ok,
    false,
  );

  const completed = evaluatePurposeRefundEligibility({
    purpose: "SECURITY_DEPOSIT",
    booking: {
      status: "COMPLETED",
      depositMethod: "ONLINE",
      pickupDateTime: new Date("2026-06-10T10:00:00.000Z"),
      cancelledAt: null,
      statusBeforeCancel: null,
    },
  });
  assert.equal(completed.ok, true);

  const prePickup = evaluatePurposeRefundEligibility({
    purpose: "SECURITY_DEPOSIT",
    booking: {
      status: "CANCELLED",
      depositMethod: "ONLINE",
      pickupDateTime: new Date("2026-06-10T10:00:00.000Z"),
      cancelledAt: new Date("2026-06-09T10:00:00.000Z"),
      statusBeforeCancel: "CONFIRMED",
    },
  });
  assert.equal(prePickup.ok, true);

  const postPickup = evaluatePurposeRefundEligibility({
    purpose: "SECURITY_DEPOSIT",
    booking: {
      status: "CANCELLED",
      depositMethod: "ONLINE",
      pickupDateTime: new Date("2026-06-10T10:00:00.000Z"),
      cancelledAt: new Date("2026-06-11T10:00:00.000Z"),
      statusBeforeCancel: "CONFIRMED",
    },
  });
  assert.equal(postPickup.ok, false);

  const unconfirmed = evaluatePurposeRefundEligibility({
    purpose: "SECURITY_DEPOSIT",
    booking: {
      status: "CANCELLED",
      depositMethod: "ONLINE",
      pickupDateTime: new Date("2026-06-10T10:00:00.000Z"),
      cancelledAt: new Date("2026-06-09T10:00:00.000Z"),
      statusBeforeCancel: "PENDING_PAYMENT",
    },
  });
  assert.equal(unconfirmed.ok, false);

  const missingCancelTime = evaluatePurposeRefundEligibility({
    purpose: "SECURITY_DEPOSIT",
    booking: {
      status: "CANCELLED",
      depositMethod: "ONLINE",
      pickupDateTime: new Date("2026-06-10T10:00:00.000Z"),
      cancelledAt: null,
      statusBeforeCancel: "CONFIRMED",
    },
  });
  assert.equal(missingCancelTime.ok, false);
}

function main() {
  testCapacityAndCaps();
  testDepositOnlyRefundCaps();
  testIntegerValidation();
  testHistoricalAmbiguity();
  testIdempotencyKey();
  testSumSucceededCounters();
  testAuthoritativeAvailabilityIgnoresStaleCounters();
  testChannelAndDepositEligibility();
  console.log("test-refund-accounting: all passed");
}

main();
