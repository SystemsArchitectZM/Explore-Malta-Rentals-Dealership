import type { CheckoutAllocation } from "./checkout-allocation";

/** Bumps when Checkout Session line-item / metadata contract changes. */
export const CHECKOUT_FORMAT_VERSION = "combined-deposit-v1";

export type RetrievedCheckoutSession = {
  id: string;
  status: string | null;
  url: string | null;
  currency: string | null;
  amountTotal: number | null;
  paymentStatus: string | null;
  clientReferenceId: string | null;
  metadata: Record<string, string> | null;
  /**
   * True only when line items were loaded via a complete paginated list
   * (or an equivalent completeness proof). Expanded first-page-only data
   * must set this to false.
   */
  lineItemsComplete: boolean;
  lineItems: Array<{
    amountTotal: number | null;
    amountSubtotal: number | null;
    quantity: number | null;
    currency?: string | null;
  }>;
};

export type StoredStripePaymentForReuse = {
  id: string;
  stripeCheckoutSessionId: string | null;
  stripeStatus: string;
  amountCents: number | null;
  rentalAmountCents: number | null;
  depositAmountCents: number | null;
};

/**
 * Deterministic Stripe idempotency key for combined rental+deposit checkout.
 * Same logical checkout → same key; amount/allocation/version changes → new key.
 * Stripe allows up to 255 characters.
 */
export function buildCheckoutIdempotencyKey(input: {
  bookingId: string;
  allocation: CheckoutAllocation;
  formatVersion?: string;
}): string {
  const version = input.formatVersion ?? CHECKOUT_FORMAT_VERSION;
  const { bookingId, allocation } = input;
  return [
    "checkout",
    version,
    bookingId,
    String(allocation.amountCents),
    String(allocation.rentalAmountCents),
    String(allocation.depositAmountCents),
  ].join("_");
}

function normalizeCurrency(currency: string | null | undefined): string {
  return (currency ?? "").trim().toLowerCase();
}

/**
 * Returns true only when an open session is proven to match the current
 * combined-deposit checkout (amount, currency, booking, version metadata,
 * line-item amounts, and stored DB allocations).
 *
 * Valid shapes:
 * - Standard: two line items (positive rental + deposit).
 * - Deposit-only: one deposit line item (rental allocation 0).
 */
export function canReuseOpenCheckoutSession(input: {
  session: RetrievedCheckoutSession;
  bookingId: string;
  bookingReference: string;
  allocation: CheckoutAllocation;
  storedPayment: StoredStripePaymentForReuse;
  formatVersion?: string;
}): boolean {
  const version = input.formatVersion ?? CHECKOUT_FORMAT_VERSION;
  const { session, bookingId, bookingReference, allocation, storedPayment } = input;

  if (session.status !== "open" || !session.url) {
    return false;
  }

  if (normalizeCurrency(session.currency) !== "eur") {
    return false;
  }

  if (session.amountTotal !== allocation.amountCents) {
    return false;
  }

  if (session.clientReferenceId !== bookingReference) {
    return false;
  }

  const metadata = session.metadata ?? {};
  if (metadata.bookingId !== bookingId) {
    return false;
  }
  if (metadata.checkoutVersion !== version) {
    return false;
  }
  if (metadata.rentalAmountCents !== String(allocation.rentalAmountCents)) {
    return false;
  }
  if (metadata.depositAmountCents !== String(allocation.depositAmountCents)) {
    return false;
  }
  if (metadata.amountCents !== String(allocation.amountCents)) {
    return false;
  }

  if (
    storedPayment.amountCents !== allocation.amountCents ||
    storedPayment.rentalAmountCents !== allocation.rentalAmountCents ||
    storedPayment.depositAmountCents !== allocation.depositAmountCents
  ) {
    return false;
  }

  if (!session.lineItemsComplete) {
    return false;
  }

  const expectedLineAmounts =
    allocation.rentalAmountCents > 0
      ? [allocation.rentalAmountCents, allocation.depositAmountCents]
      : [allocation.depositAmountCents];

  if (session.lineItems.length !== expectedLineAmounts.length) {
    return false;
  }

  const lineAmounts: number[] = [];
  for (const item of session.lineItems) {
    if (item.currency != null && normalizeCurrency(item.currency) !== "eur") {
      return false;
    }
    const unit = item.amountTotal ?? item.amountSubtotal;
    if (unit == null || !Number.isFinite(unit) || unit <= 0) {
      return false;
    }
    // Stripe line item amount_total is for the line (qty already applied).
    lineAmounts.push(unit);
  }

  const sortedLine = [...lineAmounts].sort((a, b) => a - b);
  const sortedExpected = [...expectedLineAmounts].sort((a, b) => a - b);

  if (sortedLine.length !== sortedExpected.length) {
    return false;
  }
  for (let i = 0; i < sortedExpected.length; i += 1) {
    if (sortedLine[i] !== sortedExpected[i]) {
      return false;
    }
  }

  const lineSum = lineAmounts.reduce((sum, value) => sum + value, 0);
  if (lineSum !== allocation.amountCents) {
    return false;
  }

  return true;
}

export function isCheckoutSessionPaidOrComplete(session: {
  status: string | null;
  paymentStatus: string | null;
}): boolean {
  return session.paymentStatus === "paid" || session.status === "complete";
}

/** Session is confirmed not open (expired or other non-open status). */
export function isCheckoutSessionConfirmedNotOpen(session: {
  status: string | null;
}): boolean {
  return session.status != null && session.status !== "open";
}

export type CheckoutEligibilityBooking = {
  status: string;
  paymentStatus: string;
  depositMethod: string;
  totalDueOnline: number;
  paymentProofUploadPath: string | null;
};

/**
 * Shared eligibility for starting Stripe checkout (JSON + redirect routes).
 */
export function evaluateCheckoutBookingEligibility(
  booking: CheckoutEligibilityBooking,
): { ok: true } | { ok: false; error: string; httpStatus: number } {
  if (booking.status === "CANCELLED") {
    return {
      ok: false,
      error: "This booking was cancelled because payment was not completed in time",
      httpStatus: 409,
    };
  }

  if (booking.status !== "PENDING_PAYMENT" && booking.status !== "CONFIRMED") {
    return {
      ok: false,
      error: "This booking cannot accept online payment",
      httpStatus: 409,
    };
  }

  if (booking.paymentStatus === "PAID") {
    return { ok: false, error: "This booking has already been paid", httpStatus: 409 };
  }

  if (booking.paymentStatus === "REFUNDED") {
    return { ok: false, error: "This booking has been refunded", httpStatus: 409 };
  }

  if (booking.paymentProofUploadPath || booking.totalDueOnline <= 0) {
    return { ok: false, error: "No online payment is due for this booking", httpStatus: 422 };
  }

  if (booking.depositMethod !== "ONLINE") {
    return {
      ok: false,
      error: "Online checkout requires an ONLINE security deposit",
      httpStatus: 422,
    };
  }

  return { ok: true };
}
