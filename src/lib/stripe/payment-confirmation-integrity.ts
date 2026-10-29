/**
 * Pre-confirmation integrity checks for Stripe Checkout / PaymentIntent events.
 * Pure helpers — no Prisma or Stripe network. Fail closed when required
 * charge identity cannot be verified against the stored StripePayment row.
 */

export type StoredPaymentIntegrityFields = {
  amountCents: number;
  rentalAmountCents: number;
  depositAmountCents: number;
  currency: string;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
};

export type PaymentIntegrityFailureCode =
  | "PAYMENT_STATUS_NOT_PAID"
  | "AMOUNT_MISSING"
  | "AMOUNT_MISMATCH"
  | "CURRENCY_MISSING"
  | "CURRENCY_MISMATCH"
  | "CHECKOUT_SESSION_MISMATCH"
  | "PAYMENT_INTENT_MISMATCH"
  | "PAYMENT_ASSOCIATION_INSUFFICIENT"
  | "ALLOCATION_INCONSISTENT";

export type PaymentIntegrityResult =
  | { ok: true }
  | { ok: false; code: PaymentIntegrityFailureCode; message: string };

/** Stripe currency codes are lowercase; tolerate mixed case from older rows. */
export function normalizePaymentCurrency(currency: string): string {
  return currency.trim().toLowerCase();
}

/**
 * Persisted allocation must remain internally consistent.
 * Legacy rows typically store depositAmountCents=0 with rentalAmountCents=amountCents.
 */
export function validateStoredPaymentAllocation(
  payment: Pick<
    StoredPaymentIntegrityFields,
    "amountCents" | "rentalAmountCents" | "depositAmountCents"
  >,
): PaymentIntegrityResult {
  const { amountCents, rentalAmountCents, depositAmountCents } = payment;

  if (
    !Number.isInteger(amountCents) ||
    !Number.isInteger(rentalAmountCents) ||
    !Number.isInteger(depositAmountCents)
  ) {
    return {
      ok: false,
      code: "ALLOCATION_INCONSISTENT",
      message: "Stored payment amounts must be integers",
    };
  }

  if (amountCents <= 0 || rentalAmountCents < 0 || depositAmountCents < 0) {
    return {
      ok: false,
      code: "ALLOCATION_INCONSISTENT",
      message: "Stored payment allocation has invalid signs",
    };
  }

  if (rentalAmountCents + depositAmountCents !== amountCents) {
    return {
      ok: false,
      code: "ALLOCATION_INCONSISTENT",
      message: `Stored allocation inconsistent: rental ${rentalAmountCents} + deposit ${depositAmountCents} !== total ${amountCents}`,
    };
  }

  return { ok: true };
}

function validateAmountAndCurrency(input: {
  expectedAmountCents: number;
  expectedCurrency: string;
  actualAmountCents: number | null | undefined;
  actualCurrency: string | null | undefined;
}): PaymentIntegrityResult {
  if (input.actualAmountCents == null || !Number.isInteger(input.actualAmountCents)) {
    return {
      ok: false,
      code: "AMOUNT_MISSING",
      message: "Stripe charge amount is missing or not an integer",
    };
  }

  if (input.actualAmountCents !== input.expectedAmountCents) {
    return {
      ok: false,
      code: "AMOUNT_MISMATCH",
      message: `Stripe amount ${input.actualAmountCents} does not match stored ${input.expectedAmountCents}`,
    };
  }

  if (input.actualCurrency == null || input.actualCurrency.trim() === "") {
    return {
      ok: false,
      code: "CURRENCY_MISSING",
      message: "Stripe charge currency is missing",
    };
  }

  const expected = normalizePaymentCurrency(input.expectedCurrency);
  const actual = normalizePaymentCurrency(input.actualCurrency);
  if (!expected || actual !== expected) {
    return {
      ok: false,
      code: "CURRENCY_MISMATCH",
      message: `Stripe currency ${actual} does not match stored ${expected}`,
    };
  }

  return { ok: true };
}

/**
 * Validates a Checkout Session before confirming a not-yet-paid booking.
 * Caller must already ensure the stored row is unpaid / confirmable.
 */
export function validateCheckoutSessionForConfirmation(
  payment: StoredPaymentIntegrityFields,
  session: {
    id: string;
    payment_status: string;
    amount_total: number | null | undefined;
    currency: string | null | undefined;
  },
): PaymentIntegrityResult {
  if (session.payment_status !== "paid") {
    return {
      ok: false,
      code: "PAYMENT_STATUS_NOT_PAID",
      message: `Checkout session payment_status=${session.payment_status}`,
    };
  }

  const allocation = validateStoredPaymentAllocation(payment);
  if (!allocation.ok) return allocation;

  if (
    payment.stripeCheckoutSessionId != null &&
    payment.stripeCheckoutSessionId !== "" &&
    payment.stripeCheckoutSessionId !== session.id
  ) {
    return {
      ok: false,
      code: "CHECKOUT_SESSION_MISMATCH",
      message: `Session ${session.id} does not match stored ${payment.stripeCheckoutSessionId}`,
    };
  }

  return validateAmountAndCurrency({
    expectedAmountCents: payment.amountCents,
    expectedCurrency: payment.currency,
    actualAmountCents: session.amount_total,
    actualCurrency: session.currency,
  });
}

/**
 * Validates a PaymentIntent before confirming a not-yet-paid booking.
 *
 * Trusted association:
 * - Stored `stripePaymentIntentId` matches `intent.id`, or
 * - Stored PI id is empty and Checkout Session id is also empty (soft-reserve
 *   created without Stripe ids yet — rare), with amount/currency binding the charge,
 * - OR stored PI id is empty but a Checkout Session id exists: still allow when
 *   amount/currency match (Checkout creates the PI after the session row is stored).
 *
 * `bookingId` metadata alone never skips amount/currency checks. A stored PI id
 * that disagrees with the event is rejected.
 */
export function validatePaymentIntentForConfirmation(
  payment: StoredPaymentIntegrityFields,
  intent: {
    id: string;
    amount: number | null | undefined;
    currency: string | null | undefined;
  },
): PaymentIntegrityResult {
  const allocation = validateStoredPaymentAllocation(payment);
  if (!allocation.ok) return allocation;

  const storedPi = payment.stripePaymentIntentId?.trim() || null;
  if (storedPi && storedPi !== intent.id) {
    return {
      ok: false,
      code: "PAYMENT_INTENT_MISMATCH",
      message: `PaymentIntent ${intent.id} does not match stored ${storedPi}`,
    };
  }

  // No stored PI and no stored session: metadata bookingId is the only link —
  // insufficient without a Stripe object we previously persisted.
  const storedSession = payment.stripeCheckoutSessionId?.trim() || null;
  if (!storedPi && !storedSession) {
    return {
      ok: false,
      code: "PAYMENT_ASSOCIATION_INSUFFICIENT",
      message: "PaymentIntent cannot be associated without a stored Checkout Session or PaymentIntent id",
    };
  }

  return validateAmountAndCurrency({
    expectedAmountCents: payment.amountCents,
    expectedCurrency: payment.currency,
    actualAmountCents: intent.amount,
    actualCurrency: intent.currency,
  });
}
