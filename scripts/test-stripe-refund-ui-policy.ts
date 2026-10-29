/**
 * Pure admin Stripe refund UI policy + list availability (no DB / Stripe).
 *
 *   npm run test:stripe-refund-ui-policy
 */

import assert from "node:assert/strict";

import { buildAdminPaymentListRefundMetrics } from "../src/features/admin/lib/stripe-payment-list-availability";
import {
  canOfferNewRefundAction,
  canOfferReconcileAction,
  canSubmitDepositPurposeInUi,
  canSubmitRefundDialog,
  isConfirmedRefundSuccessStatus,
  refundErrorMessageKey,
} from "../src/features/admin/lib/stripe-refund-ui-policy";

function testSucceededWithCapacityOffersRefund() {
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "ADMIN",
      needsReconciliation: false,
      stripeStatus: "SUCCEEDED",
      rentalAvailableEur: 50,
      depositAvailableEur: 0,
    }),
    true,
  );
}

function testPartiallyRefundedWithCapacityOffersRefund() {
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "ADMIN",
      needsReconciliation: false,
      stripeStatus: "PARTIALLY_REFUNDED",
      rentalAvailableEur: 10,
      depositAvailableEur: 250,
    }),
    true,
  );
}

function testNoCapacityDisables() {
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "ADMIN",
      needsReconciliation: false,
      stripeStatus: "SUCCEEDED",
      rentalAvailableEur: 0,
      depositAvailableEur: 0,
    }),
    false,
  );
}

function testIneligibleStatusesBlocked() {
  for (const stripeStatus of ["REFUNDED", "DISPUTED", "PENDING", "FAILED", "EXPIRED", "UNKNOWN"]) {
    assert.equal(
      canOfferNewRefundAction({
        viewerRole: "ADMIN",
        needsReconciliation: false,
        stripeStatus,
        rentalAvailableEur: 100,
        depositAvailableEur: 100,
      }),
      false,
      stripeStatus,
    );
  }
}

function testNeedsReconciliationBlocks() {
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "ADMIN",
      needsReconciliation: true,
      stripeStatus: "SUCCEEDED",
      rentalAvailableEur: 50,
      depositAvailableEur: 0,
    }),
    false,
  );
  assert.equal(
    canOfferReconcileAction({ viewerRole: "ADMIN", needsReconciliation: true }),
    true,
  );
}

function testDepositUiRequiresCompleted() {
  assert.equal(canSubmitDepositPurposeInUi("CONFIRMED"), false);
  assert.equal(canSubmitDepositPurposeInUi("CANCELLED"), false);
  assert.equal(canSubmitDepositPurposeInUi("COMPLETED"), true);
  assert.equal(
    canSubmitRefundDialog({
      viewerRole: "ADMIN",
      needsReconciliation: false,
      purpose: "SECURITY_DEPOSIT",
      bookingStatus: "CONFIRMED",
      busy: false,
    }),
    false,
  );
  assert.equal(
    canSubmitRefundDialog({
      viewerRole: "ADMIN",
      needsReconciliation: false,
      purpose: "SECURITY_DEPOSIT",
      bookingStatus: "COMPLETED",
      busy: false,
    }),
    true,
  );
}

function testStaffSeesNoMutationActions() {
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "STAFF",
      needsReconciliation: false,
      stripeStatus: "SUCCEEDED",
      rentalAvailableEur: 50,
      depositAvailableEur: 0,
    }),
    false,
  );
  assert.equal(
    canOfferReconcileAction({ viewerRole: "STAFF", needsReconciliation: true }),
    false,
  );
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "ADMIN",
      needsReconciliation: false,
      stripeStatus: "PARTIALLY_REFUNDED",
      rentalAvailableEur: 5,
      depositAvailableEur: 0,
    }),
    true,
  );
}

function testListAvailabilityUsesSucceededAndPending() {
  const metrics = buildAdminPaymentListRefundMetrics({
    payment: {
      amountCents: 43000,
      rentalAmountCents: 18000,
      depositAmountCents: 25000,
      // Stale counters understate refunds — authoritative path must ignore them.
      refundedAmountCents: 0,
      rentalRefundedCents: 0,
      depositRefundedCents: 0,
    },
    requests: [
      {
        stripeRefundId: "re_1",
        purpose: "RENTAL",
        status: "SUCCEEDED",
        amountCents: 5000,
      },
      {
        stripeRefundId: null,
        purpose: "RENTAL",
        status: "PENDING",
        amountCents: 3000,
      },
    ],
    stripeRefunds: [{ stripeRefundId: "re_1", amountCents: 5000 }],
  });
  assert.equal(metrics.availabilityReliable, true);
  assert.equal(metrics.needsReconciliation, false);
  assert.equal(metrics.rentalAvailableCents, 10000); // 18000 - 5000 - 3000
  assert.equal(metrics.depositAvailableCents, 25000);
}

function testAmbiguousAccountingFailsClosedForNewRefunds() {
  const metrics = buildAdminPaymentListRefundMetrics({
    payment: {
      amountCents: 43000,
      rentalAmountCents: 18000,
      depositAmountCents: 25000,
      refundedAmountCents: 1000,
      rentalRefundedCents: 0,
      depositRefundedCents: 0,
    },
    requests: [],
    stripeRefunds: [{ stripeRefundId: "re_orphan", amountCents: 1000 }],
  });
  assert.equal(metrics.needsReconciliation, true);
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "ADMIN",
      needsReconciliation: metrics.needsReconciliation,
      stripeStatus: "SUCCEEDED",
      rentalAvailableEur: metrics.rentalAvailableCents / 100,
      depositAvailableEur: metrics.depositAvailableCents / 100,
      availabilityReliable: metrics.availabilityReliable,
    }),
    false,
  );
}

function testCorruptAllocationFailsClosed() {
  const metrics = buildAdminPaymentListRefundMetrics({
    payment: {
      amountCents: 100,
      rentalAmountCents: 60,
      depositAmountCents: 50, // integrity break
      refundedAmountCents: 0,
      rentalRefundedCents: 0,
      depositRefundedCents: 0,
    },
    requests: [],
    stripeRefunds: [],
  });
  assert.equal(metrics.availabilityReliable, false);
  assert.equal(metrics.rentalAvailableCents, 0);
  assert.equal(metrics.depositAvailableCents, 0);
  assert.equal(metrics.needsReconciliation, true);
}

function testPendingResponseNotConfirmedSuccess() {
  assert.equal(isConfirmedRefundSuccessStatus("pending"), false);
  assert.equal(isConfirmedRefundSuccessStatus("succeeded"), true);
  assert.equal(refundErrorMessageKey("ineligible"), "ineligible");
  assert.equal(refundErrorMessageKey("no_capacity"), "no_capacity");
  assert.equal(refundErrorMessageKey("needs_reconciliation"), "needs_reconciliation");
  assert.equal(refundErrorMessageKey("request_conflict"), "request_conflict");
  assert.equal(refundErrorMessageKey("other"), null);
}

function testUnreliableAvailabilityBlocksRefund() {
  assert.equal(
    canOfferNewRefundAction({
      viewerRole: "ADMIN",
      needsReconciliation: false,
      stripeStatus: "SUCCEEDED",
      rentalAvailableEur: 50,
      depositAvailableEur: 0,
      availabilityReliable: false,
    }),
    false,
  );
}

function main() {
  testSucceededWithCapacityOffersRefund();
  testPartiallyRefundedWithCapacityOffersRefund();
  testNoCapacityDisables();
  testIneligibleStatusesBlocked();
  testNeedsReconciliationBlocks();
  testDepositUiRequiresCompleted();
  testStaffSeesNoMutationActions();
  testListAvailabilityUsesSucceededAndPending();
  testAmbiguousAccountingFailsClosedForNewRefunds();
  testCorruptAllocationFailsClosed();
  testPendingResponseNotConfirmedSuccess();
  testUnreliableAvailabilityBlocksRefund();
  console.log("test-stripe-refund-ui-policy: all passed");
}

main();
