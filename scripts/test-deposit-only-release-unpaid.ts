/**
 * Deposit-only unpaid release / paid protection (in-memory mocks only).
 * No database queries and no Stripe network.
 *
 *   npm run test:deposit-only-release-unpaid
 */

import assert from "node:assert/strict";

// Satisfy prisma module load via occupancy barrel re-exports; tests never query the DB.
process.env.DATABASE_URL ??= "postgresql://localhost:5432/explore_malta_test_unused";

type BookingSnap = {
  id: string;
  status: "PENDING_PAYMENT" | "CONFIRMED" | "CANCELLED";
  paymentStatus: "PENDING" | "PAID" | "FAILED" | "REFUNDED";
  totalDueOnline: number;
  vehicleUnitId: string | null;
};

type CreditSnap = {
  id: string;
  redeemedBookingId: string | null;
  status: "REDEEMED" | "AVAILABLE";
};

function createReleaseDb(options: {
  booking: BookingSnap;
  credit?: CreditSnap | null;
}) {
  const booking = { ...options.booking };
  const credits: CreditSnap[] = options.credit ? [{ ...options.credit }] : [];
  const history: Array<{ oldStatus: string; newStatus: string; note: string }> = [];
  let loyaltyUpdateCalls = 0;
  let occupancyDeletes = 0;

  /** When set, mutates booking before updateMany (payment-wins race). */
  let raceFlip: Partial<BookingSnap> | null = null;

  const db = {
    booking: {
      findUnique: async () => ({ ...booking }),
      update: async ({ data }: { data: Partial<BookingSnap> }) => {
        Object.assign(booking, data);
        return booking;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          status?: string;
          paymentStatus?: { in: string[] };
        };
        data: Partial<BookingSnap>;
      }) => {
        if (raceFlip) {
          Object.assign(booking, raceFlip);
          raceFlip = null;
        }
        if (where.id !== booking.id) return { count: 0 };
        if (where.status && booking.status !== where.status) return { count: 0 };
        if (where.paymentStatus?.in && !where.paymentStatus.in.includes(booking.paymentStatus)) {
          return { count: 0 };
        }
        Object.assign(booking, data);
        return { count: 1 };
      },
    },
    vehicleUnit: {
      update: async () => ({ id: booking.vehicleUnitId }),
    },
    bookingStatusHistory: {
      create: async ({
        data,
      }: {
        data: { oldStatus: string; newStatus: string; note: string };
      }) => {
        history.push(data);
        return data;
      },
    },
    customerLoyaltyCredit: {
      updateMany: async ({
        where,
        data,
      }: {
        where: { redeemedBookingId: string; status: string };
        data: { status: "AVAILABLE"; redeemedAt: null; redeemedBookingId: null };
      }) => {
        loyaltyUpdateCalls += 1;
        let count = 0;
        for (const credit of credits) {
          if (
            credit.redeemedBookingId === where.redeemedBookingId &&
            credit.status === where.status
          ) {
            credit.status = data.status;
            credit.redeemedBookingId = data.redeemedBookingId;
            count += 1;
          }
        }
        return { count };
      },
    },
    $executeRaw: async () => {
      occupancyDeletes += 1;
      return BigInt(1);
    },
    $executeRawUnsafe: async () => {
      occupancyDeletes += 1;
      return BigInt(1);
    },
  };

  return {
    db,
    booking,
    credits,
    history,
    setRaceFlip(next: Partial<BookingSnap>) {
      raceFlip = next;
    },
    get loyaltyUpdateCalls() {
      return loyaltyUpdateCalls;
    },
    get occupancyDeletes() {
      return occupancyDeletes;
    },
  };
}

async function loadLifecycleModules() {
  const [{ releaseUnpaidBooking }, { restoreLoyaltyCreditForUnpaidBooking }] = await Promise.all([
    import("../src/lib/booking/releaseUnpaidBooking"),
    import("../src/lib/loyalty/loyalty-credit"),
  ]);
  return { releaseUnpaidBooking, restoreLoyaltyCreditForUnpaidBooking };
}

async function testDepositOnlyUnpaidReleaseRestoresLoyaltyOnce() {
  const { releaseUnpaidBooking } = await loadLifecycleModules();
  const mock = createReleaseDb({
    booking: {
      id: "booking_dep",
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      totalDueOnline: 250,
      vehicleUnitId: "unit_1",
    },
    credit: {
      id: "credit_1",
      redeemedBookingId: "booking_dep",
      status: "REDEEMED",
    },
  });

  const first = await releaseUnpaidBooking(mock.db as never, "booking_dep", {
    note: "Checkout expired without deposit payment",
  });
  assert.equal(first.ok, true);
  if (!first.ok || !("released" in first) || !first.released) {
    assert.fail("expected first release to succeed");
  }
  assert.equal(mock.booking.status, "CANCELLED");
  assert.equal(mock.booking.paymentStatus, "FAILED");
  assert.equal(mock.credits[0]?.status, "AVAILABLE");
  assert.equal(mock.credits[0]?.redeemedBookingId, null);
  assert.equal(mock.loyaltyUpdateCalls, 1);
  assert.equal(mock.history.length, 1);
  assert.match(mock.history[0]!.note, /loyalty credit returned/i);

  const second = await releaseUnpaidBooking(mock.db as never, "booking_dep");
  assert.equal(second.ok, true);
  if (second.ok && "released" in second) {
    assert.equal(second.released, false);
    if (!second.released) {
      assert.equal(second.reason, "not_releasable");
    }
  }
  assert.equal(mock.loyaltyUpdateCalls, 1);
  assert.equal(mock.credits[0]?.status, "AVAILABLE");
}

async function testPaidDepositOnlyBookingIsNotReleased() {
  const { releaseUnpaidBooking } = await loadLifecycleModules();
  const mock = createReleaseDb({
    booking: {
      id: "booking_dep_paid",
      status: "CONFIRMED",
      paymentStatus: "PAID",
      totalDueOnline: 250,
      vehicleUnitId: "unit_1",
    },
    credit: {
      id: "credit_1",
      redeemedBookingId: "booking_dep_paid",
      status: "REDEEMED",
    },
  });

  const result = await releaseUnpaidBooking(mock.db as never, "booking_dep_paid", {
    allowConfirmedUnpaid: true,
  });
  assert.equal(result.ok, true);
  if (result.ok && "released" in result) {
    assert.equal(result.released, false);
    if (!result.released) {
      assert.equal(result.reason, "not_releasable");
    }
  }
  assert.equal(mock.booking.status, "CONFIRMED");
  assert.equal(mock.booking.paymentStatus, "PAID");
  assert.equal(mock.credits[0]?.status, "REDEEMED");
  assert.equal(mock.loyaltyUpdateCalls, 0);
  assert.equal(mock.occupancyDeletes, 0);
}

async function testPendingPaymentButPaidStatusIsNotReleased() {
  const { releaseUnpaidBooking } = await loadLifecycleModules();
  const mock = createReleaseDb({
    booking: {
      id: "booking_dep_pending_paid",
      status: "PENDING_PAYMENT",
      paymentStatus: "PAID",
      totalDueOnline: 250,
      vehicleUnitId: "unit_1",
    },
    credit: {
      id: "credit_1",
      redeemedBookingId: "booking_dep_pending_paid",
      status: "REDEEMED",
    },
  });

  const result = await releaseUnpaidBooking(mock.db as never, "booking_dep_pending_paid");
  assert.equal(result.ok, true);
  if (result.ok && "released" in result) {
    assert.equal(result.released, false);
    if (!result.released) {
      assert.equal(result.reason, "not_releasable");
    }
  }
  assert.equal(mock.booking.status, "PENDING_PAYMENT");
  assert.equal(mock.credits[0]?.status, "REDEEMED");
  assert.equal(mock.loyaltyUpdateCalls, 0);
}

async function testReleaseLosesWhenPaymentWinsRace() {
  const { releaseUnpaidBooking } = await loadLifecycleModules();
  const mock = createReleaseDb({
    booking: {
      id: "booking_dep_race",
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      totalDueOnline: 250,
      vehicleUnitId: "unit_1",
    },
    credit: {
      id: "credit_1",
      redeemedBookingId: "booking_dep_race",
      status: "REDEEMED",
    },
  });

  mock.setRaceFlip({ status: "CONFIRMED", paymentStatus: "PAID" });

  const result = await releaseUnpaidBooking(mock.db as never, "booking_dep_race");
  assert.equal(result.ok, true);
  if (result.ok && "released" in result) {
    assert.equal(result.released, false);
    if (!result.released) {
      assert.equal(result.reason, "not_releasable");
    }
  }
  assert.equal(mock.booking.status, "CONFIRMED");
  assert.equal(mock.booking.paymentStatus, "PAID");
  assert.equal(mock.credits[0]?.status, "REDEEMED");
  assert.equal(mock.loyaltyUpdateCalls, 0);
  assert.equal(mock.occupancyDeletes, 0);
}

async function testRestoreLoyaltyHelperIsIdempotent() {
  const { restoreLoyaltyCreditForUnpaidBooking } = await loadLifecycleModules();
  const mock = createReleaseDb({
    booking: {
      id: "booking_dep",
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      totalDueOnline: 250,
      vehicleUnitId: null,
    },
    credit: {
      id: "credit_1",
      redeemedBookingId: "booking_dep",
      status: "REDEEMED",
    },
  });

  const first = await restoreLoyaltyCreditForUnpaidBooking(mock.db as never, "booking_dep");
  const second = await restoreLoyaltyCreditForUnpaidBooking(mock.db as never, "booking_dep");
  assert.equal(first.restored, true);
  assert.equal(second.restored, false);
  assert.equal(mock.loyaltyUpdateCalls, 2);
  assert.equal(mock.credits[0]?.status, "AVAILABLE");
}

/**
 * Mirrors unpaid-sweeper candidate predicates from cleanupUnpaidPendingPaymentBookings
 * (status PENDING_PAYMENT, paymentStatus PENDING|FAILED, totalDueOnline > 0).
 * Does not invoke the cleanup function (it requires a live Prisma client).
 */
function testUnpaidCleanupCandidateRulesExcludePaidDepositOnly() {
  const unpaidDepositOnly = {
    status: "PENDING_PAYMENT" as const,
    paymentStatus: "PENDING" as const,
    totalDueOnline: 250,
  };
  const paidDepositOnly = {
    status: "CONFIRMED" as const,
    paymentStatus: "PAID" as const,
    totalDueOnline: 250,
  };

  const matchesCleanupWhere = (row: {
    status: string;
    paymentStatus: string;
    totalDueOnline: number;
  }) =>
    row.status === "PENDING_PAYMENT" &&
    (row.paymentStatus === "PENDING" || row.paymentStatus === "FAILED") &&
    row.totalDueOnline > 0;

  assert.equal(matchesCleanupWhere(unpaidDepositOnly), true);
  assert.equal(matchesCleanupWhere(paidDepositOnly), false);
}

async function main() {
  await testDepositOnlyUnpaidReleaseRestoresLoyaltyOnce();
  await testPaidDepositOnlyBookingIsNotReleased();
  await testPendingPaymentButPaidStatusIsNotReleased();
  await testReleaseLosesWhenPaymentWinsRace();
  await testRestoreLoyaltyHelperIsIdempotent();
  testUnpaidCleanupCandidateRulesExcludePaidDepositOnly();
  console.log("test-deposit-only-release-unpaid: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
