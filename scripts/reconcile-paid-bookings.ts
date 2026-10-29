import "dotenv/config";

import { prisma } from "../src/lib/prisma";
import { syncPaidBookingAndSendConfirmation } from "../src/lib/stripe/confirm-paid-booking";
import { stripe } from "../src/lib/stripe/stripe-client";

/**
 * Finds bookings Stripe has already collected payment for, but the app still
 * has as PENDING / Awaiting Payment / confirmation email NOT_SENT, then marks
 * them paid, confirms the booking, and sends the confirmation email.
 *
 * Usage: npx tsx scripts/reconcile-paid-bookings.ts
 */
async function main() {
  const pendingPayments = await prisma.stripePayment.findMany({
    where: {
      OR: [
        { stripeStatus: { not: "SUCCEEDED" } },
        { Booking: { confirmationEmailStatus: { not: "SENT" } } },
        { Booking: { status: "PENDING_PAYMENT", paymentStatus: "PAID" } },
      ],
    },
    select: {
      bookingId: true,
      stripeCheckoutSessionId: true,
      stripeStatus: true,
      Booking: {
        select: {
          bookingReference: true,
          status: true,
          paymentStatus: true,
          confirmationEmailStatus: true,
        },
      },
    },
  });

  console.log(`Checking ${pendingPayments.length} payment record(s)...`);

  let reconciled = 0;
  let skippedUnpaid = 0;
  let failed = 0;

  for (const payment of pendingPayments) {
    const ref = payment.Booking.bookingReference;
    const sessionId = payment.stripeCheckoutSessionId;
    if (!sessionId) {
      console.log(`[skip] ${ref}: no checkout session id`);
      skippedUnpaid += 1;
      continue;
    }

    let session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[error] ${ref}: Stripe retrieve failed: ${message}`);
      continue;
    }

    if (session.payment_status !== "paid") {
      console.log(`[skip] ${ref}: Stripe payment_status=${session.payment_status} session=${session.status}`);
      skippedUnpaid += 1;
      continue;
    }

    const paymentIntentId =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

    try {
      await syncPaidBookingAndSendConfirmation({
        bookingId: payment.bookingId,
        paymentIntentId,
        checkoutSessionId: sessionId,
        integrity: {
          source: "checkout_session",
          session: {
            id: session.id,
            payment_status: session.payment_status,
            amount_total: session.amount_total,
            currency: session.currency,
          },
        },
      });
      reconciled += 1;
      console.log(`[ok] ${ref}: marked PAID/CONFIRMED and attempted confirmation email`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[error] ${ref}: ${message}`);
    }
  }

  console.log(
    JSON.stringify({ checked: pendingPayments.length, reconciled, skippedUnpaid, failed }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
