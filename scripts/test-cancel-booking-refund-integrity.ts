/**
 * Cancellation must not falsely mark Stripe rental payments as refunded.
 *
 * Uses an in-memory mocked persistence layer for cancelBooking — no production DB,
 * no Stripe. Does not claim live database integration coverage.
 *
 *   npm run test:cancel-booking-refund-integrity
 */

import assert from "node:assert/strict";

import type { PaymentStatus, BookingStatus, SecurityDepositStatus } from "../src/generated/prisma/index";
import type { AdminBookingDetail } from "../src/lib/admin/bookings/types";
import { cancelBooking } from "../src/lib/admin/bookings/lifecycle/cancelBooking";
import { resolvePaymentStatusOnCancel } from "../src/lib/admin/bookings/lifecycle/resolve-payment-status-on-cancel";
import { cancelBookingSchema } from "../src/lib/admin/bookings/lifecycle/booking-lifecycle-schema";
import {
  buildBookingCancellationEmailDraft,
  cancellationPaymentClarification,
} from "../src/lib/email/buildBookingCancellationEmailDraft";

type BookingRow = {
  id: string;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  securityDepositStatus: SecurityDepositStatus;
  vehicleUnitId: string | null;
};

type UnitRow = {
  id: string;
  status: string;
};

function assertDraftNeverPromisesRefund(body: string) {
  assert.match(body, /does not confirm that any payment has been refunded/i);
  assert.doesNotMatch(body, /A refund of your payment will be processed/i);
  assert.doesNotMatch(body, /will be processed\. If you have questions about timing/i);
}

function testPaymentStatusPreservedOnCancel() {
  assert.equal(resolvePaymentStatusOnCancel("PAID", true), "PAID");
  assert.equal(resolvePaymentStatusOnCancel("PAID", false), "PAID");
  assert.equal(resolvePaymentStatusOnCancel("PENDING", true), "PENDING");
  assert.equal(resolvePaymentStatusOnCancel("FAILED", true), "FAILED");
  assert.equal(resolvePaymentStatusOnCancel("REFUNDED", true), "REFUNDED");
  assert.equal(resolvePaymentStatusOnCancel("REFUNDED", false), "REFUNDED");
}

function testSchemaStillAcceptsLegacyRefundPaymentFlag() {
  const withFlag = cancelBookingSchema.parse({
    refundPayment: true,
    emailSubject: "Cancelled",
    emailBody: "Your booking was cancelled.",
  });
  assert.equal(withFlag.refundPayment, true);

  const withoutFlag = cancelBookingSchema.parse({
    emailSubject: "Cancelled",
    emailBody: "Your booking was cancelled.",
  });
  assert.equal(withoutFlag.refundPayment, false);

  assert.equal(resolvePaymentStatusOnCancel("PAID", withFlag.refundPayment), "PAID");
}

function testCancellationEmailDraftWording() {
  const clarification = cancellationPaymentClarification();
  assert.match(clarification, /separately/i);
  assert.doesNotMatch(clarification, /will be processed/i);

  const draft = buildBookingCancellationEmailDraft({
    customerFullName: "Alex Customer",
    bookingReference: "EMR-TEST-1",
    vehicleName: "Vespa",
    pickupDateTime: new Date("2026-06-01T10:00:00.000Z"),
    returnDateTime: new Date("2026-06-03T10:00:00.000Z"),
    refundPayment: true,
  });

  assert.match(draft.subject, /EMR-TEST-1/);
  assertDraftNeverPromisesRefund(draft.body);
  assert.match(draft.body, /Alex Customer/);
}

function testOfflineDepositOutcomeStillInSchema() {
  const parsed = cancelBookingSchema.parse({
    depositOutcome: "REFUNDED",
    depositRefundAmount: 250,
    emailSubject: "Cancelled",
    emailBody: "Cancelled.",
  });
  assert.equal(parsed.depositOutcome, "REFUNDED");
  assert.equal(parsed.depositRefundAmount, 250);
}

function createMockCancelHarness(initial: {
  booking: BookingRow;
  unit?: UnitRow;
  /** When set, a REDEEMED loyalty credit is restored on PENDING_PAYMENT cancel. */
  redeemedLoyaltyCredit?: boolean;
}) {
  const booking: BookingRow = { ...initial.booking };
  const unit: UnitRow | null = initial.unit ? { ...initial.unit } : null;
  const occupancyDeletes: string[] = [];
  const statusHistory: Array<{ oldStatus: BookingStatus; newStatus: BookingStatus }> = [];
  let stripeRefundCalls = 0;
  const loyaltyCredits: Array<{
    id: string;
    redeemedBookingId: string | null;
    status: "REDEEMED" | "AVAILABLE";
  }> = initial.redeemedLoyaltyCredit
    ? [{ id: "credit_1", redeemedBookingId: booking.id, status: "REDEEMED" }]
    : [];
  let loyaltyRestoreAttempts = 0;

  /** When set, mutates booking before the transactional updateMany (payment-wins race). */
  let raceFlip: Partial<BookingRow> | null = null;

  const tx = {
    booking: {
      update: async ({ data }: { data: Partial<BookingRow> }) => {
        Object.assign(booking, data);
        return booking;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          status?: BookingStatus;
          paymentStatus?: PaymentStatus | { in: PaymentStatus[] };
        };
        data: Partial<BookingRow>;
      }) => {
        if (raceFlip) {
          Object.assign(booking, raceFlip);
          raceFlip = null;
        }
        if (where.id !== booking.id) return { count: 0 };
        if (where.status && booking.status !== where.status) return { count: 0 };
        if (where.paymentStatus && typeof where.paymentStatus === "object" && "in" in where.paymentStatus) {
          if (!where.paymentStatus.in.includes(booking.paymentStatus)) return { count: 0 };
        } else if (where.paymentStatus && booking.paymentStatus !== where.paymentStatus) {
          return { count: 0 };
        }
        Object.assign(booking, data);
        return { count: 1 };
      },
    },
    vehicleUnit: {
      update: async ({ data }: { data: { status: string } }) => {
        assert.ok(unit, "vehicle unit update expected a unit");
        unit.status = data.status;
        return unit;
      },
    },
    bookingStatusHistory: {
      create: async ({
        data,
      }: {
        data: { oldStatus: BookingStatus; newStatus: BookingStatus };
      }) => {
        statusHistory.push({ oldStatus: data.oldStatus, newStatus: data.newStatus });
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
        loyaltyRestoreAttempts += 1;
        let count = 0;
        for (const credit of loyaltyCredits) {
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
      occupancyDeletes.push(booking.id);
      return BigInt(1);
    },
  };

  const db = {
    booking: {
      findUnique: async () => ({ ...booking }),
    },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };

  const detail = (overrides?: Partial<AdminBookingDetail>): AdminBookingDetail =>
    ({
      id: booking.id,
      bookingReference: "EMR-MOCK-1",
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      securityDepositStatus: booking.securityDepositStatus,
      vehicleUnitId: booking.vehicleUnitId,
      vehicleName: "Mock Vehicle",
      customerEmail: "guest@test.local",
      customerFullName: "Guest",
      ...overrides,
    }) as AdminBookingDetail;

  return {
    booking,
    unit,
    occupancyDeletes,
    statusHistory,
    loyaltyCredits,
    get loyaltyRestoreAttempts() {
      return loyaltyRestoreAttempts;
    },
    get stripeRefundCalls() {
      return stripeRefundCalls;
    },
    /** Simulate payment confirmation winning between outer read and tx updateMany. */
    setRaceFlip(next: Partial<BookingRow>) {
      raceFlip = next;
    },
    /** Exposed only so tests can prove cancel never touches a refund spy. */
    recordStripeRefundAttempt() {
      stripeRefundCalls += 1;
    },
    deps: {
      db: db as never,
      getBookingDetail: async () => detail(),
      deleteOccupancyForBooking: async (_tx: unknown, id: string) => {
        occupancyDeletes.push(id);
      },
    },
  };
}

const baseCancelInput = {
  refundPayment: true as const,
  depositOutcome: "UNCHANGED" as const,
  emailSubject: "Cancelled",
  emailBody: "Cancelled for test.",
};

async function testCancelBookingPaidKeepsPaymentStatusWithLegacyFlag() {
  const harness = createMockCancelHarness({
    booking: {
      id: "bkg_paid",
      status: "CONFIRMED",
      paymentStatus: "PAID",
      securityDepositStatus: "PENDING",
      vehicleUnitId: "unit_1",
    },
    unit: { id: "unit_1", status: "RESERVED" },
  });

  const result = await cancelBooking("bkg_paid", baseCancelInput, "admin_1", harness.deps);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(harness.booking.status, "CANCELLED");
  assert.equal(harness.booking.paymentStatus, "PAID");
  assert.equal(result.booking.paymentStatus, "PAID");
  assert.equal(harness.unit?.status, "AVAILABLE");
  assert.deepEqual(harness.occupancyDeletes, ["bkg_paid"]);
  assert.equal(harness.statusHistory.length, 1);
  assert.equal(harness.statusHistory[0]?.newStatus, "CANCELLED");
  // cancelBooking has no Stripe dependency path; spy remains untouched.
  assert.equal(harness.stripeRefundCalls, 0);
}

async function testCancelBookingAlreadyRefundedPreserved() {
  const harness = createMockCancelHarness({
    booking: {
      id: "bkg_refunded",
      status: "CONFIRMED",
      paymentStatus: "REFUNDED",
      securityDepositStatus: "PENDING",
      vehicleUnitId: "unit_2",
    },
    unit: { id: "unit_2", status: "RESERVED" },
  });

  const result = await cancelBooking(
    "bkg_refunded",
    { ...baseCancelInput, refundPayment: false },
    "admin_1",
    harness.deps,
  );

  assert.equal(result.ok, true);
  assert.equal(harness.booking.status, "CANCELLED");
  assert.equal(harness.booking.paymentStatus, "REFUNDED");
  assert.equal(harness.stripeRefundCalls, 0);
}

async function testCancelBookingRepeatedIsRejected() {
  const harness = createMockCancelHarness({
    booking: {
      id: "bkg_once",
      status: "CONFIRMED",
      paymentStatus: "PAID",
      securityDepositStatus: "PENDING",
      vehicleUnitId: "unit_3",
    },
    unit: { id: "unit_3", status: "RESERVED" },
  });

  const first = await cancelBooking("bkg_once", baseCancelInput, "admin_1", harness.deps);
  assert.equal(first.ok, true);
  assert.equal(harness.booking.paymentStatus, "PAID");

  const second = await cancelBooking("bkg_once", baseCancelInput, "admin_1", harness.deps);
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "invalid_status");
  }
  assert.equal(harness.booking.paymentStatus, "PAID");
  assert.equal(harness.stripeRefundCalls, 0);
}

async function testCancelBookingUnpaidPendingStillWorks() {
  const harness = createMockCancelHarness({
    booking: {
      id: "bkg_pending",
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      securityDepositStatus: "PENDING",
      vehicleUnitId: "unit_4",
    },
    unit: { id: "unit_4", status: "RESERVED" },
  });

  const result = await cancelBooking(
    "bkg_pending",
    { ...baseCancelInput, refundPayment: false },
    "admin_1",
    harness.deps,
  );

  assert.equal(result.ok, true);
  assert.equal(harness.booking.status, "CANCELLED");
  assert.equal(harness.booking.paymentStatus, "PENDING");
  assert.equal(harness.unit?.status, "AVAILABLE");
}

async function testDepositOnlyPendingCancelRestoresLoyaltyOnceWithoutRefund() {
  const harness = createMockCancelHarness({
    booking: {
      id: "bkg_dep_only",
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      securityDepositStatus: "PENDING",
      vehicleUnitId: "unit_dep",
    },
    unit: { id: "unit_dep", status: "RESERVED" },
    redeemedLoyaltyCredit: true,
  });

  const first = await cancelBooking(
    "bkg_dep_only",
    { ...baseCancelInput, refundPayment: false, depositOutcome: "UNCHANGED" },
    "admin_1",
    harness.deps,
  );
  assert.equal(first.ok, true);
  assert.equal(harness.booking.status, "CANCELLED");
  assert.equal(harness.booking.paymentStatus, "PENDING");
  assert.equal(harness.loyaltyCredits[0]?.status, "AVAILABLE");
  assert.equal(harness.loyaltyCredits[0]?.redeemedBookingId, null);
  assert.equal(harness.loyaltyRestoreAttempts, 1);
  assert.equal(harness.stripeRefundCalls, 0);
  assert.equal(harness.unit?.status, "AVAILABLE");

  const second = await cancelBooking(
    "bkg_dep_only",
    { ...baseCancelInput, refundPayment: false },
    "admin_1",
    harness.deps,
  );
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "invalid_status");
  }
  // Second cancel never enters the transaction, so loyalty restore is not attempted again.
  assert.equal(harness.loyaltyRestoreAttempts, 1);
  assert.equal(harness.loyaltyCredits[0]?.status, "AVAILABLE");
  assert.equal(harness.stripeRefundCalls, 0);
}

async function testCancelAfterPaidDoesNotRestoreLoyalty() {
  const harness = createMockCancelHarness({
    booking: {
      id: "bkg_stale_paid",
      status: "PENDING_PAYMENT",
      paymentStatus: "PAID",
      securityDepositStatus: "PENDING",
      vehicleUnitId: "unit_race",
    },
    unit: { id: "unit_race", status: "RESERVED" },
    redeemedLoyaltyCredit: true,
  });

  const result = await cancelBooking(
    "bkg_stale_paid",
    { ...baseCancelInput, refundPayment: false },
    "admin_1",
    harness.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_status");
  }
  assert.equal(harness.booking.status, "PENDING_PAYMENT");
  assert.equal(harness.booking.paymentStatus, "PAID");
  assert.equal(harness.loyaltyCredits[0]?.status, "REDEEMED");
  assert.equal(harness.loyaltyRestoreAttempts, 0);
}

async function testStalePendingCancelLosesWhenPaymentWinsRace() {
  const harness = createMockCancelHarness({
    booking: {
      id: "bkg_race",
      status: "PENDING_PAYMENT",
      paymentStatus: "PENDING",
      securityDepositStatus: "PENDING",
      vehicleUnitId: "unit_race2",
    },
    unit: { id: "unit_race2", status: "RESERVED" },
    redeemedLoyaltyCredit: true,
  });

  // Payment confirmation flips the row after the outer read, before updateMany.
  harness.setRaceFlip({ status: "CONFIRMED", paymentStatus: "PAID" });

  const result = await cancelBooking(
    "bkg_race",
    { ...baseCancelInput, refundPayment: false },
    "admin_1",
    harness.deps,
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, "invalid_status");
  }
  assert.equal(harness.booking.status, "CONFIRMED");
  assert.equal(harness.booking.paymentStatus, "PAID");
  assert.equal(harness.loyaltyCredits[0]?.status, "REDEEMED");
  assert.equal(harness.loyaltyRestoreAttempts, 0);
  assert.equal(harness.statusHistory.length, 0);
}

async function run() {
  testPaymentStatusPreservedOnCancel();
  testSchemaStillAcceptsLegacyRefundPaymentFlag();
  testCancellationEmailDraftWording();
  testOfflineDepositOutcomeStillInSchema();
  await testCancelBookingPaidKeepsPaymentStatusWithLegacyFlag();
  await testCancelBookingAlreadyRefundedPreserved();
  await testCancelBookingRepeatedIsRejected();
  await testCancelBookingUnpaidPendingStillWorks();
  await testDepositOnlyPendingCancelRestoresLoyaltyOnceWithoutRefund();
  await testCancelAfterPaidDoesNotRestoreLoyalty();
  await testStalePendingCancelLosesWhenPaymentWinsRace();
  console.log("Cancel booking refund-integrity checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
