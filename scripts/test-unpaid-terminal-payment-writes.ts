/**
 * Fake-tx tests for unpaid-terminal FAILED / CANCELLED / EXPIRED writes.
 * Models the webhook updateMany allowlists and release gate (no live DB / Stripe).
 *
 *   npm run test:unpaid-terminal-payment-writes
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PAID_LINEAGE_STRIPE_PAYMENT_STATUSES,
  UNPAID_STRIPE_PAYMENT_STATUSES,
  checkoutExpiryWritableStripeStatusFilter,
  shouldReleaseBookingAfterUnpaidTerminalWrite,
  unpaidTerminalWritableStripeStatusFilter,
} from "../src/lib/stripe/payment-status-rules";

type PaymentRow = {
  bookingId: string;
  stripeCheckoutSessionId: string | null;
  stripeStatus: string;
};

function applyUnpaidTerminalWrite(
  payment: PaymentRow,
  nextStatus: "FAILED" | "CANCELLED",
): { updatedCount: number; released: boolean } {
  const filter = unpaidTerminalWritableStripeStatusFilter();
  if (!filter.in.includes(payment.stripeStatus as (typeof filter.in)[number])) {
    return { updatedCount: 0, released: shouldReleaseBookingAfterUnpaidTerminalWrite(0) };
  }
  payment.stripeStatus = nextStatus;
  const updatedCount = 1;
  return {
    updatedCount,
    released: shouldReleaseBookingAfterUnpaidTerminalWrite(updatedCount),
  };
}

function applyExpiryWrite(
  payment: PaymentRow,
  eventSessionId: string,
): { updatedCount: number; released: boolean } {
  const filter = checkoutExpiryWritableStripeStatusFilter();
  const matchesSession = payment.stripeCheckoutSessionId === eventSessionId;
  const statusOk = (filter.in as readonly string[]).includes(payment.stripeStatus);
  if (!matchesSession || !statusOk) {
    return { updatedCount: 0, released: shouldReleaseBookingAfterUnpaidTerminalWrite(0) };
  }
  payment.stripeStatus = "EXPIRED";
  return { updatedCount: 1, released: shouldReleaseBookingAfterUnpaidTerminalWrite(1) };
}

function testLateFailureCannotOverwriteSucceeded() {
  const payment = {
    bookingId: "booking_1",
    stripeCheckoutSessionId: "cs_1",
    stripeStatus: "SUCCEEDED",
  };
  const result = applyUnpaidTerminalWrite(payment, "FAILED");
  assert.equal(result.updatedCount, 0);
  assert.equal(result.released, false);
  assert.equal(payment.stripeStatus, "SUCCEEDED");
}

function testLateFailureCannotOverwritePaidLineage() {
  for (const stripeStatus of ["PARTIALLY_REFUNDED", "REFUNDED", "DISPUTED"] as const) {
    const payment = {
      bookingId: "booking_1",
      stripeCheckoutSessionId: "cs_1",
      stripeStatus,
    };
    const result = applyUnpaidTerminalWrite(payment, "FAILED");
    assert.equal(result.updatedCount, 0, stripeStatus);
    assert.equal(result.released, false, stripeStatus);
    assert.equal(payment.stripeStatus, stripeStatus);
  }
}

function testLateCancellationCannotOverwritePaidLineage() {
  for (const stripeStatus of PAID_LINEAGE_STRIPE_PAYMENT_STATUSES) {
    const payment = {
      bookingId: "booking_1",
      stripeCheckoutSessionId: "cs_1",
      stripeStatus,
    };
    const result = applyUnpaidTerminalWrite(payment, "CANCELLED");
    assert.equal(result.updatedCount, 0, stripeStatus);
    assert.equal(result.released, false, stripeStatus);
    assert.equal(payment.stripeStatus, stripeStatus);
  }
}

function testFailureAndCancellationStillUpdateUnpaid() {
  for (const unpaid of UNPAID_STRIPE_PAYMENT_STATUSES) {
    const failed = {
      bookingId: "booking_1",
      stripeCheckoutSessionId: "cs_1",
      stripeStatus: unpaid,
    };
    const failResult = applyUnpaidTerminalWrite(failed, "FAILED");
    assert.equal(failResult.updatedCount, 1, unpaid);
    assert.equal(failResult.released, true, unpaid);
    assert.equal(failed.stripeStatus, "FAILED");

    const cancelled = {
      bookingId: "booking_1",
      stripeCheckoutSessionId: "cs_1",
      stripeStatus: unpaid,
    };
    const cancelResult = applyUnpaidTerminalWrite(cancelled, "CANCELLED");
    assert.equal(cancelResult.updatedCount, 1, unpaid);
    assert.equal(cancelResult.released, true, unpaid);
    assert.equal(cancelled.stripeStatus, "CANCELLED");
  }
}

function testExpiryDoesNotWritePaidLineage() {
  for (const stripeStatus of PAID_LINEAGE_STRIPE_PAYMENT_STATUSES) {
    const payment = {
      bookingId: "booking_1",
      stripeCheckoutSessionId: "cs_current",
      stripeStatus,
    };
    const result = applyExpiryWrite(payment, "cs_current");
    assert.equal(result.updatedCount, 0, stripeStatus);
    assert.equal(result.released, false, stripeStatus);
    assert.equal(payment.stripeStatus, stripeStatus);
  }
}

function testLegitimateMatchingUnpaidSessionExpires() {
  const payment = {
    bookingId: "booking_1",
    stripeCheckoutSessionId: "cs_current",
    stripeStatus: "PENDING",
  };
  const result = applyExpiryWrite(payment, "cs_current");
  assert.equal(result.updatedCount, 1);
  assert.equal(result.released, true);
  assert.equal(payment.stripeStatus, "EXPIRED");
}

function testMismatchedSessionCannotExpire() {
  const payment = {
    bookingId: "booking_1",
    stripeCheckoutSessionId: "cs_new",
    stripeStatus: "PENDING",
  };
  const result = applyExpiryWrite(payment, "cs_old");
  assert.equal(result.updatedCount, 0);
  assert.equal(result.released, false);
  assert.equal(payment.stripeStatus, "PENDING");
}

function testUnknownStatusFailsClosed() {
  const payment = {
    bookingId: "booking_1",
    stripeCheckoutSessionId: "cs_1",
    stripeStatus: "NOT_A_STATUS",
  };
  assert.equal(applyUnpaidTerminalWrite(payment, "FAILED").updatedCount, 0);
  assert.equal(applyExpiryWrite(payment, "cs_1").updatedCount, 0);
  assert.equal(payment.stripeStatus, "NOT_A_STATUS");
}

function testWebhookHandlersUseSharedFilters() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const webhook = readFileSync(join(root, "src/lib/stripe/webhook-service.ts"), "utf8");
  assert.match(webhook, /unpaidTerminalWritableStripeStatusFilter/);
  assert.match(webhook, /checkoutExpiryWritableStripeStatusFilter/);
  assert.match(webhook, /shouldReleaseBookingAfterUnpaidTerminalWrite/);
  assert.match(webhook, /decideUnpaidTerminalPaymentIntentEffect/);
  assert.doesNotMatch(webhook, /stripeStatus:\s*\{\s*not:\s*"SUCCEEDED"\s*\}/);
}

function main() {
  testLateFailureCannotOverwriteSucceeded();
  testLateFailureCannotOverwritePaidLineage();
  testLateCancellationCannotOverwritePaidLineage();
  testFailureAndCancellationStillUpdateUnpaid();
  testExpiryDoesNotWritePaidLineage();
  testLegitimateMatchingUnpaidSessionExpires();
  testMismatchedSessionCannotExpire();
  testUnknownStatusFailsClosed();
  testWebhookHandlersUseSharedFilters();
  console.log("unpaid-terminal-payment-writes tests passed");
}

main();
