/**
 * Mocked checkout.session.expired handler tests (applyCheckoutSessionExpiredEvent).
 * These do not contact PostgreSQL or Stripe — they exercise injectable deps only.
 *
 *   npm run test:checkout-session-expired-handler
 */

import assert from "node:assert/strict";

import { applyCheckoutSessionExpiredEvent } from "../src/lib/stripe/checkout-session-expired-handler";
import { PAID_LINEAGE_STRIPE_PAYMENT_STATUSES } from "../src/lib/stripe/payment-status-rules";
import { classifyWebhookFailure } from "../src/lib/stripe/webhook-errors";

type PaymentSnap = {
  stripeCheckoutSessionId: string | null;
  stripeStatus: string;
};

function createDeps(options: {
  payment: PaymentSnap | null;
  updateCount?: number;
  updateThrows?: boolean;
  findThrows?: boolean;
  releaseThrows?: boolean;
  auditThrows?: boolean;
}) {
  const releaseCalls: string[] = [];
  const updateCalls: Array<{ bookingId: string; eventSessionId: string }> = [];
  const auditCalls: string[] = [];

  return {
    releaseCalls,
    updateCalls,
    auditCalls,
    deps: {
      findPaymentByBookingId: async () => {
        if (options.findThrows) {
          throw new Error("db find failed");
        }
        return options.payment;
      },
      markExpiredIfSessionMatches: async (input: {
        bookingId: string;
        eventSessionId: string;
      }) => {
        updateCalls.push(input);
        if (options.updateThrows) {
          throw new Error("db update failed");
        }
        return options.updateCount ?? 1;
      },
      releaseUnpaidBooking: async (input: { bookingId: string; eventSessionId: string }) => {
        releaseCalls.push(input.bookingId);
        if (options.releaseThrows) {
          throw new Error("release failed");
        }
      },
      writeAuditLog: async (input: { bookingId: string; eventSessionId: string }) => {
        auditCalls.push(input.eventSessionId);
        if (options.auditThrows) {
          throw new Error("audit failed");
        }
      },
    },
  };
}

async function testCurrentSessionExpiresAndReleases() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "PENDING" },
    updateCount: 1,
  });
  const action = await applyCheckoutSessionExpiredEvent(
    { id: "cs_current", metadata: { bookingId: "booking_1" } },
    mock.deps,
  );
  assert.equal(action, "checkout_session_expired_released");
  assert.equal(mock.updateCalls.length, 1);
  assert.deepEqual(mock.releaseCalls, ["booking_1"]);
  assert.deepEqual(mock.auditCalls, ["cs_current"]);
}

async function testOldSessionAfterReplacementIgnored() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_new", stripeStatus: "PENDING" },
  });
  const action = await applyCheckoutSessionExpiredEvent(
    { id: "cs_old", metadata: { bookingId: "booking_1" } },
    mock.deps,
  );
  assert.equal(action, "ignored_session_mismatch");
  assert.equal(mock.updateCalls.length, 0);
  assert.equal(mock.releaseCalls.length, 0);
}

async function testAlreadySucceededIgnored() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "SUCCEEDED" },
  });
  const action = await applyCheckoutSessionExpiredEvent(
    { id: "cs_current", metadata: { bookingId: "booking_1" } },
    mock.deps,
  );
  assert.equal(action, "ignored_already_succeeded");
  assert.equal(mock.updateCalls.length, 0);
  assert.equal(mock.releaseCalls.length, 0);
}

/** Deposit-only unpaid checkout expiry must release; succeeded deposit-only must not. */
async function testDepositOnlyUnpaidExpiresAndReleases() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_dep_only", stripeStatus: "PENDING" },
    updateCount: 1,
  });
  const action = await applyCheckoutSessionExpiredEvent(
    {
      id: "cs_dep_only",
      metadata: {
        bookingId: "booking_dep",
        amountCents: "25000",
        rentalAmountCents: "0",
        depositAmountCents: "25000",
      },
    },
    mock.deps,
  );
  assert.equal(action, "checkout_session_expired_released");
  assert.deepEqual(mock.releaseCalls, ["booking_dep"]);
  assert.equal(mock.updateCalls.length, 1);
}

async function testDepositOnlySucceededExpiryDoesNotRelease() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_dep_only", stripeStatus: "SUCCEEDED" },
  });
  const action = await applyCheckoutSessionExpiredEvent(
    {
      id: "cs_dep_only",
      metadata: {
        bookingId: "booking_dep",
        amountCents: "25000",
        rentalAmountCents: "0",
        depositAmountCents: "25000",
      },
    },
    mock.deps,
  );
  assert.equal(action, "ignored_already_succeeded");
  assert.equal(mock.releaseCalls.length, 0);
  assert.equal(mock.updateCalls.length, 0);
}

async function testPaidLineageDoesNotExpireOrRelease() {
  for (const stripeStatus of PAID_LINEAGE_STRIPE_PAYMENT_STATUSES) {
    const mock = createDeps({
      payment: { stripeCheckoutSessionId: "cs_current", stripeStatus },
    });
    const action = await applyCheckoutSessionExpiredEvent(
      { id: "cs_current", metadata: { bookingId: "booking_1" } },
      mock.deps,
    );
    assert.equal(action, "ignored_already_succeeded", stripeStatus);
    assert.equal(mock.updateCalls.length, 0, stripeStatus);
    assert.equal(mock.releaseCalls.length, 0, stripeStatus);
  }
}

async function testDuplicateExpiredIgnored() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "EXPIRED" },
  });
  const action = await applyCheckoutSessionExpiredEvent(
    { id: "cs_current", metadata: { bookingId: "booking_1" } },
    mock.deps,
  );
  assert.equal(action, "ignored_already_expired");
  assert.equal(mock.updateCalls.length, 0);
  assert.equal(mock.releaseCalls.length, 0);
}

async function testUpdateManyZeroRetriesWithoutRelease() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "PENDING" },
    updateCount: 0,
  });
  await assert.rejects(
    () =>
      applyCheckoutSessionExpiredEvent(
        { id: "cs_current", metadata: { bookingId: "booking_1" } },
        mock.deps,
      ),
    /CHECKOUT_SESSION_EXPIRED_CONCURRENT_UPDATE/,
  );
  assert.equal(mock.updateCalls.length, 1);
  assert.equal(mock.releaseCalls.length, 0);
  assert.equal(mock.auditCalls.length, 0);
}

async function testMissingPaymentRecordRetries() {
  const mock = createDeps({ payment: null });
  await assert.rejects(
    () =>
      applyCheckoutSessionExpiredEvent(
        { id: "cs_current", metadata: { bookingId: "booking_1" } },
        mock.deps,
      ),
    /CHECKOUT_SESSION_EXPIRED_PAYMENT_NOT_FOUND/,
  );
  assert.equal(mock.releaseCalls.length, 0);
}

async function testNullStoredSessionRetries() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: null, stripeStatus: "PENDING" },
  });
  await assert.rejects(
    () =>
      applyCheckoutSessionExpiredEvent(
        { id: "cs_current", metadata: { bookingId: "booking_1" } },
        mock.deps,
      ),
    /CHECKOUT_SESSION_EXPIRED_SESSION_NOT_LINKED/,
  );
  assert.equal(mock.releaseCalls.length, 0);
  assert.equal(mock.updateCalls.length, 0);
}

async function testRetryErrorsAreWebhookRetryable() {
  const mock = createDeps({ payment: null });
  try {
    await applyCheckoutSessionExpiredEvent(
      { id: "cs_current", metadata: { bookingId: "booking_1" } },
      mock.deps,
    );
    assert.fail("expected throw");
  } catch (error) {
    assert.deepEqual(classifyWebhookFailure(error), { retryable: true, code: "HANDLER_ERROR" });
  }
}

async function testUpdateErrorDoesNotReportSuccess() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "PENDING" },
    updateThrows: true,
  });
  await assert.rejects(
    () =>
      applyCheckoutSessionExpiredEvent(
        { id: "cs_current", metadata: { bookingId: "booking_1" } },
        mock.deps,
      ),
    /checkout_session_expired_update_failed/,
  );
  assert.equal(mock.releaseCalls.length, 0);
}

async function testMissingBookingMetadata() {
  const mock = createDeps({
    payment: { stripeCheckoutSessionId: "cs_current", stripeStatus: "PENDING" },
  });
  const action = await applyCheckoutSessionExpiredEvent({ id: "cs_current", metadata: {} }, mock.deps);
  assert.equal(action, "no_booking_metadata");
  assert.equal(mock.updateCalls.length, 0);
}

async function testSessionLinkedThenExpires() {
  const payment: PaymentSnap = {
    stripeCheckoutSessionId: null,
    stripeStatus: "PENDING",
  };
  const first = createDeps({ payment: { ...payment } });
  await assert.rejects(
    () =>
      applyCheckoutSessionExpiredEvent(
        { id: "cs_current", metadata: { bookingId: "booking_1" } },
        first.deps,
      ),
    /SESSION_NOT_LINKED/,
  );

  payment.stripeCheckoutSessionId = "cs_current";
  const second = createDeps({ payment, updateCount: 1 });
  const action = await applyCheckoutSessionExpiredEvent(
    { id: "cs_current", metadata: { bookingId: "booking_1" } },
    second.deps,
  );
  assert.equal(action, "checkout_session_expired_released");
  assert.deepEqual(second.releaseCalls, ["booking_1"]);
}

async function main() {
  await testCurrentSessionExpiresAndReleases();
  await testOldSessionAfterReplacementIgnored();
  await testAlreadySucceededIgnored();
  await testDepositOnlyUnpaidExpiresAndReleases();
  await testDepositOnlySucceededExpiryDoesNotRelease();
  await testPaidLineageDoesNotExpireOrRelease();
  await testDuplicateExpiredIgnored();
  await testUpdateManyZeroRetriesWithoutRelease();
  await testMissingPaymentRecordRetries();
  await testNullStoredSessionRetries();
  await testRetryErrorsAreWebhookRetryable();
  await testUpdateErrorDoesNotReportSuccess();
  await testMissingBookingMetadata();
  await testSessionLinkedThenExpires();
  console.log("test-checkout-session-expired-handler: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
