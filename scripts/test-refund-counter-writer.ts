/**
 * Status-preserving refund counter writer tests (fake transaction client; no DB / Stripe).
 *
 *   npm run test:refund-counter-writer
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyAbsoluteRefundCounters,
  applyChargeRefundedAggregateWrite,
  nonDecreasingRefundedAmountCents,
  planAbsoluteRefundCounterWrite,
  type RefundCounterWriterTx,
} from "../src/lib/stripe/refund-counter-writer";

type PaymentRow = {
  id: string;
  stripeStatus: string;
  rentalRefundedCents: number;
  depositRefundedCents: number;
  refundedAmountCents: number;
  refundStatus: string;
};

type BookingRow = {
  id: string;
  paymentStatus: string;
};

function createFakeTx(options: {
  payment: PaymentRow;
  booking: BookingRow;
  failCounterUpdate?: boolean;
}): {
  tx: RefundCounterWriterTx;
  payment: PaymentRow;
  booking: BookingRow;
  counterUpdateCalls: number;
  statusUpdateManyCalls: Array<{
    allowlist: string[];
    desired: string;
  }>;
} {
  const payment = options.payment;
  const booking = options.booking;
  let counterUpdateCalls = 0;
  const statusUpdateManyCalls: Array<{ allowlist: string[]; desired: string }> = [];

  const tx: RefundCounterWriterTx = {
    stripePayment: {
      update: async ({ where, data }) => {
        assert.equal(where.id, payment.id);
        counterUpdateCalls += 1;
        if (options.failCounterUpdate) {
          throw new Error("counter_update_failed");
        }
        if (data.rentalRefundedCents !== undefined) {
          payment.rentalRefundedCents = data.rentalRefundedCents;
        }
        if (data.depositRefundedCents !== undefined) {
          payment.depositRefundedCents = data.depositRefundedCents;
        }
        if (data.refundedAmountCents !== undefined) {
          payment.refundedAmountCents = data.refundedAmountCents;
        }
        payment.refundStatus = data.refundStatus;
      },
      updateMany: async ({ where, data }) => {
        assert.equal(where.id, payment.id);
        const allowlist = where.stripeStatus.in;
        statusUpdateManyCalls.push({
          allowlist: [...allowlist],
          desired: data.stripeStatus,
        });
        if (!(allowlist as readonly string[]).includes(payment.stripeStatus)) {
          return { count: 0 };
        }
        payment.stripeStatus = data.stripeStatus;
        return { count: 1 };
      },
    },
    booking: {
      update: async ({ where, data }) => {
        assert.equal(where.id, booking.id);
        booking.paymentStatus = data.paymentStatus;
      },
    },
  };

  return {
    tx,
    payment,
    booking,
    get counterUpdateCalls() {
      return counterUpdateCalls;
    },
    statusUpdateManyCalls,
  };
}

function testSucceededToPartiallyRefunded() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "SUCCEEDED",
        rentalRefundedCents: 0,
        depositRefundedCents: 0,
        refundedAmountCents: 0,
        refundStatus: "NONE",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });

    const result = await applyAbsoluteRefundCounters(fake.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 0,
      refundedAmountCents: 18000,
    });

    assert.equal(result.desiredStripeStatus, "PARTIALLY_REFUNDED");
    assert.equal(result.stripeStatusWriteCount, 1);
    assert.equal(fake.payment.stripeStatus, "PARTIALLY_REFUNDED");
    assert.equal(fake.payment.refundedAmountCents, 18000);
    assert.equal(fake.payment.rentalRefundedCents, 18000);
    assert.equal(fake.payment.refundStatus, "PARTIAL");
    assert.equal(fake.booking.paymentStatus, "PAID");
    assert.deepEqual(fake.statusUpdateManyCalls[0]?.allowlist, [
      "SUCCEEDED",
      "PARTIALLY_REFUNDED",
    ]);
  })();
}

function testSucceededToRefunded() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "SUCCEEDED",
        rentalRefundedCents: 0,
        depositRefundedCents: 0,
        refundedAmountCents: 0,
        refundStatus: "NONE",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });

    const result = await applyAbsoluteRefundCounters(fake.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 25000,
      refundedAmountCents: 43000,
    });

    assert.equal(result.desiredStripeStatus, "REFUNDED");
    assert.equal(result.stripeStatusWriteCount, 1);
    assert.equal(result.bookingUpdated, true);
    assert.equal(fake.payment.stripeStatus, "REFUNDED");
    assert.equal(fake.payment.refundStatus, "FULL");
    assert.equal(fake.booking.paymentStatus, "REFUNDED");
    assert.deepEqual(fake.statusUpdateManyCalls[0]?.allowlist, [
      "SUCCEEDED",
      "PARTIALLY_REFUNDED",
      "REFUNDED",
    ]);
  })();
}

function testPartiallyRefundedTransitions() {
  return (async () => {
    const stayPartial = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "PARTIALLY_REFUNDED",
        rentalRefundedCents: 5000,
        depositRefundedCents: 0,
        refundedAmountCents: 5000,
        refundStatus: "PARTIAL",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });
    await applyAbsoluteRefundCounters(stayPartial.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 0,
      refundedAmountCents: 18000,
    });
    assert.equal(stayPartial.payment.stripeStatus, "PARTIALLY_REFUNDED");
    assert.equal(stayPartial.payment.refundedAmountCents, 18000);

    const toFull = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "PARTIALLY_REFUNDED",
        rentalRefundedCents: 18000,
        depositRefundedCents: 0,
        refundedAmountCents: 18000,
        refundStatus: "PARTIAL",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });
    await applyAbsoluteRefundCounters(toFull.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      rentalRefundedCents: 18000,
      depositRefundedCents: 25000,
      refundedAmountCents: 43000,
    });
    assert.equal(toFull.payment.stripeStatus, "REFUNDED");
    assert.equal(toFull.booking.paymentStatus, "REFUNDED");
  })();
}

function testRefundedNeverRegressesToPartial() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "REFUNDED",
        rentalRefundedCents: 43000,
        depositRefundedCents: 0,
        refundedAmountCents: 43000,
        refundStatus: "FULL",
      },
      booking: { id: "booking_1", paymentStatus: "REFUNDED" },
    });

    // Mis-stated partial absolute write must not downgrade status.
    const result = await applyAbsoluteRefundCounters(fake.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      rentalRefundedCents: 10000,
      depositRefundedCents: 0,
      refundedAmountCents: 10000,
    });

    assert.equal(result.desiredStripeStatus, "PARTIALLY_REFUNDED");
    assert.equal(result.stripeStatusWriteCount, 0);
    assert.equal(fake.payment.stripeStatus, "REFUNDED");
    assert.equal(fake.payment.refundedAmountCents, 10000);
    assert.equal(fake.payment.refundStatus, "PARTIAL");
    assert.deepEqual(fake.statusUpdateManyCalls[0]?.allowlist, [
      "SUCCEEDED",
      "PARTIALLY_REFUNDED",
    ]);
  })();
}

function testDisputedKeepsStatusWhileCountersUpdate() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "DISPUTED",
        rentalRefundedCents: 0,
        depositRefundedCents: 0,
        refundedAmountCents: 0,
        refundStatus: "NONE",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });

    const result = await applyAbsoluteRefundCounters(fake.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      rentalRefundedCents: 5000,
      depositRefundedCents: 0,
      refundedAmountCents: 5000,
    });

    assert.equal(result.stripeStatusWriteCount, 0);
    assert.equal(fake.payment.stripeStatus, "DISPUTED");
    assert.equal(fake.payment.refundedAmountCents, 5000);
    assert.equal(fake.payment.rentalRefundedCents, 5000);
    assert.equal(fake.payment.refundStatus, "PARTIAL");
  })();
}

function testUnpaidStatusesNotOverwritten() {
  return (async () => {
    for (const unpaid of ["PENDING", "PROCESSING", "FAILED", "CANCELLED", "EXPIRED"] as const) {
      const fake = createFakeTx({
        payment: {
          id: "pay_1",
          stripeStatus: unpaid,
          rentalRefundedCents: 0,
          depositRefundedCents: 0,
          refundedAmountCents: 0,
          refundStatus: "NONE",
        },
        booking: { id: "booking_1", paymentStatus: "PENDING" },
      });

      const result = await applyAbsoluteRefundCounters(fake.tx, {
        stripePaymentId: "pay_1",
        bookingId: "booking_1",
        amountCents: 10000,
        rentalRefundedCents: 10000,
        depositRefundedCents: 0,
        refundedAmountCents: 10000,
      });

      assert.equal(result.stripeStatusWriteCount, 0, unpaid);
      assert.equal(fake.payment.stripeStatus, unpaid);
      assert.equal(fake.payment.refundedAmountCents, 10000);
      assert.equal(fake.payment.refundStatus, "FULL");
      // Booking still updated on full accounting (existing writer semantics).
      assert.equal(fake.booking.paymentStatus, "REFUNDED");
    }
  })();
}

function testInvalidTotalsThrowBeforeWrites() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "SUCCEEDED",
        rentalRefundedCents: 0,
        depositRefundedCents: 0,
        refundedAmountCents: 0,
        refundStatus: "NONE",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });

    await assert.rejects(
      () =>
        applyAbsoluteRefundCounters(fake.tx, {
          stripePaymentId: "pay_1",
          bookingId: "booking_1",
          amountCents: 0,
          rentalRefundedCents: 0,
          depositRefundedCents: 0,
          refundedAmountCents: 1,
        }),
      /amountCents must be a positive/,
    );
    assert.equal(fake.counterUpdateCalls, 0);
    assert.equal(fake.statusUpdateManyCalls.length, 0);
    assert.equal(fake.payment.refundedAmountCents, 0);

    assert.throws(
      () =>
        planAbsoluteRefundCounterWrite({
          amountCents: 100,
          rentalRefundedCents: -1,
          depositRefundedCents: 0,
          refundedAmountCents: 1,
        }),
      /rentalRefundedCents/,
    );
  })();
}

function testCounterFailureDoesNotWriteStatus() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "SUCCEEDED",
        rentalRefundedCents: 0,
        depositRefundedCents: 0,
        refundedAmountCents: 0,
        refundStatus: "NONE",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
      failCounterUpdate: true,
    });

    await assert.rejects(
      () =>
        applyAbsoluteRefundCounters(fake.tx, {
          stripePaymentId: "pay_1",
          bookingId: "booking_1",
          amountCents: 10000,
          rentalRefundedCents: 5000,
          depositRefundedCents: 0,
          refundedAmountCents: 5000,
        }),
      /counter_update_failed/,
    );
    assert.equal(fake.payment.stripeStatus, "SUCCEEDED");
    assert.equal(fake.statusUpdateManyCalls.length, 0);
    assert.equal(fake.booking.paymentStatus, "PAID");
  })();
}

function testChargeAggregateCannotReduceStoredCounter() {
  return (async () => {
    assert.equal(nonDecreasingRefundedAmountCents(43000, 10000), 43000);
    assert.equal(nonDecreasingRefundedAmountCents(5000, 10000), 10000);

    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "REFUNDED",
        rentalRefundedCents: 18000,
        depositRefundedCents: 25000,
        refundedAmountCents: 43000,
        refundStatus: "FULL",
      },
      booking: { id: "booking_1", paymentStatus: "REFUNDED" },
    });

    const result = await applyChargeRefundedAggregateWrite(fake.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      storedRefundedAmountCents: 43000,
      decidedCombinedRefundedAmountCents: 10000,
      shouldWriteCombinedCounter: true,
      bookingPaymentStatus: null,
    });

    assert.equal(result.refundedAmountCentsWritten, 43000);
    assert.equal(fake.payment.refundedAmountCents, 43000);
    assert.equal(fake.payment.stripeStatus, "REFUNDED");
    assert.equal(result.desiredStripeStatus, "REFUNDED");
    assert.equal(result.bookingUpdated, false);
  })();
}

function testChargeAggregatePreservesDisputed() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "DISPUTED",
        rentalRefundedCents: 0,
        depositRefundedCents: 0,
        refundedAmountCents: 0,
        refundStatus: "NONE",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });

    const result = await applyChargeRefundedAggregateWrite(fake.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      storedRefundedAmountCents: 0,
      decidedCombinedRefundedAmountCents: 10000,
      shouldWriteCombinedCounter: true,
      bookingPaymentStatus: null,
    });

    assert.equal(result.refundedAmountCentsWritten, 10000);
    assert.equal(fake.payment.refundedAmountCents, 10000);
    assert.equal(fake.payment.stripeStatus, "DISPUTED");
    assert.equal(result.stripeStatusWriteCount, 0);
  })();
}

function testZeroRefundedSkipsStatusWrite() {
  return (async () => {
    const fake = createFakeTx({
      payment: {
        id: "pay_1",
        stripeStatus: "SUCCEEDED",
        rentalRefundedCents: 0,
        depositRefundedCents: 0,
        refundedAmountCents: 5,
        refundStatus: "PARTIAL",
      },
      booking: { id: "booking_1", paymentStatus: "PAID" },
    });

    const result = await applyAbsoluteRefundCounters(fake.tx, {
      stripePaymentId: "pay_1",
      bookingId: "booking_1",
      amountCents: 43000,
      rentalRefundedCents: 0,
      depositRefundedCents: 0,
      refundedAmountCents: 0,
    });

    assert.equal(result.desiredStripeStatus, null);
    assert.equal(result.stripeStatusWriteCount, 0);
    assert.equal(fake.payment.stripeStatus, "SUCCEEDED");
    assert.equal(fake.payment.refundStatus, "NONE");
    assert.equal(fake.payment.refundedAmountCents, 0);
    assert.equal(fake.statusUpdateManyCalls.length, 0);
  })();
}

function testFiveWritersImportSharedHelper() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const files = [
    "src/lib/stripe/refund-service.ts",
    "src/lib/stripe/refund-reconciliation.ts",
    "src/lib/stripe/refund-terminal-recovery.ts",
    "src/lib/stripe/webhook-service.ts",
  ];
  for (const relative of files) {
    const source = readFileSync(join(root, relative), "utf8");
    assert.match(
      source,
      /applyAbsoluteRefundCounters/,
      `${relative} must call applyAbsoluteRefundCounters`,
    );
    assert.doesNotMatch(
      source,
      /stripeStatus:\s*isFull/,
      `${relative} must not keep unconditional isFull stripeStatus overwrite`,
    );
  }
  const webhook = readFileSync(join(root, "src/lib/stripe/webhook-service.ts"), "utf8");
  assert.match(webhook, /applyChargeRefundedAggregateWrite/);
  assert.doesNotMatch(
    webhook,
    /stripeStatus:\s*decided\.stripeStatus/,
    "handleChargeRefunded must not write decided.stripeStatus unconditionally",
  );
}

async function main() {
  await testSucceededToPartiallyRefunded();
  await testSucceededToRefunded();
  await testPartiallyRefundedTransitions();
  await testRefundedNeverRegressesToPartial();
  await testDisputedKeepsStatusWhileCountersUpdate();
  await testUnpaidStatusesNotOverwritten();
  await testInvalidTotalsThrowBeforeWrites();
  await testCounterFailureDoesNotWriteStatus();
  await testChargeAggregateCannotReduceStoredCounter();
  await testChargeAggregatePreservesDisputed();
  await testZeroRefundedSkipsStatusWrite();
  testFiveWritersImportSharedHelper();
  console.log("refund-counter-writer tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
