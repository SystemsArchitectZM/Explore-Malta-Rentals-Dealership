/**
 * Session-scoped checkout.session.expired handling (injectable for mocked tests).
 * Does not contact Stripe or open a DB connection by itself.
 */

import {
  checkoutSessionExpiredRetryErrorMessage,
  decideCheckoutSessionExpiredEffect,
} from "./checkout-session-expired-policy";

export type CheckoutSessionExpiredPaymentSnapshot = {
  stripeCheckoutSessionId: string | null;
  stripeStatus: string;
};

export type CheckoutSessionExpiredHandlerDeps = {
  findPaymentByBookingId: (
    bookingId: string,
  ) => Promise<CheckoutSessionExpiredPaymentSnapshot | null>;
  /**
   * Conditionally marks the payment EXPIRED only when the stored session id
   * still matches. Returns the number of rows updated.
   */
  markExpiredIfSessionMatches: (input: {
    bookingId: string;
    eventSessionId: string;
  }) => Promise<number>;
  releaseUnpaidBooking: (input: {
    bookingId: string;
    eventSessionId: string;
  }) => Promise<void>;
  writeAuditLog: (input: {
    bookingId: string;
    eventSessionId: string;
  }) => Promise<void>;
};

export type CheckoutSessionExpiredEvent = {
  id: string;
  metadata?: { bookingId?: string | null } | null;
};

/**
 * Applies checkout.session.expired effects using injectable persistence deps.
 * Booking release runs only after a successful conditional status update.
 * Missing / unlinked payment association throws a plain Error (retryable).
 */
export async function applyCheckoutSessionExpiredEvent(
  session: CheckoutSessionExpiredEvent,
  deps: CheckoutSessionExpiredHandlerDeps,
): Promise<string> {
  const bookingId = session.metadata?.bookingId ?? undefined;
  if (!bookingId) {
    return "no_booking_metadata";
  }

  const eventSessionId = session.id;

  let payment: CheckoutSessionExpiredPaymentSnapshot | null;
  try {
    payment = await deps.findPaymentByBookingId(bookingId);
  } catch {
    console.error("[checkout-session-expired] Failed to load payment for expiry event", {
      bookingId,
      sessionId: eventSessionId,
    });
    throw new Error("checkout_session_expired_lookup_failed");
  }

  const decision = decideCheckoutSessionExpiredEffect({
    eventSessionId,
    payment,
  });

  if (decision.kind === "retry") {
    throw new Error(checkoutSessionExpiredRetryErrorMessage(decision));
  }

  if (decision.kind === "ignore") {
    return `ignored_${decision.reason}`;
  }

  let updatedCount: number;
  try {
    updatedCount = await deps.markExpiredIfSessionMatches({
      bookingId,
      eventSessionId,
    });
  } catch {
    console.error("[checkout-session-expired] Failed to update payment status", {
      bookingId,
      sessionId: eventSessionId,
    });
    throw new Error("checkout_session_expired_update_failed");
  }

  if (updatedCount === 0) {
    // Concurrent status/session change — do not release; do not claim durable expiry.
    // Retry so a still-matching unpaid session can expire; paid lineage will ignore.
    throw new Error(
      "CHECKOUT_SESSION_EXPIRED_CONCURRENT_UPDATE: conditional EXPIRED write matched zero rows; retry",
    );
  }

  try {
    await deps.releaseUnpaidBooking({ bookingId, eventSessionId });
  } catch {
    console.error("[checkout-session-expired] Failed to release unpaid booking after expiry", {
      bookingId,
      sessionId: eventSessionId,
    });
    throw new Error("checkout_session_expired_release_failed");
  }

  try {
    await deps.writeAuditLog({ bookingId, eventSessionId });
  } catch {
    // Status already updated and booking release attempted — do not claim full
    // success, but also do not roll back Stripe/payment state here.
    console.error("[checkout-session-expired] Payment expired but audit log failed", {
      bookingId,
      sessionId: eventSessionId,
    });
    throw new Error("checkout_session_expired_audit_failed");
  }

  return "checkout_session_expired_released";
}
