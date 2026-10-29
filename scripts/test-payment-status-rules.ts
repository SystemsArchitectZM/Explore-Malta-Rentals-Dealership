/**
 * Pure Stripe payment-status rule tests (no DB / Stripe).
 *
 *   npm run test:payment-status-rules
 */

import assert from "node:assert/strict";

import {
  CONFIRMATION_ELIGIBLE_STRIPE_PAYMENT_STATUSES,
  PAID_LINEAGE_STRIPE_PAYMENT_STATUSES,
  REFUND_ELIGIBLE_STRIPE_PAYMENT_STATUSES,
  REFUND_PRESERVABLE_STRIPE_PAYMENT_STATUSES,
  STRIPE_PAYMENT_STATUSES,
  UNPAID_STRIPE_PAYMENT_STATUSES,
  deriveRefundStripeStatus,
  CHECKOUT_EXPIRY_WRITABLE_STRIPE_PAYMENT_STATUSES,
  isCheckoutExpiryWritableStripePaymentStatus,
  isConfirmationEligibleStripePaymentStatus,
  isPaidLineageStripePaymentStatus,
  isRefundEligibleStripePaymentStatus,
  isRefundPreservableStripePaymentStatus,
  isUnpaidStripePaymentStatus,
  shouldReleaseBookingAfterUnpaidTerminalWrite,
  unpaidTerminalWritableStripeStatusFilter,
} from "../src/lib/stripe/payment-status-rules";

function testPaidLineageRecognizesAllFour() {
  for (const status of ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"] as const) {
    assert.equal(
      isPaidLineageStripePaymentStatus(status),
      true,
      `${status} must be paid lineage`,
    );
  }
  assert.equal(PAID_LINEAGE_STRIPE_PAYMENT_STATUSES.length, 4);
}

function testUnpaidAreNotPaidLineage() {
  for (const status of UNPAID_STRIPE_PAYMENT_STATUSES) {
    assert.equal(
      isPaidLineageStripePaymentStatus(status),
      false,
      `${status} must not be paid lineage`,
    );
    assert.equal(isUnpaidStripePaymentStatus(status), true);
  }
  assert.equal(isPaidLineageStripePaymentStatus("NOT_A_STATUS"), false);
  assert.equal(isUnpaidStripePaymentStatus("NOT_A_STATUS"), false);
  assert.equal(isUnpaidStripePaymentStatus("SUCCEEDED"), false);
}

function testRefundEligibleAllowlist() {
  assert.equal(isRefundEligibleStripePaymentStatus("SUCCEEDED"), true);
  assert.equal(isRefundEligibleStripePaymentStatus("PARTIALLY_REFUNDED"), true);
  assert.equal(REFUND_ELIGIBLE_STRIPE_PAYMENT_STATUSES.length, 2);

  for (const status of STRIPE_PAYMENT_STATUSES) {
    const expected = status === "SUCCEEDED" || status === "PARTIALLY_REFUNDED";
    assert.equal(
      isRefundEligibleStripePaymentStatus(status),
      expected,
      `${status} refund-eligible mismatch`,
    );
  }
}

function testRefundedAndDisputedNotEligible() {
  assert.equal(isRefundEligibleStripePaymentStatus("REFUNDED"), false);
  assert.equal(isRefundEligibleStripePaymentStatus("DISPUTED"), false);
}

function testRefundPreservableSet() {
  assert.equal(isRefundPreservableStripePaymentStatus("SUCCEEDED"), true);
  assert.equal(isRefundPreservableStripePaymentStatus("PARTIALLY_REFUNDED"), true);
  assert.equal(isRefundPreservableStripePaymentStatus("REFUNDED"), true);
  assert.equal(REFUND_PRESERVABLE_STRIPE_PAYMENT_STATUSES.length, 3);

  assert.equal(isRefundPreservableStripePaymentStatus("DISPUTED"), false);
  for (const status of UNPAID_STRIPE_PAYMENT_STATUSES) {
    assert.equal(
      isRefundPreservableStripePaymentStatus(status),
      false,
      `${status} must not be refund-preservable`,
    );
  }
}

function testFullRefundDerivesRefunded() {
  const result = deriveRefundStripeStatus({
    amountCents: 43000,
    refundedAmountCents: 43000,
  });
  assert.deepEqual(result, { ok: true, stripeStatus: "REFUNDED" });
}

function testPartialRefundDerivesPartiallyRefunded() {
  const result = deriveRefundStripeStatus({
    amountCents: 43000,
    refundedAmountCents: 18000,
  });
  assert.deepEqual(result, { ok: true, stripeStatus: "PARTIALLY_REFUNDED" });
}

function testExactPaymentAmountDerivesRefunded() {
  const result = deriveRefundStripeStatus({
    amountCents: 1,
    refundedAmountCents: 1,
  });
  assert.deepEqual(result, { ok: true, stripeStatus: "REFUNDED" });
}

function testOverageDerivesRefunded() {
  // Documented policy: cumulative >= amountCents → REFUNDED (including overage).
  const result = deriveRefundStripeStatus({
    amountCents: 10000,
    refundedAmountCents: 10001,
  });
  assert.deepEqual(result, { ok: true, stripeStatus: "REFUNDED" });
}

function testZeroRefundedReturnsNoStatus() {
  const result = deriveRefundStripeStatus({
    amountCents: 43000,
    refundedAmountCents: 0,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /refundedAmountCents is 0/);
}

function testInvalidAmountsThrow() {
  assert.throws(
    () => deriveRefundStripeStatus({ amountCents: 0, refundedAmountCents: 1 }),
    /amountCents must be a positive/,
  );
  assert.throws(
    () => deriveRefundStripeStatus({ amountCents: -100, refundedAmountCents: 1 }),
    /amountCents must be a positive/,
  );
  assert.throws(
    () => deriveRefundStripeStatus({ amountCents: 100, refundedAmountCents: -1 }),
    /refundedAmountCents must be a non-negative/,
  );
  assert.throws(
    () => deriveRefundStripeStatus({ amountCents: 10.5, refundedAmountCents: 1 }),
    /finite integer/,
  );
  assert.throws(
    () => deriveRefundStripeStatus({ amountCents: 100, refundedAmountCents: 1.5 }),
    /finite integer/,
  );
  assert.throws(
    () =>
      deriveRefundStripeStatus({
        amountCents: Number.NaN,
        refundedAmountCents: 1,
      }),
    /finite integer/,
  );
  assert.throws(
    () =>
      deriveRefundStripeStatus({
        amountCents: Number.POSITIVE_INFINITY,
        refundedAmountCents: 1,
      }),
    /finite integer/,
  );
  assert.throws(
    () =>
      deriveRefundStripeStatus({
        amountCents: Number.MAX_SAFE_INTEGER + 1,
        refundedAmountCents: 1,
      }),
    /safe integer/,
  );
  assert.throws(
    () =>
      deriveRefundStripeStatus({
        amountCents: 100,
        refundedAmountCents: Number.MAX_SAFE_INTEGER + 1,
      }),
    /safe integer/,
  );
  assert.throws(
    () =>
      deriveRefundStripeStatus({
        amountCents: "100" as unknown as number,
        refundedAmountCents: 1,
      }),
    /finite integer/,
  );
}

function testDeterministicAndNonMutating() {
  const input = { amountCents: 5000, refundedAmountCents: 2000 };
  const frozen = Object.freeze({ ...input });
  const first = deriveRefundStripeStatus(frozen);
  const second = deriveRefundStripeStatus(frozen);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { ok: true, stripeStatus: "PARTIALLY_REFUNDED" });
  assert.deepEqual(frozen, { amountCents: 5000, refundedAmountCents: 2000 });
}

function testStatusSetsPartitionKnownLiterals() {
  // Every schema status is either paid-lineage or unpaid — never both, never neither.
  for (const status of STRIPE_PAYMENT_STATUSES) {
    const paid = isPaidLineageStripePaymentStatus(status);
    const unpaid = isUnpaidStripePaymentStatus(status);
    assert.equal(
      paid !== unpaid,
      true,
      `${status} must be exactly one of paid-lineage or unpaid`,
    );
  }
}

function testUnpaidTerminalAndExpiryFilters() {
  const unpaidFilter = unpaidTerminalWritableStripeStatusFilter();
  assert.deepEqual(unpaidFilter.in, [...UNPAID_STRIPE_PAYMENT_STATUSES]);
  for (const status of PAID_LINEAGE_STRIPE_PAYMENT_STATUSES) {
    assert.equal(unpaidFilter.in.includes(status as never), false, status);
  }

  assert.equal(isCheckoutExpiryWritableStripePaymentStatus("PENDING"), true);
  assert.equal(isCheckoutExpiryWritableStripePaymentStatus("EXPIRED"), false);
  for (const status of PAID_LINEAGE_STRIPE_PAYMENT_STATUSES) {
    assert.equal(isCheckoutExpiryWritableStripePaymentStatus(status), false, status);
  }
  assert.deepEqual([...CHECKOUT_EXPIRY_WRITABLE_STRIPE_PAYMENT_STATUSES], [
    "PENDING",
    "PROCESSING",
    "FAILED",
    "CANCELLED",
  ]);

  assert.equal(shouldReleaseBookingAfterUnpaidTerminalWrite(1), true);
  assert.equal(shouldReleaseBookingAfterUnpaidTerminalWrite(0), false);
}

function testConfirmationEligibleAllowlist() {
  assert.equal(isConfirmationEligibleStripePaymentStatus("SUCCEEDED"), true);
  assert.equal(isConfirmationEligibleStripePaymentStatus("PARTIALLY_REFUNDED"), true);
  assert.equal(CONFIRMATION_ELIGIBLE_STRIPE_PAYMENT_STATUSES.length, 2);
  assert.equal(isConfirmationEligibleStripePaymentStatus("REFUNDED"), false);
  assert.equal(isConfirmationEligibleStripePaymentStatus("DISPUTED"), false);
  for (const status of UNPAID_STRIPE_PAYMENT_STATUSES) {
    assert.equal(isConfirmationEligibleStripePaymentStatus(status), false, status);
  }
  assert.equal(isConfirmationEligibleStripePaymentStatus("NOT_A_STATUS"), false);
}

function main() {
  testPaidLineageRecognizesAllFour();
  testUnpaidAreNotPaidLineage();
  testRefundEligibleAllowlist();
  testRefundedAndDisputedNotEligible();
  testRefundPreservableSet();
  testConfirmationEligibleAllowlist();
  testUnpaidTerminalAndExpiryFilters();
  testFullRefundDerivesRefunded();
  testPartialRefundDerivesPartiallyRefunded();
  testExactPaymentAmountDerivesRefunded();
  testOverageDerivesRefunded();
  testZeroRefundedReturnsNoStatus();
  testInvalidAmountsThrow();
  testDeterministicAndNonMutating();
  testStatusSetsPartitionKnownLiterals();
  console.log("payment-status-rules tests passed");
}

main();
