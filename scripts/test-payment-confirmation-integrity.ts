/**
 * Pure payment-confirmation integrity helpers (no DB / Stripe network).
 *
 *   npm run test:payment-confirmation-integrity
 */

import assert from "node:assert/strict";

import {
  normalizePaymentCurrency,
  validateCheckoutSessionForConfirmation,
  validatePaymentIntentForConfirmation,
  validateStoredPaymentAllocation,
  type StoredPaymentIntegrityFields,
} from "../src/lib/stripe/payment-confirmation-integrity";
import { WebhookPermanentError } from "../src/lib/stripe/webhook-errors";

const ordinary: StoredPaymentIntegrityFields = {
  amountCents: 30000,
  rentalAmountCents: 5000,
  depositAmountCents: 25000,
  currency: "eur",
  stripeCheckoutSessionId: "cs_1",
  stripePaymentIntentId: "pi_1",
};

const depositOnly: StoredPaymentIntegrityFields = {
  amountCents: 25000,
  rentalAmountCents: 0,
  depositAmountCents: 25000,
  currency: "EUR",
  stripeCheckoutSessionId: "cs_dep",
  stripePaymentIntentId: null,
};

function testAllocationAndCurrencyNormalization() {
  assert.equal(normalizePaymentCurrency("EUR"), "eur");
  assert.equal(validateStoredPaymentAllocation(ordinary).ok, true);
  assert.equal(validateStoredPaymentAllocation(depositOnly).ok, true);
  assert.equal(
    validateStoredPaymentAllocation({
      amountCents: 100,
      rentalAmountCents: 40,
      depositAmountCents: 50,
    }).ok,
    false,
  );
}

function testCheckoutSessionHappyPaths() {
  const ordinaryOk = validateCheckoutSessionForConfirmation(ordinary, {
    id: "cs_1",
    payment_status: "paid",
    amount_total: 30000,
    currency: "eur",
  });
  assert.equal(ordinaryOk.ok, true);

  const depositOk = validateCheckoutSessionForConfirmation(depositOnly, {
    id: "cs_dep",
    payment_status: "paid",
    amount_total: 25000,
    currency: "eur",
  });
  assert.equal(depositOk.ok, true);
}

function testCheckoutSessionFailures() {
  assert.equal(
    validateCheckoutSessionForConfirmation(ordinary, {
      id: "cs_1",
      payment_status: "unpaid",
      amount_total: 30000,
      currency: "eur",
    }).ok,
    false,
  );

  const amount = validateCheckoutSessionForConfirmation(ordinary, {
    id: "cs_1",
    payment_status: "paid",
    amount_total: 1,
    currency: "eur",
  });
  assert.equal(amount.ok, false);
  if (!amount.ok) assert.equal(amount.code, "AMOUNT_MISMATCH");

  const currency = validateCheckoutSessionForConfirmation(ordinary, {
    id: "cs_1",
    payment_status: "paid",
    amount_total: 30000,
    currency: "usd",
  });
  assert.equal(currency.ok, false);
  if (!currency.ok) assert.equal(currency.code, "CURRENCY_MISMATCH");

  const session = validateCheckoutSessionForConfirmation(ordinary, {
    id: "cs_other",
    payment_status: "paid",
    amount_total: 30000,
    currency: "eur",
  });
  assert.equal(session.ok, false);
  if (!session.ok) assert.equal(session.code, "CHECKOUT_SESSION_MISMATCH");

  const missing = validateCheckoutSessionForConfirmation(ordinary, {
    id: "cs_1",
    payment_status: "paid",
    amount_total: null,
    currency: "eur",
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "AMOUNT_MISSING");
}

function testPaymentIntentAssociationAndAmount() {
  const ok = validatePaymentIntentForConfirmation(ordinary, {
    id: "pi_1",
    amount: 30000,
    currency: "eur",
  });
  assert.equal(ok.ok, true);

  const wrongPi = validatePaymentIntentForConfirmation(ordinary, {
    id: "pi_other",
    amount: 30000,
    currency: "eur",
  });
  assert.equal(wrongPi.ok, false);
  if (!wrongPi.ok) assert.equal(wrongPi.code, "PAYMENT_INTENT_MISMATCH");

  const wrongAmount = validatePaymentIntentForConfirmation(ordinary, {
    id: "pi_1",
    amount: 999,
    currency: "eur",
  });
  assert.equal(wrongAmount.ok, false);
  if (!wrongAmount.ok) assert.equal(wrongAmount.code, "AMOUNT_MISMATCH");

  const noIds: StoredPaymentIntegrityFields = {
    ...ordinary,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
  };
  const insufficient = validatePaymentIntentForConfirmation(noIds, {
    id: "pi_1",
    amount: 30000,
    currency: "eur",
  });
  assert.equal(insufficient.ok, false);
  if (!insufficient.ok) assert.equal(insufficient.code, "PAYMENT_ASSOCIATION_INSUFFICIENT");

  // Session stored, PI not yet — amount bind is enough.
  const viaSession = validatePaymentIntentForConfirmation(depositOnly, {
    id: "pi_new",
    amount: 25000,
    currency: "eur",
  });
  assert.equal(viaSession.ok, true);
}

function testPermanentErrorCodeIncludesIntegrity() {
  const err = new WebhookPermanentError("PAYMENT_INTEGRITY_MISMATCH", "amount");
  assert.equal(err.code, "PAYMENT_INTEGRITY_MISMATCH");
  assert.equal(err.name, "WebhookPermanentError");
}

function main() {
  testAllocationAndCurrencyNormalization();
  testCheckoutSessionHappyPaths();
  testCheckoutSessionFailures();
  testPaymentIntentAssociationAndAmount();
  testPermanentErrorCodeIncludesIntegrity();
  console.log("payment-confirmation-integrity tests passed");
}

main();
