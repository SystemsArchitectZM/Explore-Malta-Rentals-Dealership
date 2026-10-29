/**
 * Focused dispute → payment association and status rules (no DB / Stripe).
 *
 *   npm run test:dispute-payment-policy
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DISPUTE_MARKABLE_STRIPE_PAYMENT_STATUSES,
  DISPUTE_WARNING_STATUSES,
  assertDisputeStatusSetsPartitionKnownStatuses,
  decideDisputeCreatedLookup,
  disputeCreatedRetryErrorMessage,
  disputeMarkableStripeStatusFilter,
  isDisputeMarkableStripePaymentStatus,
  isDisputeWarningStatus,
  resolveDisputePaymentIntentId,
  shouldMarkDisputedOnDisputeCreated,
} from "../src/lib/stripe/dispute-payment-policy";
import {
  PAID_LINEAGE_STRIPE_PAYMENT_STATUSES,
  REFUND_ELIGIBLE_STRIPE_PAYMENT_STATUSES,
  STRIPE_PAYMENT_STATUSES,
  UNPAID_STRIPE_PAYMENT_STATUSES,
  isPaidLineageStripePaymentStatus,
  isRefundEligibleStripePaymentStatus,
} from "../src/lib/stripe/payment-status-rules";
import { classifyWebhookFailure } from "../src/lib/stripe/webhook-errors";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type PaymentRow = {
  id: string;
  bookingId: string;
  stripePaymentIntentId: string;
  stripeStatus: string;
};

type TransactionRow = {
  stripeTransactionId: string; // Checkout Session id in this codebase
  stripePaymentId: string;
};

/**
 * Models the corrected handler path: lookup by PaymentIntent, then conditional
 * updateMany with the dispute-markable allowlist. Never refunds.
 */
function applyDisputeCreated(input: {
  paymentIntentId: string | null;
  chargeId: string | null;
  payments: PaymentRow[];
  transactions: TransactionRow[];
}): {
  decision: ReturnType<typeof decideDisputeCreatedLookup>;
  updatedCount: number;
  refundInitiated: boolean;
  payment: PaymentRow | null;
} {
  const payment = input.paymentIntentId
    ? (input.payments.find((p) => p.stripePaymentIntentId === input.paymentIntentId) ?? null)
    : null;
  const decision = decideDisputeCreatedLookup({
    paymentIntentId: input.paymentIntentId,
    payment,
  });
  if (decision.kind !== "mark_disputed" || !payment) {
    return { decision, updatedCount: 0, refundInitiated: false, payment };
  }
  const filter = disputeMarkableStripeStatusFilter();
  if (!(filter.in as readonly string[]).includes(payment.stripeStatus)) {
    return { decision, updatedCount: 0, refundInitiated: false, payment };
  }
  payment.stripeStatus = "DISPUTED";
  return { decision, updatedCount: 1, refundInitiated: false, payment };
}

/** Legacy broken path: charge id vs StripeTransaction.stripeTransactionId (session id). */
function legacyLookupByCharge(
  chargeId: string | null,
  payments: PaymentRow[],
  transactions: TransactionRow[],
): PaymentRow | null {
  if (!chargeId) return null;
  const tx = transactions.find((t) => t.stripeTransactionId === chargeId);
  if (!tx) return null;
  return payments.find((p) => p.id === tx.stripePaymentId) ?? null;
}

function testResolvePaymentIntentFromStringAndObject() {
  assert.equal(resolveDisputePaymentIntentId("pi_abc"), "pi_abc");
  assert.equal(resolveDisputePaymentIntentId({ id: "pi_expanded" }), "pi_expanded");
  assert.equal(resolveDisputePaymentIntentId("  "), null);
  assert.equal(resolveDisputePaymentIntentId(null), null);
  assert.equal(resolveDisputePaymentIntentId(undefined), null);
  assert.equal(resolveDisputePaymentIntentId({ id: null }), null);
}

function testMatchedViaPaymentIntentNotCharge() {
  const payments: PaymentRow[] = [
    {
      id: "pay_1",
      bookingId: "book_1",
      stripePaymentIntentId: "pi_correct",
      stripeStatus: "SUCCEEDED",
    },
  ];
  const transactions: TransactionRow[] = [
    { stripeTransactionId: "cs_session_not_a_charge", stripePaymentId: "pay_1" },
  ];

  assert.equal(
    legacyLookupByCharge("ch_real_charge", payments, transactions),
    null,
    "charge id must not match checkout-session transaction id",
  );

  const result = applyDisputeCreated({
    paymentIntentId: "pi_correct",
    chargeId: "ch_real_charge",
    payments,
    transactions,
  });
  assert.equal(result.decision.kind, "mark_disputed");
  assert.equal(result.updatedCount, 1);
  assert.equal(payments[0]!.stripeStatus, "DISPUTED");
}

function testChargeMismatchNoLongerFalseUnmatched() {
  const payments: PaymentRow[] = [
    {
      id: "pay_2",
      bookingId: "book_2",
      stripePaymentIntentId: "pi_ok",
      stripeStatus: "PARTIALLY_REFUNDED",
    },
  ];
  const transactions: TransactionRow[] = [
    { stripeTransactionId: "cs_xyz", stripePaymentId: "pay_2" },
  ];

  assert.equal(legacyLookupByCharge("ch_other", payments, transactions), null);

  const decision = decideDisputeCreatedLookup({
    paymentIntentId: "pi_ok",
    payment: payments[0]!,
  });
  assert.equal(decision.kind, "mark_disputed");
}

function testWarningStatusesMarkDisputedConsistently() {
  for (const warning of DISPUTE_WARNING_STATUSES) {
    assert.equal(isDisputeWarningStatus(warning), true, warning);
    assert.equal(shouldMarkDisputedOnDisputeCreated(warning), true, warning);
  }
  assert.equal(shouldMarkDisputedOnDisputeCreated("needs_response"), true);
  assert.equal(shouldMarkDisputedOnDisputeCreated("lost"), true);

  const payments: PaymentRow[] = [
    {
      id: "pay_w",
      bookingId: "book_w",
      stripePaymentIntentId: "pi_w",
      stripeStatus: "SUCCEEDED",
    },
  ];
  const result = applyDisputeCreated({
    paymentIntentId: "pi_w",
    chargeId: null,
    payments,
    transactions: [],
  });
  assert.equal(result.updatedCount, 1);
  assert.equal(payments[0]!.stripeStatus, "DISPUTED");
}

function testUnmatchedFollowsRetryablePath() {
  for (const decision of [
    decideDisputeCreatedLookup({ paymentIntentId: null, payment: null }),
    decideDisputeCreatedLookup({ paymentIntentId: "pi_missing", payment: null }),
  ] as const) {
    assert.ok(decision.kind === "retry_unmatched");
    const message = disputeCreatedRetryErrorMessage(decision);
    const classified = classifyWebhookFailure(new Error(message));
    assert.deepEqual(classified, { retryable: true, code: "HANDLER_ERROR" });
  }
}

function testPrematureUnpaidAlsoRetryable() {
  const decision = decideDisputeCreatedLookup({
    paymentIntentId: "pi_pending",
    payment: { id: "pay_p", bookingId: "b", stripeStatus: "PENDING" },
  });
  assert.equal(decision.kind, "retry_premature");
  const classified = classifyWebhookFailure(
    new Error(disputeCreatedRetryErrorMessage(decision)),
  );
  assert.deepEqual(classified, { retryable: true, code: "HANDLER_ERROR" });
}

function testDuplicateDeliveryIdempotent() {
  const payments: PaymentRow[] = [
    {
      id: "pay_d",
      bookingId: "book_d",
      stripePaymentIntentId: "pi_d",
      stripeStatus: "DISPUTED",
    },
  ];
  const first = applyDisputeCreated({
    paymentIntentId: "pi_d",
    chargeId: "ch_1",
    payments,
    transactions: [],
  });
  const second = applyDisputeCreated({
    paymentIntentId: "pi_d",
    chargeId: "ch_1",
    payments,
    transactions: [],
  });
  assert.equal(first.updatedCount, 1);
  assert.equal(second.updatedCount, 1);
  assert.equal(payments[0]!.stripeStatus, "DISPUTED");
  assert.equal(first.refundInitiated, false);
  assert.equal(second.refundInitiated, false);
}

function testDisputeDoesNotInitiateRefund() {
  for (const stripeStatus of DISPUTE_MARKABLE_STRIPE_PAYMENT_STATUSES) {
    const payments: PaymentRow[] = [
      {
        id: "pay_r",
        bookingId: "book_r",
        stripePaymentIntentId: "pi_r",
        stripeStatus,
      },
    ];
    const result = applyDisputeCreated({
      paymentIntentId: "pi_r",
      chargeId: null,
      payments,
      transactions: [],
    });
    assert.equal(result.refundInitiated, false, stripeStatus);
    assert.equal(isRefundEligibleStripePaymentStatus("DISPUTED"), false);
  }
  assert.deepEqual(
    [...REFUND_ELIGIBLE_STRIPE_PAYMENT_STATUSES],
    ["SUCCEEDED", "PARTIALLY_REFUNDED"],
  );
}

function testClosureRemainsAuditOnly() {
  // Closure must not clear DISPUTED — model: audit payload only, status untouched.
  const payment: PaymentRow = {
    id: "pay_c",
    bookingId: "book_c",
    stripePaymentIntentId: "pi_c",
    stripeStatus: "DISPUTED",
  };
  const prior = payment.stripeStatus;
  const audit = {
    action: "dispute_closed" as const,
    statusCleared: false,
    stripeStatusUnchanged: payment.stripeStatus,
  };
  assert.equal(audit.statusCleared, false);
  assert.equal(payment.stripeStatus, prior);
  assert.equal(payment.stripeStatus, "DISPUTED");
}

function testCannotOverwriteUnrelatedViaAllowlist() {
  for (const unpaid of UNPAID_STRIPE_PAYMENT_STATUSES) {
    const payments: PaymentRow[] = [
      {
        id: "pay_u",
        bookingId: "book_u",
        stripePaymentIntentId: "pi_u",
        stripeStatus: unpaid,
      },
    ];
    const result = applyDisputeCreated({
      paymentIntentId: "pi_u",
      chargeId: null,
      payments,
      transactions: [],
    });
    assert.equal(result.decision.kind, "retry_premature", unpaid);
    assert.equal(result.updatedCount, 0, unpaid);
    assert.equal(payments[0]!.stripeStatus, unpaid, unpaid);
  }
}

function testPaidLineageAndRefundProtectionsIntact() {
  assert.deepEqual(
    [...PAID_LINEAGE_STRIPE_PAYMENT_STATUSES],
    ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"],
  );
  assert.deepEqual(
    [...DISPUTE_MARKABLE_STRIPE_PAYMENT_STATUSES],
    [...PAID_LINEAGE_STRIPE_PAYMENT_STATUSES],
  );
  for (const status of STRIPE_PAYMENT_STATUSES) {
    assert.equal(
      isDisputeMarkableStripePaymentStatus(status),
      isPaidLineageStripePaymentStatus(status),
    );
  }
  assertDisputeStatusSetsPartitionKnownStatuses(STRIPE_PAYMENT_STATUSES);
}

function testWebhookServiceUsesPaymentIntentLookup() {
  const source = readFileSync(
    join(ROOT, "src/lib/stripe/webhook-service.ts"),
    "utf8",
  );
  assert.match(
    source,
    /resolveDisputePaymentIntentId\(dispute\.payment_intent\)/,
  );
  assert.match(
    source,
    /findUnique\(\{\s*where:\s*\{\s*stripePaymentIntentId:\s*paymentIntentId/,
  );
  assert.doesNotMatch(
    source,
    /StripeTransaction:\s*\{\s*some:\s*\{\s*stripeTransactionId:\s*chargeId/,
  );
  assert.match(source, /disputeMarkableStripeStatusFilter\(\)/);
  assert.match(source, /refundInitiated:\s*false/);
  assert.match(source, /statusCleared:\s*false/);
  // Closure must not write SUCCEEDED / clear DISPUTED.
  const closedFn = source.slice(source.indexOf("async function handleDisputeClosed"));
  assert.doesNotMatch(closedFn, /stripeStatus:\s*"SUCCEEDED"/);
  assert.doesNotMatch(closedFn, /stripeStatus:\s*"PARTIALLY_REFUNDED"/);
  assert.match(closedFn, /statusCleared:\s*false/);
}

function main() {
  testResolvePaymentIntentFromStringAndObject();
  testMatchedViaPaymentIntentNotCharge();
  testChargeMismatchNoLongerFalseUnmatched();
  testWarningStatusesMarkDisputedConsistently();
  testUnmatchedFollowsRetryablePath();
  testPrematureUnpaidAlsoRetryable();
  testDuplicateDeliveryIdempotent();
  testDisputeDoesNotInitiateRefund();
  testClosureRemainsAuditOnly();
  testCannotOverwriteUnrelatedViaAllowlist();
  testPaidLineageAndRefundProtectionsIntact();
  testWebhookServiceUsesPaymentIntentLookup();
  console.log("ok — dispute-payment-policy");
}

main();
