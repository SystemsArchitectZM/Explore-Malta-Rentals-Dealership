/**
 * Pure checkout.session.expired decision tests (no DB / Stripe).
 *
 *   npm run test:checkout-session-expired-policy
 */

import assert from "node:assert/strict";

import {
  checkoutSessionExpiredRetryErrorMessage,
  decideCheckoutSessionExpiredEffect,
} from "../src/lib/stripe/checkout-session-expired-policy";
import { PAID_LINEAGE_STRIPE_PAYMENT_STATUSES } from "../src/lib/stripe/payment-status-rules";
import { classifyWebhookFailure } from "../src/lib/stripe/webhook-errors";

function testStoredSessionExpires() {
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_current",
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "PENDING" },
  });
  assert.deepEqual(decision, { kind: "apply" });
}

function testOldSessionAfterReplacementIgnored() {
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_old",
    payment: { stripeCheckoutSessionId: "cs_new", stripeStatus: "PENDING" },
  });
  assert.deepEqual(decision, { kind: "ignore", reason: "session_mismatch" });
}

function testAlreadySucceededIgnored() {
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_current",
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "SUCCEEDED" },
  });
  assert.deepEqual(decision, { kind: "ignore", reason: "already_succeeded" });
}

function testDepositOnlySucceededIgnoredRegardlessOfAllocationMetadata() {
  // Policy keys only on payment stripeStatus + session id; deposit-only amounts are irrelevant.
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_dep_only",
    payment: { stripeCheckoutSessionId: "cs_dep_only", stripeStatus: "SUCCEEDED" },
  });
  assert.deepEqual(decision, { kind: "ignore", reason: "already_succeeded" });
}

function testDepositOnlyPendingApplies() {
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_dep_only",
    payment: { stripeCheckoutSessionId: "cs_dep_only", stripeStatus: "PENDING" },
  });
  assert.deepEqual(decision, { kind: "apply" });
}

function testPaidLineageIgnoredAsAlreadySucceeded() {
  for (const stripeStatus of PAID_LINEAGE_STRIPE_PAYMENT_STATUSES) {
    const matching = decideCheckoutSessionExpiredEffect({
      eventSessionId: "cs_current",
      payment: { stripeCheckoutSessionId: "cs_current", stripeStatus },
    });
    assert.deepEqual(
      matching,
      { kind: "ignore", reason: "already_succeeded" },
      `${stripeStatus} matching session`,
    );

    const mismatched = decideCheckoutSessionExpiredEffect({
      eventSessionId: "cs_old",
      payment: { stripeCheckoutSessionId: "cs_new", stripeStatus },
    });
    assert.deepEqual(
      mismatched,
      { kind: "ignore", reason: "already_succeeded" },
      `${stripeStatus} mismatched session`,
    );
  }
}

function testDuplicateExpiredIgnored() {
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_current",
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "EXPIRED" },
  });
  assert.deepEqual(decision, { kind: "ignore", reason: "already_expired" });
}

function testAbsentStoredSessionRetries() {
  for (const stored of [null, undefined, ""] as const) {
    const decision = decideCheckoutSessionExpiredEffect({
      eventSessionId: "cs_event",
      payment: { stripeCheckoutSessionId: stored, stripeStatus: "PENDING" },
    });
    assert.deepEqual(decision, { kind: "retry", reason: "no_stored_session" });
    assert.deepEqual(classifyWebhookFailure(new Error(checkoutSessionExpiredRetryErrorMessage(decision))), {
      retryable: true,
      code: "HANDLER_ERROR",
    });
  }
}

function testMissingPaymentRetries() {
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_event",
    payment: null,
  });
  assert.deepEqual(decision, { kind: "retry", reason: "payment_not_found" });
  assert.deepEqual(classifyWebhookFailure(new Error(checkoutSessionExpiredRetryErrorMessage(decision))), {
    retryable: true,
    code: "HANDLER_ERROR",
  });
}

function testDifferingSessionIdIgnoredEvenIfExpiredStatus() {
  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId: "cs_old",
    payment: { stripeCheckoutSessionId: "cs_new", stripeStatus: "EXPIRED" },
  });
  assert.deepEqual(decision, { kind: "ignore", reason: "session_mismatch" });
}

function main() {
  testStoredSessionExpires();
  testOldSessionAfterReplacementIgnored();
  testAlreadySucceededIgnored();
  testDepositOnlySucceededIgnoredRegardlessOfAllocationMetadata();
  testDepositOnlyPendingApplies();
  testPaidLineageIgnoredAsAlreadySucceeded();
  testDuplicateExpiredIgnored();
  testAbsentStoredSessionRetries();
  testMissingPaymentRetries();
  testDifferingSessionIdIgnoredEvenIfExpiredStatus();
  console.log("test-checkout-session-expired-policy: all passed");
}

main();
