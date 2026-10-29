/**
 * Pure purpose-aware refund accounting (integer cents).
 * No Prisma / Stripe — deterministic unit tests only.
 */

export type RefundPurposeAdmin = "RENTAL" | "SECURITY_DEPOSIT";
export type RefundPurpose = RefundPurposeAdmin | "UNSPECIFIED";

export type PaymentRefundCounters = {
  amountCents: number;
  rentalAmountCents: number;
  depositAmountCents: number;
  refundedAmountCents: number;
  rentalRefundedCents: number;
  depositRefundedCents: number;
};

export type PendingRefundReservation = {
  purpose: RefundPurpose;
  amountCents: number;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
};

export type HistoricalStripeRefundMirror = {
  stripeRefundId: string;
  amountCents: number;
};

export type LinkedRefundRequest = {
  stripeRefundId: string | null;
  purpose: RefundPurpose;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  amountCents: number;
};

export function assertPositiveIntegerCents(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer number of cents`);
  }
  if (value <= 0) {
    throw new Error(`${label} must be a positive integer number of cents`);
  }
  return value;
}

export function assertNonNegativeIntegerCents(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${label} must be a finite integer number of cents`);
  }
  if (value < 0) {
    throw new Error(`${label} must be a non-negative integer number of cents`);
  }
  return value;
}

export function assertPaymentAllocationIntegrity(payment: PaymentRefundCounters): void {
  assertNonNegativeIntegerCents(payment.amountCents, "amountCents");
  assertNonNegativeIntegerCents(payment.rentalAmountCents, "rentalAmountCents");
  assertNonNegativeIntegerCents(payment.depositAmountCents, "depositAmountCents");
  assertNonNegativeIntegerCents(payment.refundedAmountCents, "refundedAmountCents");
  assertNonNegativeIntegerCents(payment.rentalRefundedCents, "rentalRefundedCents");
  assertNonNegativeIntegerCents(payment.depositRefundedCents, "depositRefundedCents");

  if (payment.rentalAmountCents + payment.depositAmountCents !== payment.amountCents) {
    throw new Error("rentalAmountCents + depositAmountCents must equal amountCents");
  }
  if (payment.rentalRefundedCents > payment.rentalAmountCents) {
    throw new Error("rentalRefundedCents cannot exceed rentalAmountCents");
  }
  if (payment.depositRefundedCents > payment.depositAmountCents) {
    throw new Error("depositRefundedCents cannot exceed depositAmountCents");
  }
  if (payment.refundedAmountCents > payment.amountCents) {
    throw new Error("refundedAmountCents cannot exceed amountCents");
  }
}

export function sumPendingReservations(
  reservations: PendingRefundReservation[],
  purpose?: RefundPurposeAdmin,
): number {
  let sum = 0;
  for (const row of reservations) {
    if (row.status !== "PENDING") continue;
    assertPositiveIntegerCents(row.amountCents, "pending reservation amountCents");
    if (purpose && row.purpose !== purpose) continue;
    sum += row.amountCents;
  }
  return sum;
}

export type RefundAvailability = {
  rentalAvailableCents: number;
  depositAvailableCents: number;
  combinedAvailableCents: number;
};

export function computeRefundAvailability(
  payment: PaymentRefundCounters,
  pending: PendingRefundReservation[],
): RefundAvailability {
  assertPaymentAllocationIntegrity(payment);
  const pendingRental = sumPendingReservations(pending, "RENTAL");
  const pendingDeposit = sumPendingReservations(pending, "SECURITY_DEPOSIT");
  const pendingAll = sumPendingReservations(pending);

  return {
    rentalAvailableCents: Math.max(
      0,
      payment.rentalAmountCents - payment.rentalRefundedCents - pendingRental,
    ),
    depositAvailableCents: Math.max(
      0,
      payment.depositAmountCents - payment.depositRefundedCents - pendingDeposit,
    ),
    combinedAvailableCents: Math.max(
      0,
      payment.amountCents - payment.refundedAmountCents - pendingAll,
    ),
  };
}

/**
 * Availability from authoritative SUCCEEDED request sums + PENDING reservations.
 * Ignores stored payment.*RefundedCents counters so stale under/over-statements
 * cannot authorize (or falsely block) purpose recovery / refunds.
 *
 * Combined available also uses the absolute SUCCEEDED purpose sum — not a possibly
 * inflated aggregate charge counter. Callers that must fail-closed on unmatched
 * historical mirrors should run detectHistoricalRefundAmbiguity separately.
 */
export function computeAuthoritativeRefundAvailability(input: {
  payment: Pick<
    PaymentRefundCounters,
    "amountCents" | "rentalAmountCents" | "depositAmountCents"
  >;
  requests: Array<{
    id: string;
    purpose: RefundPurpose;
    status: string;
    amountCents: number;
  }>;
  /** Exclude these ids from PENDING reservation (e.g. target already counted elsewhere). */
  excludePendingRequestIds?: ReadonlyArray<string>;
}): RefundAvailability {
  const exclude = new Set(input.excludePendingRequestIds ?? []);
  const succeeded = sumSucceededRefundCounters(input.requests);
  const pending: PendingRefundReservation[] = [];
  for (const row of input.requests) {
    if (row.status !== "PENDING") continue;
    if (exclude.has(row.id)) continue;
    pending.push({
      purpose: row.purpose,
      amountCents: row.amountCents,
      status: "PENDING",
    });
  }

  return computeRefundAvailability(
    {
      amountCents: input.payment.amountCents,
      rentalAmountCents: input.payment.rentalAmountCents,
      depositAmountCents: input.payment.depositAmountCents,
      rentalRefundedCents: succeeded.rentalRefundedCents,
      depositRefundedCents: succeeded.depositRefundedCents,
      refundedAmountCents: succeeded.refundedAmountCents,
    },
    pending,
  );
}

export function assertPurposeRefundFits(input: {
  purpose: RefundPurposeAdmin;
  amountCents: number;
  availability: RefundAvailability;
}): void {
  const amount = assertPositiveIntegerCents(input.amountCents, "refund amountCents");
  const purposeAvailable =
    input.purpose === "RENTAL"
      ? input.availability.rentalAvailableCents
      : input.availability.depositAvailableCents;

  if (amount > purposeAvailable) {
    throw new Error(
      `Refund amount exceeds ${input.purpose} available capacity of ${purposeAvailable} cents`,
    );
  }
  if (amount > input.availability.combinedAvailableCents) {
    throw new Error(
      `Refund amount exceeds combined available capacity of ${input.availability.combinedAvailableCents} cents`,
    );
  }
}

/**
 * Historical StripeRefund rows without a matching SUCCEEDED/PENDING request
 * (by stripeRefundId) are purpose-unknown. Unallocated combined refunded
 * amounts are also ambiguous. UNSPECIFIED requests count as unresolved.
 */
export function detectHistoricalRefundAmbiguity(input: {
  payment: PaymentRefundCounters;
  stripeRefunds: HistoricalStripeRefundMirror[];
  requests: LinkedRefundRequest[];
}): { ambiguous: boolean; reasons: string[] } {
  const reasons: string[] = [];
  assertPaymentAllocationIntegrity(input.payment);

  const linkedIds = new Set(
    input.requests
      .filter((r) => r.stripeRefundId && (r.status === "SUCCEEDED" || r.status === "PENDING"))
      .map((r) => r.stripeRefundId as string),
  );

  for (const refund of input.stripeRefunds) {
    if (!linkedIds.has(refund.stripeRefundId)) {
      reasons.push(`unmatched_stripe_refund:${refund.stripeRefundId}`);
    }
  }

  for (const request of input.requests) {
    if (
      request.purpose === "UNSPECIFIED" &&
      (request.status === "PENDING" || request.status === "SUCCEEDED")
    ) {
      reasons.push("unspecified_request");
    }
  }

  const purposeSucceeded =
    input.payment.rentalRefundedCents + input.payment.depositRefundedCents;
  if (input.payment.refundedAmountCents > purposeSucceeded) {
    reasons.push("unallocated_combined_refunded_amount");
  }

  return { ambiguous: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export function eurosToCents(amountEur: number): number {
  if (typeof amountEur !== "number" || !Number.isFinite(amountEur)) {
    throw new Error("amountEur must be a finite number");
  }
  return assertPositiveIntegerCents(Math.round(amountEur * 100), "amountEur as cents");
}

export function buildStripeRefundIdempotencyKey(
  stripePaymentId: string,
  clientRequestId: string,
): string {
  if (!stripePaymentId.trim() || !clientRequestId.trim()) {
    throw new Error("stripePaymentId and clientRequestId are required for idempotency");
  }
  return `refund:${stripePaymentId}:${clientRequestId}`;
}

/**
 * Absolute purpose counters from SUCCEEDED requests only.
 * Used inside locked transactions so API/webhook/reconcile never double-count.
 */
export function sumSucceededRefundCounters(
  requests: Array<{ purpose: RefundPurpose; status: string; amountCents: number }>,
): { rentalRefundedCents: number; depositRefundedCents: number; refundedAmountCents: number } {
  let rentalRefundedCents = 0;
  let depositRefundedCents = 0;
  for (const req of requests) {
    if (req.status !== "SUCCEEDED") continue;
    assertPositiveIntegerCents(req.amountCents, "succeeded request amountCents");
    if (req.purpose === "RENTAL") rentalRefundedCents += req.amountCents;
    if (req.purpose === "SECURITY_DEPOSIT") depositRefundedCents += req.amountCents;
  }
  return {
    rentalRefundedCents,
    depositRefundedCents,
    refundedAmountCents: rentalRefundedCents + depositRefundedCents,
  };
}
