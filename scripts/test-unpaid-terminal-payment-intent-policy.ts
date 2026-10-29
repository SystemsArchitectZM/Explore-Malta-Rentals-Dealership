/**
 * Pure + fake-tx tests for PI failed/canceled association and retry policy.
 *
 *   npm run test:unpaid-terminal-payment-intent-policy
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAID_LINEAGE_STRIPE_PAYMENT_STATUSES,
  UNPAID_STRIPE_PAYMENT_STATUSES,
  shouldReleaseBookingAfterUnpaidTerminalWrite,
  unpaidTerminalWritableStripeStatusFilter,
} from "../src/lib/stripe/payment-status-rules";
import {
  decideUnpaidTerminalPaymentIntentEffect,
  unpaidTerminalPaymentIntentRetryErrorMessage,
} from "../src/lib/stripe/unpaid-terminal-payment-intent-policy";
import { classifyWebhookFailure } from "../src/lib/stripe/webhook-errors";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type PaymentRow = {
  bookingId: string;
  stripePaymentIntentId: string | null;
  stripeStatus: string;
};

/**
 * Models the webhook apply path: decision → conditional updateMany by matching PI
 * → release only when count > 0. Throws on retry decisions (like the real handler).
 */
function applyUnpaidTerminalPiEvent(input: {
  payment: PaymentRow | null;
  eventPaymentIntentId: string;
  nextStatus: "FAILED" | "CANCELLED";
}): { action: string; released: boolean; payment: PaymentRow | null } {
  const decision = decideUnpaidTerminalPaymentIntentEffect({
    eventPaymentIntentId: input.eventPaymentIntentId,
    payment: input.payment,
    nextStatus: input.nextStatus,
  });
  if (decision.kind === "retry") {
    throw new Error(unpaidTerminalPaymentIntentRetryErrorMessage(decision));
  }
  if (decision.kind === "ignore") {
    return { action: `ignored_${decision.reason}`, released: false, payment: input.payment };
  }

  const payment = input.payment!;
  const filter = unpaidTerminalWritableStripeStatusFilter();
  const statusOk = (filter.in as readonly string[]).includes(payment.stripeStatus);
  const piOk = payment.stripePaymentIntentId === input.eventPaymentIntentId;
  if (!statusOk || !piOk) {
    return { action: "ignored_race", released: false, payment };
  }
  payment.stripeStatus = input.nextStatus;
  const released = shouldReleaseBookingAfterUnpaidTerminalWrite(1);
  return { action: input.nextStatus === "FAILED" ? "payment_failed" : "payment_cancelled", released, payment };
}

function testMissingPaymentRetriesNoRelease() {
  for (const nextStatus of ["FAILED", "CANCELLED"] as const) {
    assert.throws(
      () =>
        applyUnpaidTerminalPiEvent({
          payment: null,
          eventPaymentIntentId: "pi_1",
          nextStatus,
        }),
      /UNPAID_TERMINAL_PAYMENT_NOT_FOUND/,
    );
    const decision = decideUnpaidTerminalPaymentIntentEffect({
      eventPaymentIntentId: "pi_1",
      payment: null,
      nextStatus,
    });
    assert.equal(decision.kind, "retry");
    if (decision.kind !== "retry") return;
    assert.deepEqual(
      classifyWebhookFailure(new Error(unpaidTerminalPaymentIntentRetryErrorMessage(decision))),
      { retryable: true, code: "HANDLER_ERROR" },
    );
  }
}

function testUnlinkedPaymentIntentRetries() {
  const payment: PaymentRow = {
    bookingId: "b1",
    stripePaymentIntentId: null,
    stripeStatus: "PENDING",
  };
  assert.throws(
    () =>
      applyUnpaidTerminalPiEvent({
        payment,
        eventPaymentIntentId: "pi_1",
        nextStatus: "FAILED",
      }),
    /PAYMENT_INTENT_NOT_LINKED/,
  );
  assert.equal(payment.stripeStatus, "PENDING");
}

function testLinkedPaymentAppliesAndReleases() {
  const payment: PaymentRow = {
    bookingId: "b1",
    stripePaymentIntentId: "pi_1",
    stripeStatus: "PENDING",
  };
  const result = applyUnpaidTerminalPiEvent({
    payment,
    eventPaymentIntentId: "pi_1",
    nextStatus: "FAILED",
  });
  assert.equal(result.action, "payment_failed");
  assert.equal(result.released, true);
  assert.equal(payment.stripeStatus, "FAILED");
}

function testRetryThenLinkedApplies() {
  const payment: PaymentRow = {
    bookingId: "b1",
    stripePaymentIntentId: null,
    stripeStatus: "PENDING",
  };
  assert.throws(
    () =>
      applyUnpaidTerminalPiEvent({
        payment,
        eventPaymentIntentId: "pi_1",
        nextStatus: "CANCELLED",
      }),
    /NOT_LINKED/,
  );
  payment.stripePaymentIntentId = "pi_1";
  const result = applyUnpaidTerminalPiEvent({
    payment,
    eventPaymentIntentId: "pi_1",
    nextStatus: "CANCELLED",
  });
  assert.equal(result.action, "payment_cancelled");
  assert.equal(result.released, true);
  assert.equal(payment.stripeStatus, "CANCELLED");
}

function testProtectedStatusNoRetryNoRelease() {
  for (const stripeStatus of PAID_LINEAGE_STRIPE_PAYMENT_STATUSES) {
    const payment: PaymentRow = {
      bookingId: "b1",
      stripePaymentIntentId: "pi_1",
      stripeStatus,
    };
    const result = applyUnpaidTerminalPiEvent({
      payment,
      eventPaymentIntentId: "pi_1",
      nextStatus: "FAILED",
    });
    assert.equal(result.action, "ignored_protected_status", stripeStatus);
    assert.equal(result.released, false, stripeStatus);
    assert.equal(payment.stripeStatus, stripeStatus, stripeStatus);
  }
}

function testStalePaymentIntentIgnored() {
  const payment: PaymentRow = {
    bookingId: "b1",
    stripePaymentIntentId: "pi_new",
    stripeStatus: "PENDING",
  };
  const result = applyUnpaidTerminalPiEvent({
    payment,
    eventPaymentIntentId: "pi_old",
    nextStatus: "FAILED",
  });
  assert.equal(result.action, "ignored_stale_attempt");
  assert.equal(result.released, false);
  assert.equal(payment.stripeStatus, "PENDING");
}

function testDuplicateSameTerminalIgnored() {
  const payment: PaymentRow = {
    bookingId: "b1",
    stripePaymentIntentId: "pi_1",
    stripeStatus: "FAILED",
  };
  const result = applyUnpaidTerminalPiEvent({
    payment,
    eventPaymentIntentId: "pi_1",
    nextStatus: "FAILED",
  });
  assert.equal(result.action, "ignored_already_same_terminal");
  assert.equal(result.released, false);
}

function testUnpaidStatusesStillApplyWhenLinked() {
  for (const unpaid of UNPAID_STRIPE_PAYMENT_STATUSES) {
    if (unpaid === "FAILED") continue; // covered as already_same_terminal for FAILED→FAILED
    const payment: PaymentRow = {
      bookingId: "b1",
      stripePaymentIntentId: "pi_1",
      stripeStatus: unpaid,
    };
    const result = applyUnpaidTerminalPiEvent({
      payment,
      eventPaymentIntentId: "pi_1",
      nextStatus: "FAILED",
    });
    assert.equal(result.action, "payment_failed", unpaid);
    assert.equal(result.released, true, unpaid);
  }
}

function testWebhookServiceUsesPolicyAndMatchingPi() {
  const source = readFileSync(join(ROOT, "src/lib/stripe/webhook-service.ts"), "utf8");
  assert.match(source, /decideUnpaidTerminalPaymentIntentEffect/);
  assert.match(source, /unpaidTerminalPaymentIntentRetryErrorMessage/);
  assert.match(source, /stripePaymentIntentId:\s*intent\.id/);
  assert.match(source, /applyUnpaidTerminalPaymentIntentEvent/);
  // Must not bookingId-only update unpaid terminal without PI match.
  assert.doesNotMatch(
    source,
    /updateMany\(\{\s*where:\s*\{\s*bookingId,\s*stripeStatus:\s*unpaidTerminalWritableStripeStatusFilter\(\)/,
  );
}

function main() {
  testMissingPaymentRetriesNoRelease();
  testUnlinkedPaymentIntentRetries();
  testLinkedPaymentAppliesAndReleases();
  testRetryThenLinkedApplies();
  testProtectedStatusNoRetryNoRelease();
  testStalePaymentIntentIgnored();
  testDuplicateSameTerminalIgnored();
  testUnpaidStatusesStillApplyWhenLinked();
  testWebhookServiceUsesPolicyAndMatchingPi();
  console.log("test-unpaid-terminal-payment-intent-policy: all passed");
}

main();
