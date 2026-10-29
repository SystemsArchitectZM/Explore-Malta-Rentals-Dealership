/**
 * Pure checkout session reuse + eligibility + idempotency + error classification.
 * No database and no Stripe network.
 *
 *   npm run test:checkout-session-policy
 */

import assert from "node:assert/strict";

import { allocateCombinedCheckoutAmounts } from "../src/lib/stripe/checkout-allocation";
import {
  buildCheckoutIdempotencyKey,
  canReuseOpenCheckoutSession,
  CHECKOUT_FORMAT_VERSION,
  evaluateCheckoutBookingEligibility,
  type RetrievedCheckoutSession,
} from "../src/lib/stripe/checkout-session-policy";
import {
  isCheckoutLockActive,
  renewCheckoutOperationLockIfOwned,
  type CheckoutLockDeps,
} from "../src/lib/stripe/checkout-operation-lock";
import { classifyCheckoutSessionError } from "../src/lib/stripe/checkout-stripe-errors";

function validAllocation() {
  const result = allocateCombinedCheckoutAmounts({
    totalDueOnlineEur: 430,
    rentalSubtotalEur: 180,
    depositAmountEur: 250,
    depositMethod: "ONLINE",
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected allocation");
  }
  return result;
}

function matchingSession(allocation: ReturnType<typeof validAllocation>): RetrievedCheckoutSession {
  return {
    id: "cs_match",
    status: "open",
    url: "https://checkout.stripe.test/cs_match",
    currency: "eur",
    amountTotal: allocation.amountCents,
    paymentStatus: "unpaid",
    clientReferenceId: "EMR-1",
    metadata: {
      bookingId: "booking_1",
      checkoutVersion: CHECKOUT_FORMAT_VERSION,
      amountCents: String(allocation.amountCents),
      rentalAmountCents: String(allocation.rentalAmountCents),
      depositAmountCents: String(allocation.depositAmountCents),
    },
    lineItemsComplete: true,
    lineItems: [
      { amountTotal: allocation.rentalAmountCents, amountSubtotal: allocation.rentalAmountCents, quantity: 1, currency: "eur" },
      { amountTotal: allocation.depositAmountCents, amountSubtotal: allocation.depositAmountCents, quantity: 1, currency: "eur" },
    ],
  };
}

function testReuseRequiresCompleteLineItems() {
  const allocation = validAllocation();
  const stored = {
    id: "pay_1",
    stripeCheckoutSessionId: "cs_match",
    stripeStatus: "PENDING",
    amountCents: allocation.amountCents,
    rentalAmountCents: allocation.rentalAmountCents,
    depositAmountCents: allocation.depositAmountCents,
  };

  assert.equal(
    canReuseOpenCheckoutSession({
      session: matchingSession(allocation),
      bookingId: "booking_1",
      bookingReference: "EMR-1",
      allocation,
      storedPayment: stored,
    }),
    true,
  );

  assert.equal(
    canReuseOpenCheckoutSession({
      session: { ...matchingSession(allocation), lineItemsComplete: false },
      bookingId: "booking_1",
      bookingReference: "EMR-1",
      allocation,
      storedPayment: stored,
    }),
    false,
  );

  assert.equal(
    canReuseOpenCheckoutSession({
      session: {
        ...matchingSession(allocation),
        lineItems: [
          ...matchingSession(allocation).lineItems,
          { amountTotal: 100, amountSubtotal: 100, quantity: 1, currency: "eur" },
        ],
      },
      bookingId: "booking_1",
      bookingReference: "EMR-1",
      allocation,
      storedPayment: stored,
    }),
    false,
  );
}

function depositOnlyAllocation() {
  const result = allocateCombinedCheckoutAmounts({
    totalDueOnlineEur: 250,
    rentalSubtotalEur: 0,
    depositAmountEur: 250,
    depositMethod: "ONLINE",
  });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error("expected deposit-only allocation");
  }
  return result;
}

function testDepositOnlySessionReuse() {
  const allocation = depositOnlyAllocation();
  const stored = {
    id: "pay_dep",
    stripeCheckoutSessionId: "cs_dep",
    stripeStatus: "PENDING",
    amountCents: allocation.amountCents,
    rentalAmountCents: 0,
    depositAmountCents: allocation.depositAmountCents,
  };

  const session: RetrievedCheckoutSession = {
    id: "cs_dep",
    status: "open",
    url: "https://checkout.stripe.test/cs_dep",
    currency: "eur",
    amountTotal: allocation.amountCents,
    paymentStatus: "unpaid",
    clientReferenceId: "EMR-DEP",
    metadata: {
      bookingId: "booking_dep",
      checkoutVersion: CHECKOUT_FORMAT_VERSION,
      amountCents: String(allocation.amountCents),
      rentalAmountCents: "0",
      depositAmountCents: String(allocation.depositAmountCents),
    },
    lineItemsComplete: true,
    lineItems: [
      {
        amountTotal: allocation.depositAmountCents,
        amountSubtotal: allocation.depositAmountCents,
        quantity: 1,
        currency: "eur",
      },
    ],
  };

  assert.equal(
    canReuseOpenCheckoutSession({
      session,
      bookingId: "booking_dep",
      bookingReference: "EMR-DEP",
      allocation,
      storedPayment: stored,
    }),
    true,
  );

  // Two line items is invalid for deposit-only.
  assert.equal(
    canReuseOpenCheckoutSession({
      session: {
        ...session,
        lineItems: [
          ...session.lineItems,
          { amountTotal: 100, amountSubtotal: 100, quantity: 1, currency: "eur" },
        ],
      },
      bookingId: "booking_dep",
      bookingReference: "EMR-DEP",
      allocation,
      storedPayment: stored,
    }),
    false,
  );

  // Wrong total / metadata rejected.
  assert.equal(
    canReuseOpenCheckoutSession({
      session: { ...session, amountTotal: 30000 },
      bookingId: "booking_dep",
      bookingReference: "EMR-DEP",
      allocation,
      storedPayment: stored,
    }),
    false,
  );

  assert.equal(
    canReuseOpenCheckoutSession({
      session: {
        ...session,
        metadata: { ...session.metadata!, rentalAmountCents: "1" },
      },
      bookingId: "booking_dep",
      bookingReference: "EMR-DEP",
      allocation,
      storedPayment: stored,
    }),
    false,
  );

  // Zero-amount line item rejected.
  assert.equal(
    canReuseOpenCheckoutSession({
      session: {
        ...session,
        lineItems: [{ amountTotal: 0, amountSubtotal: 0, quantity: 1, currency: "eur" }],
      },
      bookingId: "booking_dep",
      bookingReference: "EMR-DEP",
      allocation,
      storedPayment: stored,
    }),
    false,
  );
}

function testIdempotencyKeyStabilityAndChange() {
  const allocation = validAllocation();
  const keyA = buildCheckoutIdempotencyKey({ bookingId: "booking_1", allocation });
  const keyB = buildCheckoutIdempotencyKey({ bookingId: "booking_1", allocation });
  assert.equal(keyA, keyB);
  assert.ok(keyA.length <= 255);

  const other = allocateCombinedCheckoutAmounts({
    totalDueOnlineEur: 450,
    rentalSubtotalEur: 200,
    depositAmountEur: 250,
    depositMethod: "ONLINE",
  });
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.notEqual(
    keyA,
    buildCheckoutIdempotencyKey({ bookingId: "booking_1", allocation: other }),
  );
}

function testEligibilityRejectsRefunded() {
  const base = {
    status: "CONFIRMED",
    paymentStatus: "PENDING",
    depositMethod: "ONLINE",
    totalDueOnline: 400,
    paymentProofUploadPath: null,
  };
  assert.equal(evaluateCheckoutBookingEligibility(base).ok, true);
  const refunded = evaluateCheckoutBookingEligibility({ ...base, paymentStatus: "REFUNDED" });
  assert.equal(refunded.ok, false);
}

function testErrorClassification() {
  assert.equal(classifyCheckoutSessionError({ statusCode: 404 }), "missing");
  assert.equal(classifyCheckoutSessionError({ code: "resource_missing" }), "missing");
  assert.equal(classifyCheckoutSessionError({ statusCode: 429 }), "ambiguous");
  assert.equal(classifyCheckoutSessionError({ statusCode: 500 }), "ambiguous");
  assert.equal(classifyCheckoutSessionError({ code: "rate_limit" }), "ambiguous");
  assert.equal(classifyCheckoutSessionError(new Error("timeout")), "ambiguous");
}

function testLockActiveHelper() {
  assert.equal(isCheckoutLockActive(null), false);
  assert.equal(
    isCheckoutLockActive({
      token: "t1",
      expiresAt: new Date(Date.now() + 10_000).toISOString(),
    }),
    true,
  );
  assert.equal(
    isCheckoutLockActive({
      token: "t1",
      expiresAt: new Date(Date.now() - 10_000).toISOString(),
    }),
    false,
  );
}

async function testRenewHelperDelegatesToDeps() {
  let seenToken: string | null = null;
  const deps: CheckoutLockDeps = {
    trySetCheckoutLock: async () => false,
    renewCheckoutLockIfOwned: async ({ token }) => {
      seenToken = token;
      return true;
    },
    clearCheckoutLock: async () => undefined,
  };
  const owned = await renewCheckoutOperationLockIfOwned(deps, "booking_1", "tok-9");
  assert.equal(owned, true);
  assert.equal(seenToken, "tok-9");
}

async function main() {
  testReuseRequiresCompleteLineItems();
  testDepositOnlySessionReuse();
  testIdempotencyKeyStabilityAndChange();
  testEligibilityRejectsRefunded();
  testErrorClassification();
  testLockActiveHelper();
  await testRenewHelperDelegatesToDeps();
  console.log("test-checkout-session-policy: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
