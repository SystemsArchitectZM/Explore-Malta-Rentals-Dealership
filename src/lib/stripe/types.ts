export type CreateCheckoutSessionInput = {
  bookingId: string;
  bookingReference: string;
  customerEmail: string;
  customerName: string;
  vehicleName: string;
  pickupDate: string;
  returnDate: string;
  /**
   * Combined online total in euros (booking.totalDueOnline).
   * Must equal rentalSubtotalEur + depositAmountEur at cent precision.
   */
  amountEur: number;
  /**
   * Rental/booking charges payable online after loyalty credits.
   * May be 0 when loyalty covers the full rental (deposit-only Checkout).
   */
  rentalSubtotalEur: number;
  /** Security deposit in euros (booking.depositAmount); must be the fixed €250. */
  depositAmountEur: number;
  /** Must be ONLINE for standard Stripe checkout. */
  depositMethod: "ONLINE" | "IN_PERSON" | string;
  locale?: string;
};

export type CreateCheckoutSessionResult =
  | { ok: true; checkoutUrl: string; sessionId: string }
  | { ok: false; error: string };

/** Mirrors the Prisma enum WebhookEventStatus without importing the generated client. */
export type WebhookEventStatusValue =
  | "RECEIVED"
  | "PROCESSING"
  | "PROCESSED"
  | "RETRYABLE_FAILED"
  | "DEAD_LETTER";

/**
 * Stable machine-readable failure codes. Safe to return over HTTP (never contain
 * stack traces, SQL, or secrets) and safe to alert on.
 */
export type WebhookFailureCode =
  /** Infrastructure/database failure recognised by structured error codes. */
  | "DB_TRANSIENT"
  /** Any other unexpected handler error (fail closed: retryable). */
  | "HANDLER_ERROR"
  | "EVENT_RECORD_FAILED"
  | "CLAIM_FAILED"
  /** Row changed state between the conditional claim and the follow-up read. */
  | "CLAIM_STATE_CHANGED"
  /** Our claim was superseded (lease expired and a newer worker claimed). */
  | "CLAIM_SUPERSEDED"
  /** Handler finished but the event could not be marked processed. */
  | "FINALIZE_FAILED"
  | "DEAD_LETTER_PERSIST_FAILED"
  /** Documented permanent classifications thrown by handlers. */
  | "EVENT_METADATA_MISSING"
  | "BOOKING_CANCELLED_PAYMENT_RECEIVED"
  /** Stored payload is not a usable Stripe event object (recovery of a corrupt row). */
  | "EVENT_PAYLOAD_INVALID"
  /**
   * Stripe charge identity (amount/currency/session/PI) does not match the stored
   * StripePayment row. Redelivery of the same payload cannot succeed.
   */
  | "PAYMENT_INTEGRITY_MISMATCH"
  /** Operational terminal dispositions. */
  | "RETRY_LIMIT_EXCEEDED"
  | "EVENT_DEAD_LETTERED";

/**
 * Typed webhook processing outcome. HTTP status is derived from `outcome` only
 * (see webhook-http-policy.ts) — never from error message text.
 */
export type ProcessWebhookResult =
  | { outcome: "processed"; action: string; attemptCount: number }
  /** Valid event type we intentionally do not act on; terminal decision recorded as PROCESSED. */
  | { outcome: "ignored"; action: string; attemptCount: number }
  | { outcome: "already_processed" }
  /** Another worker holds a valid (unexpired) lease; this delivery ran no handler. */
  | { outcome: "in_flight" }
  | {
      outcome: "retryable_failure";
      code: WebhookFailureCode;
      /** True when the handler completed but the event could not be finalized. */
      handlerCompleted: boolean;
    }
  | {
      outcome: "permanent_failure";
      code: WebhookFailureCode;
      /** True only when DEAD_LETTER was durably recorded (now or previously). */
      deadLettered: boolean;
    };

/**
 * Returned ONLY by the recovery entry point (never by live Stripe delivery handling,
 * so it is deliberately NOT part of ProcessWebhookResult / the HTTP policy). It means
 * the recovery-specific eligibility predicate no longer held at claim time (for
 * example another attempt just happened and the backoff is not satisfied). Nothing was
 * claimed, no handler ran, and no WebhookEvent state changed: it is a skip, not a
 * processing failure.
 */
export type WebhookRecoveryIneligibleResult = { outcome: "recovery_not_eligible" };

export type CreateRefundInput = {
  bookingId: string;
  /** Amount in euros — full remaining purpose amount if omitted */
  amountEur?: number;
  purpose: "RENTAL" | "SECURITY_DEPOSIT";
  /** Stable client identity for this logical refund attempt */
  clientRequestId: string;
  reason: "duplicate" | "fraudulent" | "requested_by_customer";
  initiatedBy: string;
  notes?: string;
};

export type CreateRefundResult =
  | {
      ok: true;
      status: "succeeded" | "pending";
      refundId: string | null;
      requestId: string;
      clientRequestId: string;
      amountEur: number;
      purpose: "RENTAL" | "SECURITY_DEPOSIT";
    }
  | { ok: false; error: string; code?: string };

export type ReconcileHistoricalRefundsInput = {
  stripePaymentId: string;
  /** Each unmatched historical Stripe refund id mapped to an explicit purpose */
  allocations: Array<{
    stripeRefundId: string;
    purpose: "RENTAL" | "SECURITY_DEPOSIT";
  }>;
  evidence: string;
  initiatedBy: string;
};

export type ReconcileHistoricalRefundsResult =
  | { ok: true; reconciledCount: number }
  | { ok: false; error: string; code?: string };

export type RecoverTerminalRefundInput = {
  stripePaymentId: string;
  requestId: string;
  stripeRefundId: string;
  /** Explicit audited evidence / reason (minimum length enforced by service). */
  evidence: string;
  initiatedBy: string;
  /**
   * Optional consistency check when the stored purpose is already RENTAL or
   * SECURITY_DEPOSIT. UNSPECIFIED terminal requests are not recoverable here
   * (fail closed — free-text evidence is not allocation proof).
   */
  purpose?: "RENTAL" | "SECURITY_DEPOSIT";
  /** Optional hard check against the request's clientRequestId. */
  expectedClientRequestId?: string;
  /** Optional hard check against StripePayment.currency when provided. */
  expectedCurrency?: string;
};

export type RecoverTerminalRefundResult =
  | {
      ok: true;
      requestId: string;
      stripeRefundId: string;
      purpose: "RENTAL" | "SECURITY_DEPOSIT";
      amountCents: number;
      idempotent: boolean;
      mirrorRepaired: boolean;
    }
  | { ok: false; error: string; code?: string };

export type AuditAction =
  | "checkout_session_created"
  | "payment_succeeded"
  | "payment_failed"
  | "payment_cancelled"
  | "refund_initiated"
  | "refund_succeeded"
  | "refund_failed"
  | "refund_pending"
  | "refund_ambiguous"
  | "refund_persist_incomplete"
  | "refund_reconciled"
  | "refund_terminal_recovered"
  | "refund_mirror_repaired"
  | "dispute_created"
  | "dispute_closed"
  | "webhook_received"
  | "webhook_duplicate"
  | "webhook_in_flight_skipped"
  | "webhook_claim_reclaimed"
  | "webhook_retryable_failure"
  | "webhook_dead_lettered"
  | "webhook_stale_finalization_rejected"
  | "webhook_finalize_failed"
  /** ADMIN-triggered bounded webhook recovery run (counts only; no payloads). */
  | "webhook_recovery_run"
  | "booking_payment_status_updated";
