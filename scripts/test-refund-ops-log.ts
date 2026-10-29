/**
 * Refund operational event classification tests.
 *
 *   npm run test:refund-ops-log
 */

import assert from "node:assert/strict";

import {
  auditActionForRefundOpsEvent,
  classifyStripeCreateOutcome,
  logRefundOpsEvent,
  sanitizeRefundOpsContext,
  type RefundOpsEvent,
} from "../src/lib/stripe/refund-ops-log";

function testClassifications() {
  assert.equal(classifyStripeCreateOutcome({ kind: "throw" }), "refund.stripe_ambiguous_outcome");
  assert.equal(
    classifyStripeCreateOutcome({ kind: "status", status: "failed" }),
    "refund.stripe_definitive_failure",
  );
  assert.equal(
    classifyStripeCreateOutcome({ kind: "status", status: "canceled" }),
    "refund.stripe_definitive_failure",
  );
  assert.equal(
    classifyStripeCreateOutcome({ kind: "status", status: "pending" }),
    "refund.stripe_pending",
  );
  assert.equal(
    classifyStripeCreateOutcome({ kind: "status", status: "requires_action" }),
    "refund.stripe_pending",
  );
}

function testAuditMappingNeverLabelsAmbiguousAsFailed() {
  const cases: Array<[RefundOpsEvent, string]> = [
    ["refund.stripe_definitive_failure", "refund_failed"],
    ["refund.stripe_pending", "refund_pending"],
    ["refund.stripe_ambiguous_outcome", "refund_ambiguous"],
    ["refund.db_persist_after_stripe_success", "refund_persist_incomplete"],
    ["refund.webhook_terminal_conflict", "refund_reconciled"],
  ];
  for (const [event, action] of cases) {
    assert.equal(auditActionForRefundOpsEvent(event), action);
  }
  assert.notEqual(
    auditActionForRefundOpsEvent("refund.stripe_ambiguous_outcome"),
    "refund_failed",
  );
}

function testSanitizeDropsUnsafeKeys() {
  const cleaned = sanitizeRefundOpsContext({
    bookingId: "b1",
    clientRequestId: "c1",
    requestId: "r1",
    stripePaymentId: "p1",
    customerEmail: "secret@example.com",
    rawStripeError: { message: "card_error" },
    sql: "SELECT * FROM secrets",
    amountCents: 5000,
  });
  assert.deepEqual(cleaned, {
    bookingId: "b1",
    clientRequestId: "c1",
    requestId: "r1",
    stripePaymentId: "p1",
    amountCents: 5000,
  });
}

function testLogEmitsStableEventName() {
  const original = console.error;
  const lines: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    logRefundOpsEvent("refund.stripe_ambiguous_outcome", {
      requestId: "req_1",
      customerEmail: "nope@example.com",
    });
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], "[refund-ops] event=refund.stripe_ambiguous_outcome");
  assert.deepEqual(lines[0][1], { requestId: "req_1" });
}

function main() {
  testClassifications();
  testAuditMappingNeverLabelsAmbiguousAsFailed();
  testSanitizeDropsUnsafeKeys();
  testLogEmitsStableEventName();
  console.log("test-refund-ops-log: all passed");
}

main();
