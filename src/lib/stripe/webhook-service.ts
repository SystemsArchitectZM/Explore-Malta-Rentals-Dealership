import type Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { stripe } from "./stripe-client";
import { prisma } from "@/lib/prisma";
import { writePaymentAuditLog } from "./audit-service";
import { notifyPaymentReceived } from "@/lib/admin/notifications";
import {
  deliverBookingConfirmationIfStripePaymentAllows,
  markBookingPaidAndConfirmIfPending,
  unpaidStripeStatusesAllowingSucceededWrite,
} from "./confirm-paid-booking";
import {
  checkoutExpiryWritableStripeStatusFilter,
  isConfirmationEligibleStripePaymentStatus,
  isPaidLineageStripePaymentStatus,
  shouldReleaseBookingAfterUnpaidTerminalWrite,
  unpaidTerminalWritableStripeStatusFilter,
} from "./payment-status-rules";
import {
  decideDisputeCreatedLookup,
  disputeCreatedRetryErrorMessage,
  disputeMarkableStripeStatusFilter,
  resolveDisputePaymentIntentId,
} from "./dispute-payment-policy";
import { releaseUnpaidBooking } from "@/lib/booking/releaseUnpaidBooking";
import { applyCheckoutSessionExpiredEvent } from "./checkout-session-expired-handler";
import {
  decideUnpaidTerminalPaymentIntentEffect,
  unpaidTerminalPaymentIntentRetryErrorMessage,
} from "./unpaid-terminal-payment-intent-policy";
import {
  decideChargeRefundedEffect,
  reconcileRefundWebhookEvent,
  type RefundWebhookDeps,
  type RefundWebhookPaymentRow,
  type RefundWebhookRequestRow,
} from "./refund-webhook-reconciliation";
import {
  applyAbsoluteRefundCounters,
  applyChargeRefundedAggregateWrite,
} from "./refund-counter-writer";
import type { ProcessWebhookResult, WebhookRecoveryIneligibleResult } from "./types";
import { createPrismaWebhookEventStore } from "./webhook-event-store";
import {
  resolveWebhookClaimConfig,
  type WebhookRecoveryClaimOptions,
} from "./webhook-event-claim";
import { WebhookConfigurationError, WebhookPermanentError } from "./webhook-errors";
import { logWebhookOpsEvent } from "./webhook-ops-log";
import {
  processWebhookEventWithDeps,
  type WebhookDispatchResult,
  type WebhookProcessingDeps,
} from "./webhook-processing";
import {
  validateCheckoutSessionForConfirmation,
  validatePaymentIntentForConfirmation,
  type StoredPaymentIntegrityFields,
} from "./payment-confirmation-integrity";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/**
 * Verifies the Stripe webhook signature and returns the parsed event.
 * Throws WebhookConfigurationError when the signing secret is not configured
 * (server fault, not a client error) and Stripe's verification error when the
 * signature/payload is invalid.
 */
export function constructWebhookEvent(rawBody: string, signature: string): Stripe.Event {
  if (!WEBHOOK_SECRET) {
    throw new WebhookConfigurationError("STRIPE_WEBHOOK_SECRET is not configured");
  }
  return stripe.webhooks.constructEvent(rawBody, signature, WEBHOOK_SECRET);
}

/**
 * Processes a single verified Stripe webhook event with a lease-based atomic claim.
 *
 * Returns a typed outcome (see ProcessWebhookResult); HTTP mapping lives in
 * webhook-http-policy.ts. Never throws for handler/database failures.
 *
 * Delivery semantics are at-least-once: the claim prevents concurrent duplicate
 * handler entry for one event id and fences event-row finalization, but financial
 * safety still rests on handler idempotency (payment-row FOR UPDATE, absolute refund
 * recomputes, PENDING-before-Stripe reservations). Not exactly-once across
 * PostgreSQL and Stripe. See docs/stripe-webhook-reliability.md.
 */
export async function processWebhookEvent(event: Stripe.Event): Promise<ProcessWebhookResult> {
  return processWebhookEventWithDeps(event, buildProductionWebhookDeps());
}

/**
 * Operator-recovery entry point. Identical to processWebhookEvent (same orchestrator,
 * handlers, fencing, retry cap, audit) except the atomic claim also requires the
 * recovery eligibility predicate. Live Stripe deliveries never use this function.
 * Returns `recovery_not_eligible` when that predicate no longer holds at claim time.
 */
export async function processWebhookEventForRecovery(
  event: Stripe.Event,
  recovery: WebhookRecoveryClaimOptions,
): Promise<ProcessWebhookResult | WebhookRecoveryIneligibleResult> {
  return processWebhookEventWithDeps(event, buildProductionWebhookDeps(), recovery);
}

function buildProductionWebhookDeps(): WebhookProcessingDeps<Stripe.Event> {
  return {
    store: createPrismaWebhookEventStore(),
    config: resolveWebhookClaimConfig(),
    dispatch: dispatchStripeEvent,
    audit: (args) =>
      writePaymentAuditLog({
        action: args.action,
        actor: "stripe-webhook",
        newValue: args.newValue,
      }),
    log: logWebhookOpsEvent,
  };
}

/** Must mirror the cases of dispatchStripeEvent below. */
const SUPPORTED_EVENT_TYPES = new Set<string>([
  "checkout.session.completed",
  "checkout.session.expired",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "refund.created",
  "refund.updated",
]);

/**
 * Event-type dispatch. Returns { handled: false } for intentionally unsupported
 * types so the orchestrator can record the terminal "ignored" decision.
 */
async function dispatchStripeEvent(event: Stripe.Event): Promise<WebhookDispatchResult> {
  // Live Stripe deliveries always carry data.object. A recovery replay uses the stored
  // payload, which could be corrupt: fail it as a documented permanent classification
  // rather than letting a TypeError loop through retries.
  if (SUPPORTED_EVENT_TYPES.has(event.type)) {
    const object = (event as { data?: { object?: unknown } }).data?.object;
    if (object === null || typeof object !== "object") {
      throw new WebhookPermanentError(
        "EVENT_PAYLOAD_INVALID",
        `Stored event ${event.id} has no usable data.object`,
      );
    }
  }

  switch (event.type) {
    case "checkout.session.completed":
      return {
        handled: true,
        action: await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session),
      };

    case "checkout.session.expired":
      return {
        handled: true,
        action: await handleCheckoutSessionExpired(event.data.object as Stripe.Checkout.Session),
      };

    case "payment_intent.succeeded":
      return {
        handled: true,
        action: await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent),
      };

    case "payment_intent.payment_failed":
      return {
        handled: true,
        action: await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent),
      };

    case "payment_intent.canceled":
      return {
        handled: true,
        action: await handlePaymentIntentCancelled(event.data.object as Stripe.PaymentIntent),
      };

    case "charge.refunded":
      return {
        handled: true,
        action: await handleChargeRefunded(event.data.object as Stripe.Charge),
      };

    case "charge.dispute.created":
      return {
        handled: true,
        action: await handleDisputeCreated(event.data.object as Stripe.Dispute),
      };

    case "charge.dispute.closed":
      return {
        handled: true,
        action: await handleDisputeClosed(event.data.object as Stripe.Dispute),
      };

    case "refund.created":
      return {
        handled: true,
        action: await handleRefundCreated(event.data.object as Stripe.Refund),
      };

    case "refund.updated":
      return {
        handled: true,
        action: await handleRefundUpdated(event.data.object as Stripe.Refund),
      };

    default:
      return { handled: false };
  }
}

// ─── Event Handlers ────────────────────────────────────────────────────────────

function storedPaymentIntegrityFields(row: {
  amountCents: number;
  rentalAmountCents: number;
  depositAmountCents: number;
  currency: string;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
}): StoredPaymentIntegrityFields {
  return {
    amountCents: row.amountCents,
    rentalAmountCents: row.rentalAmountCents,
    depositAmountCents: row.depositAmountCents,
    currency: row.currency,
    stripeCheckoutSessionId: row.stripeCheckoutSessionId,
    stripePaymentIntentId: row.stripePaymentIntentId,
  };
}

function throwPaymentIntegrityMismatch(message: string): never {
  throw new WebhookPermanentError("PAYMENT_INTEGRITY_MISMATCH", message);
}

async function confirmBookingPayment(
  bookingId: string,
  paymentIntentId: string | null,
  checkoutSessionId?: string,
  amountCents?: number | null,
  currency?: string | null,
  integritySource: "checkout_session" | "payment_intent" = "checkout_session",
): Promise<
  "payment_confirmed" | "already_succeeded" | "deferred_awaiting_checkout_session"
> {
  let paymentNewlyPaid = false;

  const status = await prisma.$transaction(async (tx) => {
    const stripePayment = await tx.stripePayment.findUnique({ where: { bookingId } });
    if (!stripePayment) {
      throw new Error(`No StripePayment record found for bookingId=${bookingId}`);
    }

    // Paid-lineage rows must never be overwritten back to SUCCEEDED.
    // Duplicate / refund-replay paths skip charge-amount revalidation so a
    // post-refund balance cannot be mistaken for the original Checkout total.
    if (isPaidLineageStripePaymentStatus(stripePayment.stripeStatus)) {
      // Success-page / partial-refund path: still promote PENDING_PAYMENT when allowed.
      if (isConfirmationEligibleStripePaymentStatus(stripePayment.stripeStatus)) {
        const paidResult = await markBookingPaidAndConfirmIfPending(
          tx,
          bookingId,
          "[stripe-webhook] Payment succeeded — booking confirmed",
        );
        paymentNewlyPaid = paidResult.paymentStatusUpdated;
      }
      return "already_succeeded";
    }

    const stored = storedPaymentIntegrityFields(stripePayment);
    if (integritySource === "checkout_session") {
      if (!checkoutSessionId) {
        throwPaymentIntegrityMismatch(
          `checkout confirmation missing session id for booking ${bookingId}`,
        );
      }
      const check = validateCheckoutSessionForConfirmation(stored, {
        id: checkoutSessionId,
        payment_status: "paid",
        amount_total: amountCents,
        currency,
      });
      if (!check.ok) {
        throwPaymentIntegrityMismatch(`${check.code}: ${check.message}`);
      }
    } else {
      if (!paymentIntentId) {
        throwPaymentIntegrityMismatch(
          `payment_intent confirmation missing intent id for booking ${bookingId}`,
        );
      }
      const check = validatePaymentIntentForConfirmation(stored, {
        id: paymentIntentId,
        amount: amountCents,
        currency,
      });
      if (!check.ok) {
        if (check.code === "PAYMENT_ASSOCIATION_INSUFFICIENT") {
          // Wait for a verifiable Checkout Session event; do not confirm from metadata alone.
          return "deferred_awaiting_checkout_session";
        }
        throwPaymentIntegrityMismatch(`${check.code}: ${check.message}`);
      }
    }

    const updated = await tx.stripePayment.updateMany({
      where: {
        bookingId,
        stripeStatus: { in: unpaidStripeStatusesAllowingSucceededWrite() },
      },
      data: {
        stripeStatus: "SUCCEEDED",
        stripePaymentIntentId: paymentIntentId ?? stripePayment.stripePaymentIntentId,
        ...(checkoutSessionId ? { stripeCheckoutSessionId: checkoutSessionId } : {}),
        updatedAt: new Date(),
      },
    });

    if (updated.count === 0) {
      // Concurrent writer moved the row into paid lineage between read and write.
      const latest = await tx.stripePayment.findUnique({
        where: { bookingId },
        select: { stripeStatus: true },
      });
      if (latest && isConfirmationEligibleStripePaymentStatus(latest.stripeStatus)) {
        await markBookingPaidAndConfirmIfPending(
          tx,
          bookingId,
          "[stripe-webhook] Payment succeeded — booking confirmed",
        );
      }
      return "already_succeeded";
    }

    const booking = await tx.booking.findUnique({
      where: { id: bookingId },
      select: { status: true },
    });

    if (booking?.status === "CANCELLED") {
      // Documented permanent classification: the transaction rolls back and retrying
      // cannot change the outcome; dead-letter so an ADMIN reviews the captured payment.
      throw new WebhookPermanentError(
        "BOOKING_CANCELLED_PAYMENT_RECEIVED",
        `Cannot confirm payment for cancelled booking ${bookingId}`,
      );
    }

    const paidResult = await markBookingPaidAndConfirmIfPending(
      tx,
      bookingId,
      "[stripe-webhook] Payment succeeded — booking confirmed",
    );
    paymentNewlyPaid = paidResult.paymentStatusUpdated;

    if (checkoutSessionId) {
      await tx.stripeTransaction.create({
        data: {
          id: randomUUID(),
          stripePaymentId: stripePayment.id,
          transactionType: "charge",
          stripeTransactionId: checkoutSessionId,
          amountCents: amountCents ?? stripePayment.amountCents,
          currency: currency ?? stripePayment.currency,
          status: "succeeded",
          metadata: { checkoutSessionId, paymentIntentId },
        },
      });
    }

    return "payment_confirmed";
  });

  if (paymentNewlyPaid) {
    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        bookingReference: true,
        customerFullName: true,
        vehicleNameSnapshot: true,
      },
    });
    if (booking) {
      await notifyPaymentReceived({
        bookingId: booking.id,
        bookingReference: booking.bookingReference,
        customerFullName: booking.customerFullName,
        vehicleName: booking.vehicleNameSnapshot,
      });
    }
  }

  return status;
}

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<string> {
  const bookingId = session.metadata?.bookingId;
  const bookingReference = session.metadata?.bookingReference;

  if (!bookingId || !bookingReference) {
    // Documented permanent classification: the same payload can never succeed on retry.
    throw new WebhookPermanentError(
      "EVENT_METADATA_MISSING",
      `checkout.session.completed missing bookingId/bookingReference in metadata: ${session.id}`,
    );
  }

  if (session.payment_status !== "paid") {
    console.log(`[webhook] Checkout session ${session.id} completed but payment_status=${session.payment_status}`);
    return "checkout_completed_payment_pending";
  }

  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;
  const result = await confirmBookingPayment(
    bookingId,
    paymentIntentId,
    session.id,
    session.amount_total,
    session.currency,
    "checkout_session",
  );

  try {
    await deliverBookingConfirmationIfStripePaymentAllows(bookingId);
  } catch (emailError) {
    console.error("[webhook] Confirmation email failed after payment", { bookingId, emailError });
  }

  if (result === "already_succeeded") {
    return "already_succeeded";
  }

  await writePaymentAuditLog({
    bookingId,
    action: "payment_succeeded",
    actor: "stripe-webhook",
    newValue: { sessionId: session.id, paymentIntentId, amountCents: session.amount_total },
  });

  return "payment_confirmed";
}

async function handleCheckoutSessionExpired(session: Stripe.Checkout.Session): Promise<string> {
  return prisma.$transaction(async (tx) =>
    applyCheckoutSessionExpiredEvent(
      {
        id: session.id,
        metadata: session.metadata,
      },
      {
        findPaymentByBookingId: async (bookingId) =>
          tx.stripePayment.findUnique({
            where: { bookingId },
            select: {
              stripeCheckoutSessionId: true,
              stripeStatus: true,
            },
          }),
        markExpiredIfSessionMatches: async ({ bookingId, eventSessionId }) => {
          const updated = await tx.stripePayment.updateMany({
            where: {
              bookingId,
              stripeCheckoutSessionId: eventSessionId,
              stripeStatus: checkoutExpiryWritableStripeStatusFilter(),
            },
            data: { stripeStatus: "EXPIRED" },
          });
          return updated.count;
        },
        releaseUnpaidBooking: async ({ bookingId, eventSessionId }) => {
          await releaseUnpaidBooking(tx, bookingId, {
            actorLabel: "stripe-webhook",
            note: `Checkout session expired (${eventSessionId}) — unpaid booking released`,
            allowConfirmedUnpaid: true,
          });
        },
        writeAuditLog: async ({ bookingId, eventSessionId }) => {
          await writePaymentAuditLog({
            bookingId,
            action: "payment_cancelled",
            actor: "stripe-webhook",
            newValue: { sessionId: eventSessionId, reason: "checkout_session_expired" },
          });
        },
      },
    ),
  );
}

async function handlePaymentIntentSucceeded(intent: Stripe.PaymentIntent): Promise<string> {
  const bookingId = intent.metadata?.bookingId;
  if (!bookingId) {
    return "no_booking_metadata";
  }

  const result = await confirmBookingPayment(
    bookingId,
    intent.id,
    undefined,
    intent.amount,
    intent.currency,
    "payment_intent",
  );

  if (result === "deferred_awaiting_checkout_session") {
    return "deferred_awaiting_checkout_session";
  }

  if (result !== "already_succeeded") {
    await writePaymentAuditLog({
      bookingId,
      action: "payment_succeeded",
      actor: "stripe-webhook",
      newValue: { paymentIntentId: intent.id, amountCents: intent.amount },
    });
  }

  try {
    await deliverBookingConfirmationIfStripePaymentAllows(bookingId);
  } catch (emailError) {
    console.error("[webhook] Confirmation email failed after payment_intent.succeeded", {
      bookingId,
      emailError,
    });
  }

  return result === "already_succeeded" ? "already_succeeded" : "payment_intent_succeeded";
}

async function applyUnpaidTerminalPaymentIntentEvent(
  intent: Stripe.PaymentIntent,
  nextStatus: "FAILED" | "CANCELLED",
): Promise<string> {
  const bookingId = intent.metadata?.bookingId;
  if (!bookingId) {
    return "no_booking_metadata";
  }

  const action =
    nextStatus === "FAILED" ? ("payment_failed" as const) : ("payment_cancelled" as const);
  const successAction = nextStatus === "FAILED" ? "payment_failed" : "payment_cancelled";

  const outcome = await prisma.$transaction(async (tx) => {
    const payment = await tx.stripePayment.findUnique({
      where: { bookingId },
      select: { stripePaymentIntentId: true, stripeStatus: true },
    });

    const decision = decideUnpaidTerminalPaymentIntentEffect({
      eventPaymentIntentId: intent.id,
      payment,
      nextStatus,
    });

    if (decision.kind === "retry") {
      throw new Error(unpaidTerminalPaymentIntentRetryErrorMessage(decision));
    }
    if (decision.kind === "ignore") {
      return `ignored_${decision.reason}` as const;
    }

    const updated = await tx.stripePayment.updateMany({
      where: {
        bookingId,
        stripePaymentIntentId: intent.id,
        stripeStatus: unpaidTerminalWritableStripeStatusFilter(),
      },
      data: { stripeStatus: nextStatus },
    });

    if (updated.count === 0) {
      const latest = await tx.stripePayment.findUnique({
        where: { bookingId },
        select: { stripePaymentIntentId: true, stripeStatus: true },
      });
      const after = decideUnpaidTerminalPaymentIntentEffect({
        eventPaymentIntentId: intent.id,
        payment: latest,
        nextStatus,
      });
      if (after.kind === "retry") {
        throw new Error(unpaidTerminalPaymentIntentRetryErrorMessage(after));
      }
      if (after.kind === "ignore") {
        return `ignored_${after.reason}` as const;
      }
      throw new Error(
        "UNPAID_TERMINAL_STATUS_RACE: matching unpaid PaymentIntent left writable set before terminal write; retry",
      );
    }

    if (shouldReleaseBookingAfterUnpaidTerminalWrite(updated.count)) {
      await releaseUnpaidBooking(tx, bookingId, {
        actorLabel: "stripe-webhook",
        note:
          nextStatus === "FAILED"
            ? `Payment failed — ${intent.last_payment_error?.message ?? "card declined"}`
            : "Payment intent cancelled — unpaid booking released",
        allowConfirmedUnpaid: true,
      });
    }

    return "applied" as const;
  });

  if (outcome !== "applied") {
    return outcome;
  }

  await writePaymentAuditLog({
    bookingId,
    action,
    actor: "stripe-webhook",
    newValue: {
      paymentIntentId: intent.id,
      ...(nextStatus === "FAILED"
        ? { failureMessage: intent.last_payment_error?.message }
        : {}),
    },
  });

  return successAction;
}

async function handlePaymentIntentFailed(intent: Stripe.PaymentIntent): Promise<string> {
  return applyUnpaidTerminalPaymentIntentEvent(intent, "FAILED");
}

async function handlePaymentIntentCancelled(intent: Stripe.PaymentIntent): Promise<string> {
  return applyUnpaidTerminalPaymentIntentEvent(intent, "CANCELLED");
}

async function handleChargeRefunded(charge: Stripe.Charge): Promise<string> {
  const bookingId = charge.metadata?.bookingId;
  if (!bookingId) {
    return "no_booking_metadata";
  }

  // Identify payment without relying on stale accounting fields.
  const paymentIdRow = await prisma.stripePayment.findUnique({
    where: { bookingId },
    select: { id: true },
  });
  if (!paymentIdRow) {
    return "no_payment_record";
  }

  const effect = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`
      SELECT id FROM "StripePayment" WHERE id = ${paymentIdRow.id} FOR UPDATE
    `;

    const payment = await tx.stripePayment.findUnique({
      where: { id: paymentIdRow.id },
      select: {
        id: true,
        amountCents: true,
        rentalAmountCents: true,
        depositAmountCents: true,
        refundedAmountCents: true,
        rentalRefundedCents: true,
        depositRefundedCents: true,
      },
    });
    if (!payment) {
      throw new Error("PAYMENT_NOT_FOUND");
    }

    const rr = tx as typeof tx & {
      stripeRefundRequest: {
        findMany: (args: unknown) => Promise<
          Array<{
            stripeRefundId: string | null;
            purpose: string;
            status: string;
            amountCents: number;
          }>
        >;
      };
    };

    let requests: Array<{
      stripeRefundId: string | null;
      purpose: string;
      status: string;
      amountCents: number;
    }> = [];
    try {
      requests = await rr.stripeRefundRequest.findMany({
        where: { stripePaymentId: payment.id },
      });
    } catch {
      requests = [];
    }

    const stripeRefunds = await tx.stripeRefund.findMany({
      where: { stripePaymentId: payment.id },
      select: { stripeRefundId: true, amountCents: true },
    });

    const linkedIds = new Set(
      requests
        .filter((r) => r.stripeRefundId && (r.status === "SUCCEEDED" || r.status === "PENDING"))
        .map((r) => r.stripeRefundId as string),
    );
    const unmatchedStripeRefundIds = stripeRefunds
      .map((r) => r.stripeRefundId)
      .filter((id) => !linkedIds.has(id));

    const succeededPurposeSumCents = requests
      .filter((r) => r.status === "SUCCEEDED")
      .reduce((sum, r) => {
        if (r.purpose === "RENTAL" || r.purpose === "SECURITY_DEPOSIT") {
          return sum + r.amountCents;
        }
        return sum;
      }, 0);

    const decided = decideChargeRefundedEffect({
      chargeRefundedAmountCents: charge.amount_refunded,
      chargeFullyRefunded: charge.refunded,
      payment: {
        amountCents: payment.amountCents,
        rentalAmountCents: payment.rentalAmountCents,
        depositAmountCents: payment.depositAmountCents,
        refundedAmountCents: payment.refundedAmountCents,
        rentalRefundedCents: payment.rentalRefundedCents,
        depositRefundedCents: payment.depositRefundedCents,
      },
      succeededPurposeSumCents,
      unmatchedStripeRefundIds,
    });

    // Purpose counters are never written from charge aggregates.
    // Combined counter is non-decreasing; stripeStatus is allowlist-guarded.
    await applyChargeRefundedAggregateWrite(tx, {
      stripePaymentId: payment.id,
      bookingId,
      amountCents: payment.amountCents,
      storedRefundedAmountCents: payment.refundedAmountCents,
      decidedCombinedRefundedAmountCents: decided.combinedRefundedAmountCents,
      shouldWriteCombinedCounter: decided.shouldWriteCombinedCounter,
      bookingPaymentStatus: decided.bookingPaymentStatus,
    });

    return decided;
  });

  await writePaymentAuditLog({
    bookingId,
    stripePaymentId: paymentIdRow.id,
    action: effect.needsReconciliation ? "refund_reconciled" : "refund_succeeded",
    actor: "stripe-webhook",
    newValue: {
      chargeId: charge.id,
      refundedAmountCents: charge.amount_refunded,
      isFullRefund: charge.refunded,
      note: effect.note,
      needsReconciliation: effect.needsReconciliation,
      combinedWritten: effect.combinedRefundedAmountCents,
      bookingPaymentStatusWritten: effect.bookingPaymentStatus,
    },
  });

  if (effect.needsReconciliation) {
    return "charge_refunded_needs_reconciliation";
  }
  if (effect.bookingPaymentStatus === "REFUNDED") {
    return "full_refund_processed";
  }
  return "partial_refund_processed";
}

async function handleDisputeCreated(dispute: Stripe.Dispute): Promise<string> {
  const paymentIntentId = resolveDisputePaymentIntentId(dispute.payment_intent);
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;

  const payment = paymentIntentId
    ? await prisma.stripePayment.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
        select: { id: true, bookingId: true, stripeStatus: true },
      })
    : null;

  const decision = decideDisputeCreatedLookup({
    paymentIntentId,
    payment,
  });

  if (decision.kind === "retry_unmatched" || decision.kind === "retry_premature") {
    // Plain Error → classifyWebhookFailure → HANDLER_ERROR (retryable). Do not
    // return success or the event would be marked processed without attaching DISPUTED.
    throw new Error(disputeCreatedRetryErrorMessage(decision));
  }

  // Inquiry (warning_*) and charge disputes both mark DISPUTED on create
  // (see shouldMarkDisputedOnDisputeCreated / isDisputeWarningStatus).
  const matchedPayment = payment!;
  const updated = await prisma.stripePayment.updateMany({
    where: {
      id: matchedPayment.id,
      stripeStatus: disputeMarkableStripeStatusFilter(),
    },
    data: {
      stripeStatus: "DISPUTED",
      updatedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    // Concurrent status change between read and write — retry rather than no-op success.
    throw new Error(
      `DISPUTE_STATUS_RACE: payment ${matchedPayment.id} left dispute-markable set before DISPUTED write`,
    );
  }

  await writePaymentAuditLog({
    bookingId: matchedPayment.bookingId,
    stripePaymentId: matchedPayment.id,
    action: "dispute_created",
    actor: "stripe-webhook",
    newValue: {
      disputeId: dispute.id,
      amount: dispute.amount,
      reason: dispute.reason,
      status: dispute.status,
      chargeId: chargeId ?? null,
      paymentIntentId,
      priorStripeStatus: matchedPayment.stripeStatus,
      // Explicit: disputes never auto-refund.
      refundInitiated: false,
    },
  });

  console.warn("[webhook] Dispute created — admin action required", {
    disputeId: dispute.id,
    bookingId: matchedPayment.bookingId,
    paymentIntentId,
    disputeStatus: dispute.status,
  });
  return "dispute_recorded";
}

/**
 * Closure is audit-only in this phase: do not clear DISPUTED or invent status
 * mappings from won/lost/warning_closed.
 */
async function handleDisputeClosed(dispute: Stripe.Dispute): Promise<string> {
  const paymentIntentId = resolveDisputePaymentIntentId(dispute.payment_intent);
  const payment = paymentIntentId
    ? await prisma.stripePayment.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
        select: { id: true, bookingId: true, stripeStatus: true },
      })
    : null;

  await writePaymentAuditLog({
    bookingId: payment?.bookingId,
    stripePaymentId: payment?.id,
    action: "dispute_closed",
    actor: "stripe-webhook",
    newValue: {
      disputeId: dispute.id,
      status: dispute.status,
      reason: dispute.reason,
      paymentIntentId,
      stripeStatusUnchanged: payment?.stripeStatus ?? null,
      statusCleared: false,
    },
  });

  return "dispute_closed";
}

function refundWebhookDeps(): RefundWebhookDeps {
  return {
    findPaymentByPaymentIntentId: async (paymentIntentId) => {
      const row = await prisma.stripePayment.findUnique({
        where: { stripePaymentIntentId: paymentIntentId },
        select: {
          id: true,
          bookingId: true,
          stripePaymentIntentId: true,
          amountCents: true,
          rentalAmountCents: true,
          depositAmountCents: true,
          refundedAmountCents: true,
          rentalRefundedCents: true,
          depositRefundedCents: true,
        },
      });
      return row as RefundWebhookPaymentRow | null;
    },
    withPaymentLock: async (stripePaymentId, fn) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT id FROM "StripePayment" WHERE id = ${stripePaymentId} FOR UPDATE
        `;
        const payment = (await tx.stripePayment.findUnique({
          where: { id: stripePaymentId },
          select: {
            id: true,
            bookingId: true,
            stripePaymentIntentId: true,
            amountCents: true,
            rentalAmountCents: true,
            depositAmountCents: true,
            refundedAmountCents: true,
            rentalRefundedCents: true,
            depositRefundedCents: true,
          },
        })) as RefundWebhookPaymentRow | null;
        if (!payment) {
          throw new Error("PAYMENT_NOT_FOUND");
        }

        const rr = tx as typeof tx & {
          stripeRefundRequest: {
            findMany: (args: unknown) => Promise<RefundWebhookRequestRow[]>;
            update: (args: unknown) => Promise<unknown>;
          };
        };

        const requests = (await rr.stripeRefundRequest.findMany({
          where: { stripePaymentId },
          orderBy: { createdAt: "asc" },
        })) as RefundWebhookRequestRow[];

        const stripeRefunds = await tx.stripeRefund.findMany({
          where: { stripePaymentId },
          select: { stripeRefundId: true, amountCents: true },
        });

        return fn({
          payment,
          requests,
          stripeRefunds,
          upsertMirror: async (input) => {
            await tx.stripeRefund.upsert({
              where: { stripeRefundId: input.stripeRefundId },
              create: {
                id: randomUUID(),
                stripePaymentId,
                stripeRefundId: input.stripeRefundId,
                amountCents: input.amountCents,
                reason: input.reason,
                status: input.status,
                updatedAt: new Date(),
              },
              update: {
                status: input.status,
                updatedAt: new Date(),
              },
            });
          },
          updateRequest: async (id, data) => {
            await rr.stripeRefundRequest.update({
              where: { id },
              data: { ...data, updatedAt: new Date() },
            });
          },
          setCountersAbsolute: async (input) => {
            await applyAbsoluteRefundCounters(tx, {
              stripePaymentId,
              bookingId: payment.bookingId,
              amountCents: payment.amountCents,
              rentalRefundedCents: input.rentalRefundedCents,
              depositRefundedCents: input.depositRefundedCents,
              refundedAmountCents: input.refundedAmountCents,
            });
          },
        });
      }),
    writeAuditLog: async (args) => {
      await writePaymentAuditLog({
        bookingId: args.bookingId,
        stripePaymentId: args.stripePaymentId,
        action: args.action,
        actor: "stripe-webhook",
        newValue: args.newValue,
      });
    },
  };
}

function refundMetadataRecord(
  metadata: Stripe.Metadata | null | undefined,
): Record<string, string | undefined> {
  if (!metadata) return {};
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(metadata)) {
    out[key] = typeof value === "string" ? value : undefined;
  }
  return out;
}

async function handleRefundCreated(refund: Stripe.Refund): Promise<string> {
  return reconcileRefundWebhookEvent(
    {
      stripeRefundId: refund.id,
      amountCents: refund.amount,
      status: refund.status ?? "pending",
      reason: mapStripeRefundReason(refund.reason),
      paymentIntentId: typeof refund.payment_intent === "string" ? refund.payment_intent : null,
      metadata: refundMetadataRecord(refund.metadata),
    },
    refundWebhookDeps(),
  );
}

async function handleRefundUpdated(refund: Stripe.Refund): Promise<string> {
  return reconcileRefundWebhookEvent(
    {
      stripeRefundId: refund.id,
      amountCents: refund.amount,
      status: refund.status ?? "pending",
      reason: mapStripeRefundReason(refund.reason),
      paymentIntentId: typeof refund.payment_intent === "string" ? refund.payment_intent : null,
      metadata: refundMetadataRecord(refund.metadata),
    },
    refundWebhookDeps(),
  );
}

function mapStripeRefundReason(
  reason: Stripe.Refund["reason"] | null | undefined,
): "DUPLICATE" | "FRAUDULENT" | "REQUESTED_BY_CUSTOMER" {
  switch (reason) {
    case "duplicate":
      return "DUPLICATE";
    case "fraudulent":
      return "FRAUDULENT";
    default:
      return "REQUESTED_BY_CUSTOMER";
  }
}
