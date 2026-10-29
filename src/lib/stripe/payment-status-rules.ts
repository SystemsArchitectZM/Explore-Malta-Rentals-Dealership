/**
 * Pure StripePaymentStatus classification and refund-status derivation.
 * No Prisma / Stripe / I/O — shared rules for later G1 refund-safety wiring.
 *
 * Distinct from Booking.paymentStatus (PENDING | PAID | REFUNDED | FAILED).
 */

/**
 * Mirrors Prisma `StripePaymentStatus` without importing the generated client
 * (same pattern as `WebhookEventStatusValue` in types.ts).
 */
export const STRIPE_PAYMENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "DISPUTED",
  "EXPIRED",
] as const;

export type StripePaymentStatusValue = (typeof STRIPE_PAYMENT_STATUSES)[number];

/** Payments that have cleared successfully; late unpaid events must not regress them. */
export const PAID_LINEAGE_STRIPE_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "DISPUTED",
] as const satisfies readonly StripePaymentStatusValue[];

export type PaidLineageStripePaymentStatus =
  (typeof PAID_LINEAGE_STRIPE_PAYMENT_STATUSES)[number];

/** Statuses that may accept a new admin refund attempt (future eligibility allowlist). */
export const REFUND_ELIGIBLE_STRIPE_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
] as const satisfies readonly StripePaymentStatusValue[];

export type RefundEligibleStripePaymentStatus =
  (typeof REFUND_ELIGIBLE_STRIPE_PAYMENT_STATUSES)[number];

/**
 * Paid-lineage statuses that may still receive a booking-confirmation email.
 * REFUNDED and DISPUTED are intentionally excluded.
 */
export const CONFIRMATION_ELIGIBLE_STRIPE_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
] as const satisfies readonly StripePaymentStatusValue[];

export type ConfirmationEligibleStripePaymentStatus =
  (typeof CONFIRMATION_ELIGIBLE_STRIPE_PAYMENT_STATUSES)[number];

/**
 * Statuses from which a refund-counter writer may update `stripeStatus`.
 * Excludes DISPUTED and all unpaid statuses so accounting cannot clear a dispute
 * or promote an unpaid row.
 */
export const REFUND_PRESERVABLE_STRIPE_PAYMENT_STATUSES = [
  "SUCCEEDED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
] as const satisfies readonly StripePaymentStatusValue[];

export type RefundPreservableStripePaymentStatus =
  (typeof REFUND_PRESERVABLE_STRIPE_PAYMENT_STATUSES)[number];

/** Known unpaid / not-yet-paid Stripe payment statuses. */
export const UNPAID_STRIPE_PAYMENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const satisfies readonly StripePaymentStatusValue[];

export type UnpaidStripePaymentStatus = (typeof UNPAID_STRIPE_PAYMENT_STATUSES)[number];

/**
 * Statuses that may be written to FAILED / CANCELLED by late unpaid events.
 * Complementary to paid lineage — unknown statuses fail closed (not included).
 */
export const UNPAID_TERMINAL_WRITABLE_STRIPE_PAYMENT_STATUSES = UNPAID_STRIPE_PAYMENT_STATUSES;

/**
 * Statuses that may transition to EXPIRED for a matching Checkout Session.
 * Paid lineage is excluded; EXPIRED is excluded so a replay cannot re-release.
 */
export const CHECKOUT_EXPIRY_WRITABLE_STRIPE_PAYMENT_STATUSES = [
  "PENDING",
  "PROCESSING",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly UnpaidStripePaymentStatus[];

export type CheckoutExpiryWritableStripePaymentStatus =
  (typeof CHECKOUT_EXPIRY_WRITABLE_STRIPE_PAYMENT_STATUSES)[number];

export type DerivedRefundStripeStatus = "REFUNDED" | "PARTIALLY_REFUNDED";

/**
 * Zero refunded amount and invalid inputs return `{ ok: false }` — callers must
 * not treat those as a derived refund status.
 *
 * Overage (`refundedAmountCents > amountCents`) is accepted as `REFUNDED`, matching
 * existing writers that use `refunded >= amount` for a full refund. Separate
 * accounting integrity checks may still reject overstated counters elsewhere.
 */
export type DeriveRefundStripeStatusResult =
  | { ok: true; stripeStatus: DerivedRefundStripeStatus }
  | { ok: false; error: string };

function isMemberOf<T extends string>(
  status: string,
  set: readonly T[],
): status is T {
  return (set as readonly string[]).includes(status);
}

export function isPaidLineageStripePaymentStatus(
  status: string,
): status is PaidLineageStripePaymentStatus {
  return isMemberOf(status, PAID_LINEAGE_STRIPE_PAYMENT_STATUSES);
}

export function isRefundEligibleStripePaymentStatus(
  status: string,
): status is RefundEligibleStripePaymentStatus {
  return isMemberOf(status, REFUND_ELIGIBLE_STRIPE_PAYMENT_STATUSES);
}

export function isConfirmationEligibleStripePaymentStatus(
  status: string,
): status is ConfirmationEligibleStripePaymentStatus {
  return isMemberOf(status, CONFIRMATION_ELIGIBLE_STRIPE_PAYMENT_STATUSES);
}

export function isRefundPreservableStripePaymentStatus(
  status: string,
): status is RefundPreservableStripePaymentStatus {
  return isMemberOf(status, REFUND_PRESERVABLE_STRIPE_PAYMENT_STATUSES);
}

export function isUnpaidStripePaymentStatus(
  status: string,
): status is UnpaidStripePaymentStatus {
  return isMemberOf(status, UNPAID_STRIPE_PAYMENT_STATUSES);
}

export function isCheckoutExpiryWritableStripePaymentStatus(
  status: string,
): status is CheckoutExpiryWritableStripePaymentStatus {
  return isMemberOf(status, CHECKOUT_EXPIRY_WRITABLE_STRIPE_PAYMENT_STATUSES);
}

/** Prisma `where.stripeStatus` for FAILED / CANCELLED writes. */
export function unpaidTerminalWritableStripeStatusFilter(): {
  in: UnpaidStripePaymentStatus[];
} {
  return { in: [...UNPAID_TERMINAL_WRITABLE_STRIPE_PAYMENT_STATUSES] };
}

/** Prisma `where.stripeStatus` for checkout.session.expired writes. */
export function checkoutExpiryWritableStripeStatusFilter(): {
  in: CheckoutExpiryWritableStripePaymentStatus[];
} {
  return { in: [...CHECKOUT_EXPIRY_WRITABLE_STRIPE_PAYMENT_STATUSES] };
}

/**
 * Release the booking only after an unpaid-terminal payment write actually
 * matched a row. A zero-count update means paid-lineage (or missing row) and
 * must not cancel the booking.
 */
export function shouldReleaseBookingAfterUnpaidTerminalWrite(updatedCount: number): boolean {
  return updatedCount > 0;
}

function assertSafeIntegerCents(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer number of cents`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer number of cents`);
  }
  return value;
}

/**
 * Derives the post-refund `StripePaymentStatus` from payment and cumulative
 * refunded amounts (integer cents only).
 *
 * - `refundedAmountCents >= amountCents` → `REFUNDED` (including overage)
 * - `0 < refundedAmountCents < amountCents` → `PARTIALLY_REFUNDED`
 * - `refundedAmountCents === 0` → `{ ok: false }` (no refund status to derive)
 * - Invalid amounts throw (finite safe integer cents; payment amount must be
 *   positive; refunded amount must be non-negative)
 */
export function deriveRefundStripeStatus(input: {
  amountCents: number;
  refundedAmountCents: number;
}): DeriveRefundStripeStatusResult {
  const amountCents = assertSafeIntegerCents(input.amountCents, "amountCents");
  const refundedAmountCents = assertSafeIntegerCents(
    input.refundedAmountCents,
    "refundedAmountCents",
  );

  if (amountCents <= 0) {
    throw new Error("amountCents must be a positive integer number of cents");
  }
  if (refundedAmountCents < 0) {
    throw new Error("refundedAmountCents must be a non-negative integer number of cents");
  }

  if (refundedAmountCents === 0) {
    return {
      ok: false,
      error: "Cannot derive a refund stripeStatus when refundedAmountCents is 0",
    };
  }

  if (refundedAmountCents >= amountCents) {
    return { ok: true, stripeStatus: "REFUNDED" };
  }

  return { ok: true, stripeStatus: "PARTIALLY_REFUNDED" };
}
