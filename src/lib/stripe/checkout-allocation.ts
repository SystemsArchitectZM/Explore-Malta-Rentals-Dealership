import { SECURITY_DEPOSIT_EUR } from "@/features/booking/lib/booking-schema";

export const SECURITY_DEPOSIT_CENTS = Math.round(SECURITY_DEPOSIT_EUR * 100);

export type CheckoutAllocation = {
  amountCents: number;
  rentalAmountCents: number;
  depositAmountCents: number;
};

export type CheckoutAllocationResult =
  | ({ ok: true } & CheckoutAllocation)
  | { ok: false; error: string };

export type CheckoutAllocationInput = {
  /** Combined amount charged online (booking.totalDueOnline). */
  totalDueOnlineEur: number;
  /**
   * Rental/booking charges payable online after loyalty credits
   * (not the raw booking.subtotal when loyalty applied).
   */
  rentalSubtotalEur: number;
  /** Stored deposit amount (booking.depositAmount). */
  depositAmountEur: number;
  /** Stored deposit method (booking.depositMethod). */
  depositMethod: string;
};

function toCents(amountEur: number): number {
  return Math.round(amountEur * 100);
}

/**
 * Builds integer-cent rental/deposit allocations for Stripe Checkout.
 * Rejects inconsistent booking totals rather than silently adjusting them.
 *
 * Deposit-only (loyalty covered the rental): rentalAmountCents may be 0 when
 * amountCents === depositAmountCents === SECURITY_DEPOSIT_CENTS.
 */
export function allocateCombinedCheckoutAmounts(
  input: CheckoutAllocationInput,
): CheckoutAllocationResult {
  const { totalDueOnlineEur, rentalSubtotalEur, depositAmountEur, depositMethod } = input;

  if (depositMethod !== "ONLINE") {
    return {
      ok: false,
      error: "Online checkout requires an ONLINE security deposit allocation",
    };
  }

  if (
    !Number.isFinite(totalDueOnlineEur) ||
    !Number.isFinite(rentalSubtotalEur) ||
    !Number.isFinite(depositAmountEur)
  ) {
    return { ok: false, error: "Payment amounts must be finite numbers" };
  }

  if (totalDueOnlineEur <= 0 || depositAmountEur <= 0) {
    return { ok: false, error: "Deposit and online total must be greater than zero" };
  }

  if (rentalSubtotalEur < 0) {
    return { ok: false, error: "Rental amount cannot be negative" };
  }

  const amountCents = toCents(totalDueOnlineEur);
  const rentalAmountCents = toCents(rentalSubtotalEur);
  const depositAmountCents = toCents(depositAmountEur);

  if (depositAmountCents !== SECURITY_DEPOSIT_CENTS) {
    return {
      ok: false,
      error: `Security deposit must be exactly €${SECURITY_DEPOSIT_EUR.toFixed(2)}`,
    };
  }

  if (depositAmountCents <= 0 || amountCents <= 0) {
    return { ok: false, error: "Allocation amounts must be positive integer cents" };
  }

  if (rentalAmountCents < 0) {
    return { ok: false, error: "Rental allocation cannot be negative" };
  }

  if (rentalAmountCents + depositAmountCents !== amountCents) {
    return {
      ok: false,
      error:
        "Online total must equal rental due (after loyalty) plus security deposit (cent-accurate)",
    };
  }

  return {
    ok: true,
    amountCents,
    rentalAmountCents,
    depositAmountCents,
  };
}

export type CheckoutLineItemSpec = {
  name: string;
  description: string;
  unitAmountCents: number;
  quantity: number;
  metadata?: Record<string, string>;
};

/** Expected Stripe line-item count for a validated allocation. */
export function expectedCheckoutLineItemCount(allocation: CheckoutAllocation): number {
  return allocation.rentalAmountCents > 0 ? 2 : 1;
}

/**
 * Builds Stripe Checkout line items for a validated allocation.
 * Positive rental → rental + deposit. Zero rental → deposit only (no €0 rental line).
 * Callers must ensure allocation.ok === true.
 */
export function buildCombinedCheckoutLineItems(input: {
  allocation: CheckoutAllocation;
  vehicleName: string;
  bookingId: string;
  bookingReference: string;
  pickupDate: string;
  returnDate: string;
}): CheckoutLineItemSpec[] {
  const { allocation, vehicleName, bookingId, bookingReference, pickupDate, returnDate } = input;

  const items: CheckoutLineItemSpec[] = [];

  if (allocation.rentalAmountCents > 0) {
    items.push({
      name: `${vehicleName} Rental`,
      description: `Booking ${bookingReference} · ${pickupDate} → ${returnDate}`,
      unitAmountCents: allocation.rentalAmountCents,
      quantity: 1,
      metadata: {
        bookingId,
        bookingReference,
        allocation: "rental",
      },
    });
  }

  items.push({
    name: "Security Deposit",
    description: `Refundable security deposit for booking ${bookingReference}`,
    unitAmountCents: allocation.depositAmountCents,
    quantity: 1,
    metadata: {
      bookingId,
      bookingReference,
      allocation: "security_deposit",
    },
  });

  return items;
}

export function lineItemsTotalCents(items: CheckoutLineItemSpec[]): number {
  return items.reduce((sum, item) => sum + item.unitAmountCents * item.quantity, 0);
}

/**
 * Integrity check for line items built from a validated allocation.
 * Rejects wrong counts, zero/negative unit amounts, and sum mismatches.
 */
export function checkoutLineItemsMatchAllocation(
  items: CheckoutLineItemSpec[],
  allocation: CheckoutAllocation,
): boolean {
  if (items.length !== expectedCheckoutLineItemCount(allocation)) {
    return false;
  }
  if (items.some((item) => item.unitAmountCents <= 0 || item.quantity !== 1)) {
    return false;
  }
  if (lineItemsTotalCents(items) !== allocation.amountCents) {
    return false;
  }

  if (allocation.rentalAmountCents === 0) {
    const only = items[0];
    return (
      only != null &&
      only.unitAmountCents === allocation.depositAmountCents &&
      only.metadata?.allocation === "security_deposit"
    );
  }

  const allocations = new Set(items.map((item) => item.metadata?.allocation));
  if (!allocations.has("rental") || !allocations.has("security_deposit")) {
    return false;
  }

  const rentalItem = items.find((item) => item.metadata?.allocation === "rental");
  const depositItem = items.find((item) => item.metadata?.allocation === "security_deposit");
  return (
    rentalItem?.unitAmountCents === allocation.rentalAmountCents &&
    depositItem?.unitAmountCents === allocation.depositAmountCents
  );
}
