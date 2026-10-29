/**
 * Production-grade booking/availability audit tests.
 *
 * Run: npm run test:booking-availability
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { addHours, addMinutes } from "date-fns";

import { Prisma, type BookingStatus, type VehicleUnitStatus } from "../src/generated/prisma/index";
import { BLOCKING_BOOKING_STATUSES, buildOverlappingRangeWhere } from "../src/lib/availability/types";
import {
  AvailabilityConflictError,
  submitBooking,
  validateStorageBoxSelection,
  type BookingSubmissionInput,
} from "../src/lib/booking";
import { calculateBookingPrice } from "../src/lib/pricing/calculate-booking-price";
import { prisma } from "../src/lib/prisma";
import {
  assignAvailableVehicleUnit,
  findAvailableVehicleUnits,
  NoAvailableVehicleUnitError,
} from "../src/lib/vehicle-units";
import {
  deleteOccupancyForBooking,
  insertBookingOccupancy,
  insertHoldOccupancy,
  isVehicleUnitOccupancyExclusionError,
} from "../src/lib/vehicle-unit-occupancy";
import {
  updateAdminVehicleUnit,
  VehicleUnitHasActiveBookingError,
} from "../src/lib/admin/vehicle-units";
import { cancelBooking, handOverVehicle, restoreCancelledBooking } from "../src/lib/admin/bookings/lifecycle";
import { cleanupExpiredHolds } from "../src/lib/reservation-holds/cleanupExpiredHolds";

const TEST_EMAIL = "availability-audit@test.local";
const TEST_MARKER = "availability-audit-test";
const testSuffix = Date.now().toString(36);

type TestVehicle = {
  vehicleId: string;
  unitIds: string[];
};

function logPass(name: string): void {
  console.log(`${name} PASS`);
}

function isExpectedConcurrencyFailure(error: unknown): boolean {
  if (
    error instanceof NoAvailableVehicleUnitError ||
    error instanceof AvailabilityConflictError ||
    isVehicleUnitOccupancyExclusionError(error)
  ) {
    return true;
  }

  if (error && typeof error === "object") {
    const candidate = error as { code?: string; meta?: { code?: string } };
    if (candidate.code === "P2034" || candidate.code === "40001" || candidate.code === "P2028") {
      return true;
    }
    if (candidate.meta?.code === "23P01" || candidate.meta?.code === "40001") {
      return true;
    }
  }

  const message = String((error as Error)?.message ?? "");
  const networkCode = (error as { code?: string })?.code;
  if (networkCode === "EAI_AGAIN" || networkCode === "ETIMEDOUT" || networkCode === "ECONNRESET") {
    return true;
  }

  return (
    message.includes("write conflict") ||
    message.includes("could not serialize access") ||
    message.includes("exclusion constraint") ||
    message.includes("Unable to start a transaction")
  );
}

function baseDate(day: number, hour = 10, minute = 0): Date {
  return new Date(Date.UTC(2099, 5, day, hour, minute, 0, 0));
}

function bookingPayload(input: {
  vehicleId: string;
  vehicleType: string;
  pickup: Date;
  returnAt: Date;
  idempotencyKey?: string;
  holdReference?: string;
}): BookingSubmissionInput {
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  const fmtTime = (d: Date) => d.toISOString().slice(11, 16);

  return {
    rental: {
      vehicleId: input.vehicleId,
      vehicleType: input.vehicleType as BookingSubmissionInput["rental"]["vehicleType"],
      pickupDate: fmtDate(input.pickup),
      pickupTime: fmtTime(input.pickup),
      returnDate: fmtDate(input.returnAt),
      returnTime: fmtTime(input.returnAt),
    },
    holdReference: input.holdReference,
    idempotencyKey: input.idempotencyKey,
    delivery: {
      pickupOption: "OFFICE",
      pickupAddress: null,
      pickupLatitude: null,
      pickupLongitude: null,
      dropoffOption: "OFFICE",
      dropoffAddress: null,
      dropoffLatitude: null,
      dropoffLongitude: null,
    },
    addons: {
      cdwOption: "NO_CDW",
      additionalDriverEnabled: false,
      helmetSize1: "M",
      helmetSize2: "L",
      storageBoxSelected: false,
    },
    customer: {
      fullName: "Availability Audit",
      phone: "+35699000001",
      email: TEST_EMAIL,
      nationality: "Maltese",
      dateOfBirth: "1990-01-01",
      licenseCategory: "B",
      specialNotes: TEST_MARKER,
      licenseUploadPath: null,
      passportUploadPath: null,
      willPresentLicenseAtPickup: true,
      willPresentIdAtPickup: true,
    },
    additionalDriver: {
      fullName: null,
      phone: null,
      email: null,
      nationality: null,
      dateOfBirth: null,
      licenseCategory: null,
      licenseUploadPath: null,
      passportUploadPath: null,
      willPresentLicenseAtPickup: false,
      willPresentIdAtPickup: false,
    },
    deposit: { depositMethod: "ONLINE" },
    payment: { mode: "STRIPE", proofPath: null },
    consent: { termsAccepted: true, termsAcceptedAt: new Date().toISOString() },
  };
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "VehicleUnitOccupancy"
    WHERE "bookingId" IN (SELECT "id" FROM "Booking" WHERE "customerEmail" = ${TEST_EMAIL})
       OR "reservationHoldId" IN (SELECT "id" FROM "ReservationHold" WHERE "customerEmail" = ${TEST_EMAIL})
  `;
  await prisma.customerLoyaltyCredit.deleteMany({
    where: {
      OR: [
        { sourceBooking: { customerEmail: TEST_EMAIL } },
        { redeemedBooking: { customerEmail: TEST_EMAIL } },
      ],
    },
  });
  await prisma.booking.deleteMany({ where: { customerEmail: TEST_EMAIL } });
  await prisma.reservationHold.deleteMany({ where: { customerEmail: TEST_EMAIL } });
  await prisma.vehicleUnit.deleteMany({
    where: { vehicle: { slug: { startsWith: "audit-test-" } } },
  });
  await prisma.vehicle.deleteMany({ where: { slug: { startsWith: "audit-test-" } } });
}

async function createSingleUnitVehicle(licensePlate: string): Promise<TestVehicle & { licensePlate: string }> {
  const slug = `audit-test-${testSuffix}-reuse-${randomBytes(3).toString("hex")}`;
  const vehicle = await prisma.vehicle.create({
    data: {
      name: `Audit Reuse Scooter ${slug}`,
      slug,
      vehicleType: "Scooter",
      baseDailyRate: 25,
      isActive: true,
      supportsStorageBox: false,
      units: {
        create: {
          licensePlate: licensePlate.toUpperCase(),
          status: "AVAILABLE",
          isActive: true,
        },
      },
    },
    include: { units: { orderBy: { createdAt: "asc" } } },
  });

  return {
    vehicleId: vehicle.id,
    unitIds: vehicle.units.map((unit) => unit.id),
    licensePlate: vehicle.units[0]!.licensePlate,
  };
}

function unitIsAvailable(
  units: Awaited<ReturnType<typeof findAvailableVehicleUnits>>,
  unitId: string,
): boolean {
  return units.some((unit) => unit.id === unitId);
}

async function runUnitActiveIntervalReuseTests(): Promise<void> {
  const ABC_PLATE = "ABC123";
  const { vehicleId, unitIds, licensePlate } = await createSingleUnitVehicle(ABC_PLATE);
  const unitId = unitIds[0]!;
  assert.equal(licensePlate, ABC_PLATE);

  // 1 June 10:00 → 5 June 10:00 (half-open [pickup, return))
  const booking1Pickup = baseDate(1, 10);
  const booking1Return = baseDate(5, 10);
  await createBlockingBooking({
    vehicleId,
    vehicleUnitId: unitId,
    pickup: booking1Pickup,
    returnAt: booking1Return,
    licensePlate,
  });

  // 2) Overlapping 3 June → 6 June must be blocked for ABC-123.
  const overlapPickup = baseDate(3, 10);
  const overlapReturn = baseDate(6, 10);
  const unitsDuringOverlap = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: overlapPickup,
    requestedEnd: overlapReturn,
  });
  assert.equal(
    unitIsAvailable(unitsDuringOverlap, unitId),
    false,
    "ABC-123 must be blocked for 3 Jun–6 Jun overlapping 1 Jun–5 Jun",
  );
  await assert.rejects(
    () =>
      assignAvailableVehicleUnit(
        { vehicleId, requestedStart: overlapPickup, requestedEnd: overlapReturn },
        prisma,
      ),
    NoAvailableVehicleUnitError,
  );

  // 3) Adjacent booking starting exactly at return (5 June 10:00) must be allowed.
  const adjacentPickup = baseDate(5, 10);
  const adjacentReturn = baseDate(8, 10);
  const unitsAdjacent = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: adjacentPickup,
    requestedEnd: adjacentReturn,
  });
  assert.equal(
    unitIsAvailable(unitsAdjacent, unitId),
    true,
    "ABC-123 must be available from 5 Jun 10:00 (touching half-open return boundary)",
  );

  const adjacentAssignment = await assignAvailableVehicleUnit(
    { vehicleId, requestedStart: adjacentPickup, requestedEnd: adjacentReturn },
    prisma,
  );
  assert.equal(adjacentAssignment.vehicleUnitId, unitId);
  assert.equal(adjacentAssignment.licensePlate, licensePlate);

  // 4) Booking from 6 June onward must be allowed while only the 1–5 Jun booking is active.
  const laterPickup = baseDate(6, 10);
  const laterReturn = baseDate(9, 10);
  const unitsLater = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: laterPickup,
    requestedEnd: laterReturn,
  });
  assert.equal(
    unitIsAvailable(unitsLater, unitId),
    true,
    "ABC-123 must be available from 6 Jun onward (no overlap with [1 Jun, 5 Jun))",
  );

  // 5) Same physical unit is reused: book adjacent period, then a future period after it ends.
  const adjacentBooking = await prisma.booking.create({
    data: {
      bookingReference: `AUD-ADJ-${randomBytes(2).toString("hex")}`,
      vehicleId,
      vehicleUnitId: unitId,
      vehicleNameSnapshot: "Audit",
      vehicleLicensePlateSnapshot: licensePlate,
      vehicleType: "Scooter",
      vehicleTypeSnapshot: "Scooter",
      pickupDateTime: adjacentPickup,
      returnDateTime: adjacentReturn,
      actualDurationHours: 72,
      billableDays: 3,
      pickupOption: "OFFICE",
      dropoffOption: "OFFICE",
      customerFullName: "Audit",
      customerPhone: "+35699000001",
      customerEmail: TEST_EMAIL,
      customerNationality: "Maltese",
      customerDateOfBirth: new Date("1990-01-01"),
      customerLicenseCategory: "B",
      customerSpecialNotes: TEST_MARKER,
      depositMethod: "IN_PERSON",
      rentalCost: 75,
      subtotal: 75,
    },
  });
  await insertBookingOccupancy(prisma, {
    vehicleUnitId: unitId,
    pickupAt: adjacentPickup,
    returnAt: adjacentReturn,
    bookingId: adjacentBooking.id,
  });

  // While 5–8 Jun is booked, 6–9 Jun must now be blocked on the same unit.
  const blockedAfterAdjacent = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: laterPickup,
    requestedEnd: laterReturn,
  });
  assert.equal(
    unitIsAvailable(blockedAfterAdjacent, unitId),
    false,
    "ABC-123 must be blocked for 6–9 Jun once 5–8 Jun adjacent booking exists",
  );

  // After 8 Jun 10:00 return, the unit is free again for non-overlapping reuse.
  const futurePickup = baseDate(8, 10);
  const futureReturn = baseDate(11, 10);
  const unitsFuture = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: futurePickup,
    requestedEnd: futureReturn,
  });
  assert.equal(
    unitIsAvailable(unitsFuture, unitId),
    true,
    "ABC-123 must be available again from 8 Jun 10:00 (half-open end of 5–8 booking)",
  );

  const futureAssignment = await assignAvailableVehicleUnit(
    { vehicleId, requestedStart: futurePickup, requestedEnd: futureReturn },
    prisma,
  );
  assert.equal(futureAssignment.vehicleUnitId, unitId);
  assert.equal(futureAssignment.licensePlate, licensePlate);

  const futureBooking = await prisma.booking.create({
    data: {
      bookingReference: `AUD-FUT-${randomBytes(2).toString("hex")}`,
      vehicleId,
      vehicleUnitId: unitId,
      vehicleNameSnapshot: "Audit",
      vehicleLicensePlateSnapshot: licensePlate,
      vehicleType: "Scooter",
      vehicleTypeSnapshot: "Scooter",
      pickupDateTime: futurePickup,
      returnDateTime: futureReturn,
      actualDurationHours: 72,
      billableDays: 3,
      pickupOption: "OFFICE",
      dropoffOption: "OFFICE",
      customerFullName: "Audit",
      customerPhone: "+35699000001",
      customerEmail: TEST_EMAIL,
      customerNationality: "Maltese",
      customerDateOfBirth: new Date("1990-01-01"),
      customerLicenseCategory: "B",
      customerSpecialNotes: TEST_MARKER,
      depositMethod: "IN_PERSON",
      rentalCost: 75,
      subtotal: 75,
    },
  });
  await insertBookingOccupancy(prisma, {
    vehicleUnitId: unitId,
    pickupAt: futurePickup,
    returnAt: futureReturn,
    bookingId: futureBooking.id,
  });

  const occupancyCount = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM "VehicleUnitOccupancy"
    WHERE "vehicleUnitId" = ${unitId}
      AND "bookingId" IN (
        SELECT "id" FROM "Booking" WHERE "customerEmail" = ${TEST_EMAIL}
      )
  `;
  assert.equal(Number(occupancyCount[0]?.count ?? 0), 3, "Three non-overlapping occupancy rows for same unit");

  logPass("I) Unit active-interval reuse (ABC-123, 1–5 Jun then adjacent/future)");
}

async function createTestVehicle(unitCount: number): Promise<TestVehicle> {
  const slug = `audit-test-${testSuffix}-${randomBytes(3).toString("hex")}`;
  const vehicle = await prisma.vehicle.create({
    data: {
      name: `Audit Test Scooter ${slug}`,
      slug,
      vehicleType: "Scooter",
      baseDailyRate: 25,
      isActive: true,
      supportsStorageBox: false,
      units: {
        create: Array.from({ length: unitCount }, () => ({
          licensePlate: `AUD${randomBytes(4).toString("hex").toUpperCase()}`,
          status: "AVAILABLE" as const,
          isActive: true,
        })),
      },
    },
    include: { units: { orderBy: { createdAt: "asc" } } },
  });

  return {
    vehicleId: vehicle.id,
    unitIds: vehicle.units.map((unit) => unit.id),
  };
}

async function createBlockingBooking(input: {
  vehicleId: string;
  vehicleUnitId: string;
  pickup: Date;
  returnAt: Date;
  status?: BookingStatus;
  licensePlate: string;
}): Promise<string> {
  const ref = `AUD-${randomBytes(3).toString("hex").toUpperCase()}`;
  const booking = await prisma.booking.create({
    data: {
      bookingReference: ref,
      status: input.status ?? "CONFIRMED",
      vehicleId: input.vehicleId,
      vehicleUnitId: input.vehicleUnitId,
      vehicleNameSnapshot: "Audit",
      vehicleLicensePlateSnapshot: input.licensePlate,
      vehicleType: "Scooter",
      vehicleTypeSnapshot: "Scooter",
      pickupDateTime: input.pickup,
      returnDateTime: input.returnAt,
      actualDurationHours: 2,
      billableDays: 1,
      pickupOption: "OFFICE",
      dropoffOption: "OFFICE",
      customerFullName: "Audit",
      customerPhone: "+35699000001",
      customerEmail: TEST_EMAIL,
      customerNationality: "Maltese",
      customerDateOfBirth: new Date("1990-01-01"),
      customerLicenseCategory: "B",
      customerSpecialNotes: TEST_MARKER,
      depositMethod: "IN_PERSON",
      baseDailyRateSnapshot: 25,
      appliedDailyRateSnapshot: 25,
      rentalCost: 25,
      subtotal: 25,
    },
  });

  if ((BLOCKING_BOOKING_STATUSES as readonly string[]).includes(booking.status)) {
    await insertBookingOccupancy(prisma, {
      vehicleUnitId: input.vehicleUnitId,
      pickupAt: input.pickup,
      returnAt: input.returnAt,
      bookingId: booking.id,
    });
  }

  return booking.id;
}

async function createTestHold(input: {
  vehicleId: string;
  vehicleUnitId: string;
  pickup: Date;
  returnAt: Date;
  expiresAt: Date;
  status?: "ACTIVE" | "EXPIRED" | "RELEASED";
}): Promise<string> {
  const hold = await prisma.reservationHold.create({
    data: {
      holdReference: `HLD-AUD-${randomBytes(3).toString("hex").toUpperCase()}`,
      vehicleId: input.vehicleId,
      vehicleUnitId: input.vehicleUnitId,
      vehicleType: "Scooter",
      sessionKey: randomBytes(16).toString("hex"),
      customerEmail: TEST_EMAIL,
      pickupDateTime: input.pickup,
      returnDateTime: input.returnAt,
      status: input.status ?? "ACTIVE",
      expiresAt: input.expiresAt,
    },
  });

  await insertHoldOccupancy(prisma, {
    vehicleUnitId: input.vehicleUnitId,
    pickupAt: input.pickup,
    returnAt: input.returnAt,
    reservationHoldId: hold.id,
  });

  return hold.id;
}

async function runUnitAssignmentTests(): Promise<void> {
  const { vehicleId, unitIds } = await createTestVehicle(3);
  const window = { start: baseDate(1, 10), end: baseDate(1, 12) };

  const first = await assignAvailableVehicleUnit(
    { vehicleId, requestedStart: window.start, requestedEnd: window.end },
    prisma,
  );
  assert.ok(unitIds.includes(first.vehicleUnitId));
  await createBlockingBooking({
    vehicleId,
    vehicleUnitId: first.vehicleUnitId,
    pickup: window.start,
    returnAt: window.end,
    licensePlate: first.licensePlate,
  });

  const second = await assignAvailableVehicleUnit(
    { vehicleId, requestedStart: window.start, requestedEnd: window.end },
    prisma,
  );
  assert.notEqual(second.vehicleUnitId, first.vehicleUnitId);
  await createBlockingBooking({
    vehicleId,
    vehicleUnitId: second.vehicleUnitId,
    pickup: window.start,
    returnAt: window.end,
    licensePlate: second.licensePlate,
  });

  const third = await assignAvailableVehicleUnit(
    { vehicleId, requestedStart: window.start, requestedEnd: window.end },
    prisma,
  );
  await createBlockingBooking({
    vehicleId,
    vehicleUnitId: third.vehicleUnitId,
    pickup: window.start,
    returnAt: window.end,
    licensePlate: third.licensePlate,
  });

  await assert.rejects(
    () =>
      assignAvailableVehicleUnit(
        { vehicleId, requestedStart: window.start, requestedEnd: window.end },
        prisma,
      ),
    NoAvailableVehicleUnitError,
  );

  const laterWindow = { start: baseDate(2, 10), end: baseDate(2, 12) };
  const reuse = await assignAvailableVehicleUnit(
    { vehicleId, requestedStart: laterWindow.start, requestedEnd: laterWindow.end },
    prisma,
  );
  assert.equal(reuse.vehicleUnitId, first.vehicleUnitId);

  logPass("A) Unit assignment (3 units + reuse)");
}

async function runConcurrencyTests(): Promise<void> {
  for (const unitCount of [1, 2] as const) {
    const { vehicleId } = await createTestVehicle(unitCount);
    const pickup = baseDate(10, 10);
    const returnAt = baseDate(10, 14);

    const attempts = 12;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, async () => {
        for (let retry = 0; retry < 8; retry += 1) {
          try {
            return await prisma.$transaction(
              async (tx) => {
                const assigned = await assignAvailableVehicleUnit(
                  { vehicleId, requestedStart: pickup, requestedEnd: returnAt },
                  tx,
                );
                const booking = await tx.booking.create({
                  data: {
                    bookingReference: `AUD-C${randomBytes(3).toString("hex")}`,
                    vehicleId,
                    vehicleUnitId: assigned.vehicleUnitId,
                    vehicleNameSnapshot: "Audit",
                    vehicleLicensePlateSnapshot: assigned.licensePlate,
                    vehicleType: "Scooter",
                    vehicleTypeSnapshot: "Scooter",
                    pickupDateTime: pickup,
                    returnDateTime: returnAt,
                    actualDurationHours: 4,
                    billableDays: 1,
                    pickupOption: "OFFICE",
                    dropoffOption: "OFFICE",
                    customerFullName: "Audit",
                    customerPhone: "+35699000001",
                    customerEmail: TEST_EMAIL,
                    customerNationality: "Maltese",
                    customerDateOfBirth: new Date("1990-01-01"),
                    customerLicenseCategory: "B",
                    customerSpecialNotes: TEST_MARKER,
                    depositMethod: "IN_PERSON",
                    rentalCost: 25,
                    subtotal: 25,
                  },
                });
                await insertBookingOccupancy(tx, {
                  vehicleUnitId: assigned.vehicleUnitId,
                  pickupAt: pickup,
                  returnAt,
                  bookingId: booking.id,
                });
                return booking.id;
              },
              { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
            );
          } catch (error) {
            if (isExpectedConcurrencyFailure(error) && retry + 1 < 8) {
              await new Promise((resolve) => setTimeout(resolve, 20 + retry * 30));
              continue;
            }
            throw error;
          }
        }
        throw new Error("Concurrency attempt exhausted retries");
      }),
    );

    const successes = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && isExpectedConcurrencyFailure(r.reason),
    );
    const unexpected = results.filter(
      (r) => r.status === "rejected" && !isExpectedConcurrencyFailure(r.reason),
    );
    if (unexpected.length > 0) {
      const first = unexpected[0];
      console.error(
        "Unexpected concurrency failures:",
        first && first.status === "rejected" ? first.reason : first,
      );
    }
    assert.equal(unexpected.length, 0, "All failed attempts should be availability/conflict errors");

    assert.equal(successes.length, unitCount, `Expected ${unitCount} successes with ${unitCount} units`);
    assert.equal(
      successes.length + conflicts.length,
      attempts,
      "Every attempt should either succeed or fail with an availability/conflict error",
    );

    const activeBookings = await prisma.booking.findMany({
      where: {
        vehicleId,
        customerEmail: TEST_EMAIL,
        status: { in: [...BLOCKING_BOOKING_STATUSES] },
        pickupDateTime: pickup,
      },
      select: { vehicleUnitId: true },
    });
    const uniqueUnits = new Set(activeBookings.map((b) => b.vehicleUnitId));
    assert.equal(uniqueUnits.size, unitCount);
    assert.equal(activeBookings.length, unitCount);

    logPass(`B) Concurrency (${unitCount} unit, ${attempts} parallel)`);
  }
}

async function runDateBoundaryTests(): Promise<void> {
  const { vehicleId, unitIds } = await createTestVehicle(1);
  const unitId = unitIds[0]!;
  const plate = `AUD${testSuffix.slice(-4)}0`;

  const bookingA = { start: baseDate(20, 10), end: baseDate(20, 12) };
  await createBlockingBooking({
    vehicleId,
    vehicleUnitId: unitId,
    pickup: bookingA.start,
    returnAt: bookingA.end,
    licensePlate: plate,
  });

  const bookingB = { start: baseDate(20, 12), end: baseDate(20, 14) };
  const availableAfterTouch = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: bookingB.start,
    requestedEnd: bookingB.end,
  });
  assert.equal(availableAfterTouch.length, 1, "12:00 start should not overlap 10:00-12:00 [start,end)");

  const bookingC = { start: baseDate(20, 11, 59), end: baseDate(20, 14) };
  const blockedOverlap = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: bookingC.start,
    requestedEnd: bookingC.end,
  });
  assert.equal(blockedOverlap.length, 0, "11:59-14:00 should overlap 10:00-12:00");

  const overlapWhere = buildOverlappingRangeWhere(bookingB.start, bookingB.end);
  assert.deepEqual(Object.keys(overlapWhere).sort(), ["pickupDateTime", "returnDateTime"]);

  logPass("C) Date boundary half-open intervals");
}

async function runStatusTests(): Promise<void> {
  const window = { start: baseDate(30, 10), end: baseDate(30, 12) };

  for (const status of ["CANCELLED", "COMPLETED"] as const) {
    const { vehicleId, unitIds } = await createTestVehicle(1);
    const unitId = unitIds[0]!;
    const id = await createBlockingBooking({
      vehicleId,
      vehicleUnitId: unitId,
      pickup: window.start,
      returnAt: window.end,
      status,
      licensePlate: `AUD${testSuffix.slice(-4)}0`,
    });
    await deleteOccupancyForBooking(prisma, id);
    const available = await findAvailableVehicleUnits({
      vehicleId,
      requestedStart: window.start,
      requestedEnd: window.end,
    });
    assert.equal(available.length, 1, `${status} should not block`);
  }

  for (const status of ["CONFIRMED", "VEHICLE_HANDED_OVER", "RETURNED"] as const) {
    const { vehicleId, unitIds } = await createTestVehicle(1);
    const unitId = unitIds[0]!;
    await createBlockingBooking({
      vehicleId,
      vehicleUnitId: unitId,
      pickup: window.start,
      returnAt: window.end,
      status,
      licensePlate: `AUD${testSuffix.slice(-4)}0`,
    });
    const blocked = await findAvailableVehicleUnits({
      vehicleId,
      requestedStart: window.start,
      requestedEnd: window.end,
    });
    assert.equal(blocked.length, 0, `${status} should block`);
  }

  logPass("D) Booking status blocking rules");
}

async function runUnitStatusTests(): Promise<void> {
  const statuses: Array<{ status: VehicleUnitStatus; isActive: boolean; bookable: boolean }> = [
    { status: "MAINTENANCE", isActive: true, bookable: false },
    { status: "NOT_AVAILABLE", isActive: true, bookable: false },
    { status: "OUT_WITH_CUSTOMER", isActive: true, bookable: false },
    { status: "AVAILABLE", isActive: false, bookable: false },
    { status: "AVAILABLE", isActive: true, bookable: true },
    { status: "RESERVED", isActive: true, bookable: true },
  ];

  for (const scenario of statuses) {
    const vehicle = await prisma.vehicle.create({
      data: {
        name: `Audit Unit Status ${scenario.status} ${randomBytes(2).toString("hex")}`,
        slug: `audit-test-${testSuffix}-${randomBytes(3).toString("hex")}`,
        vehicleType: "Scooter",
        baseDailyRate: 25,
        isActive: true,
        units: {
          create: {
            licensePlate: `ST${randomBytes(3).toString("hex").toUpperCase()}`,
            status: scenario.status,
            isActive: scenario.isActive,
          },
        },
      },
      include: { units: true },
    });

    const available = await findAvailableVehicleUnits({
      vehicleId: vehicle.id,
      requestedStart: baseDate(40, 10),
      requestedEnd: baseDate(40, 12),
    });
    assert.equal(
      available.length > 0,
      scenario.bookable,
      `status=${scenario.status} isActive=${scenario.isActive}`,
    );
  }

  logPass("E) Vehicle unit status rules");
}

async function runIdempotencyTests(): Promise<void> {
  const { vehicleId } = await createTestVehicle(2);
  const pickup = baseDate(15, 10);
  const returnAt = baseDate(17, 10);
  const idempotencyKey = `audit-idem-${testSuffix}-key123`;

  const payload = bookingPayload({
    vehicleId,
    vehicleType: "Scooter",
    pickup,
    returnAt,
    idempotencyKey,
  });

  const first = await submitBooking(payload);
  const second = await submitBooking(payload);
  assert.equal(first.bookingReference, second.bookingReference);

  const count = await prisma.booking.count({
    where: { idempotencyKey, customerEmail: TEST_EMAIL },
  });
  assert.equal(count, 1);

  const differentKeyPayload = bookingPayload({
    vehicleId,
    vehicleType: "Scooter",
    pickup: baseDate(19, 10),
    returnAt: baseDate(21, 10),
    idempotencyKey: `audit-idem-${testSuffix}-otherkey`,
  });
  const otherBooking = await submitBooking(differentKeyPayload);
  assert.notEqual(first.bookingReference, otherBooking.bookingReference);

  logPass("F) Idempotency key duplicate submit");
}

async function runSubmitDoesNotGloballyReserveUnitTests(): Promise<void> {
  const ABC_PLATE = `SUB${testSuffix.slice(-4)}`;
  const { vehicleId, unitIds } = await createSingleUnitVehicle(ABC_PLATE);
  const unitId = unitIds[0]!;

  const booking1Pickup = baseDate(70, 10);
  const booking1Return = baseDate(75, 10);

  await submitBooking(
    bookingPayload({
      vehicleId,
      vehicleType: "Scooter",
      pickup: booking1Pickup,
      returnAt: booking1Return,
      idempotencyKey: `audit-reserve-${testSuffix}-1`,
    }),
  );

  const unitAfterSubmit = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: unitId } });
  assert.notEqual(
    unitAfterSubmit.status,
    "RESERVED",
    "Booking submit must not globally mark the unit RESERVED",
  );

  const laterPickup = baseDate(75, 10);
  const laterReturn = baseDate(78, 10);
  const unitsLater = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: laterPickup,
    requestedEnd: laterReturn,
  });
  assert.equal(
    unitIsAvailable(unitsLater, unitId),
    true,
    "Unit must remain assignable for non-overlapping dates after submit",
  );

  const secondBooking = await submitBooking(
    bookingPayload({
      vehicleId,
      vehicleType: "Scooter",
      pickup: laterPickup,
      returnAt: laterReturn,
      idempotencyKey: `audit-reserve-${testSuffix}-2`,
    }),
  );
  assert.ok(secondBooking.bookingReference);

  logPass("K) Submit does not globally reserve unit status");
}

async function runExpiredHoldAutoCleanupAvailabilityTests(): Promise<void> {
  const { vehicleId, unitIds } = await createTestVehicle(1);
  const unitId = unitIds[0]!;
  const pickup = baseDate(48, 10);
  const returnAt = baseDate(48, 12);
  const pastExpiry = new Date(Date.now() - 60_000);

  await createTestHold({
    vehicleId,
    vehicleUnitId: unitId,
    pickup,
    returnAt,
    expiresAt: pastExpiry,
    status: "ACTIVE",
  });

  const occupancyBefore = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "VehicleUnitOccupancy" WHERE "vehicleUnitId" = ${unitId}
  `;
  assert.equal(occupancyBefore.length, 1, "Stale hold occupancy should exist before availability check");

  const available = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: pickup,
    requestedEnd: returnAt,
  });
  assert.equal(
    available.length,
    1,
    "findAvailableVehicleUnits must auto-clean stale hold occupancy and show unit available",
  );

  const occupancyAfter = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "VehicleUnitOccupancy" WHERE "vehicleUnitId" = ${unitId}
  `;
  assert.equal(occupancyAfter.length, 0, "Stale hold occupancy must be released during availability check");

  const availableAgain = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: pickup,
    requestedEnd: returnAt,
  });
  assert.equal(availableAgain.length, 1, "Repeated availability checks remain safe after cleanup");

  logPass("L) Expired hold auto-cleanup during availability");
}

async function runHoldCleanupTests(): Promise<void> {
  const { vehicleId, unitIds } = await createTestVehicle(1);
  const unitId = unitIds[0]!;
  const pickup = baseDate(50, 10);
  const returnAt = baseDate(50, 12);
  const pastExpiry = new Date(Date.now() - 60_000);
  const futureExpiry = new Date(Date.now() + 60 * 60_000);

  const expiredHoldId = await createTestHold({
    vehicleId,
    vehicleUnitId: unitId,
    pickup,
    returnAt,
    expiresAt: pastExpiry,
    status: "ACTIVE",
  });

  const holdOccupancyBefore = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "VehicleUnitOccupancy" WHERE "reservationHoldId" = ${expiredHoldId}
  `;
  assert.equal(
    holdOccupancyBefore.length,
    1,
    "Expired hold should retain occupancy until sweeper runs",
  );

  const firstCleanup = await cleanupExpiredHolds();
  assert.ok(firstCleanup.holdsExpired >= 1, "Sweeper should expire stale active holds");

  const availableAfterCleanup = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: pickup,
    requestedEnd: returnAt,
  });
  assert.equal(availableAfterCleanup.length, 1, "Unit should be free after expired hold cleanup");

  const secondCleanup = await cleanupExpiredHolds();
  assert.equal(secondCleanup.holdsExpired, 0, "Second cleanup run should be a no-op for holds");

  await createTestHold({
    vehicleId,
    vehicleUnitId: unitId,
    pickup: baseDate(51, 10),
    returnAt: baseDate(51, 12),
    expiresAt: futureExpiry,
    status: "ACTIVE",
  });

  const blockedByActiveHold = await findAvailableVehicleUnits({
    vehicleId,
    requestedStart: baseDate(51, 10),
    requestedEnd: baseDate(51, 12),
  });
  assert.equal(blockedByActiveHold.length, 0, "Active non-expired hold must still block");

  const bookingId = await createBlockingBooking({
    vehicleId,
    vehicleUnitId: unitId,
    pickup: baseDate(52, 10),
    returnAt: baseDate(52, 12),
    licensePlate: `AUD${testSuffix.slice(-4)}0`,
    status: "CONFIRMED",
  });

  const occupancyBefore = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "VehicleUnitOccupancy" WHERE "bookingId" = ${bookingId}
  `;
  assert.equal(occupancyBefore.length, 1);

  await cleanupExpiredHolds();

  const occupancyAfter = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "VehicleUnitOccupancy" WHERE "bookingId" = ${bookingId}
  `;
  assert.equal(occupancyAfter.length, 1, "Confirmed booking occupancy must not be deleted");

  logPass("J) Expired hold cleanup sweeper");
}

async function runAdminUnitLifecycleTests(): Promise<void> {
  const { vehicleId, unitIds } = await createTestVehicle(1);
  const unitId = unitIds[0]!;
  const unit = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: unitId } });
  const window = { start: baseDate(55, 10), end: baseDate(55, 12) };

  await createBlockingBooking({
    vehicleId,
    vehicleUnitId: unitId,
    pickup: window.start,
    returnAt: window.end,
    licensePlate: unit.licensePlate,
    status: "CONFIRMED",
  });

  await assert.rejects(
    () =>
      updateAdminVehicleUnit(vehicleId, unitId, {
        licensePlate: unit.licensePlate,
        status: "MAINTENANCE",
        isActive: true,
      }),
    VehicleUnitHasActiveBookingError,
  );

  await assert.rejects(
    () =>
      updateAdminVehicleUnit(vehicleId, unitId, {
        licensePlate: unit.licensePlate,
        status: "NOT_AVAILABLE",
        isActive: true,
      }),
    VehicleUnitHasActiveBookingError,
  );

  await assert.rejects(
    () =>
      updateAdminVehicleUnit(vehicleId, unitId, {
        licensePlate: unit.licensePlate,
        status: "AVAILABLE",
        isActive: false,
      }),
    VehicleUnitHasActiveBookingError,
  );

  const booking = await prisma.booking.findFirstOrThrow({ where: { vehicleUnitId: unitId } });
  await deleteOccupancyForBooking(prisma, booking.id);
  await prisma.booking.update({ where: { id: booking.id }, data: { status: "CANCELLED" } });

  const updated = await updateAdminVehicleUnit(vehicleId, unitId, {
    licensePlate: unit.licensePlate,
    status: "MAINTENANCE",
    isActive: false,
  });
  assert.ok(updated);

  logPass("I) Admin unit lifecycle guards");
}

async function runPricingConsistencyTests(): Promise<void> {
  const { vehicleId } = await createTestVehicle(2);
  const vehicle = await prisma.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    select: { baseDailyRate: true, vehicleType: true, supportsStorageBox: true },
  });

  const pickup = baseDate(16, 10);
  const returnAt = baseDate(18, 10);
  const baseRate = vehicle.baseDailyRate.toNumber();

  const priceBefore = calculateBookingPrice({
    rental: {
      vehicle: { type: vehicle.vehicleType },
      pickupDate: pickup.toISOString().slice(0, 10),
      pickupTime: "10:00",
      returnDate: returnAt.toISOString().slice(0, 10),
      returnTime: "10:00",
    },
    delivery: { pickupOption: "office", dropoffOption: "office" },
    addons: { cdwOption: "no_cdw", additionalDriver: false, storageBox: false },
    additionalDriver: { enabled: false },
    deposit: { method: "in_person" },
    vehiclePricing: {
      baseDailyRate: baseRate,
      vehicleType: vehicle.vehicleType,
      supportsStorageBox: vehicle.supportsStorageBox,
    },
  });
  assert.ok(priceBefore);

  const booking = await submitBooking(
    bookingPayload({ vehicleId, vehicleType: "Scooter", pickup, returnAt }),
  );

  const stored = await prisma.booking.findUniqueOrThrow({
    where: { bookingReference: booking.bookingReference },
    select: {
      baseDailyRateSnapshot: true,
      rentalCost: true,
      vehicleUnitId: true,
    },
  });

  assert.equal(stored.baseDailyRateSnapshot?.toNumber(), baseRate);
  assert.equal(stored.rentalCost.toNumber(), priceBefore.rentalCost);
  assert.ok(stored.vehicleUnitId);

  const storageBoxError = validateStorageBoxSelection(false, true);
  assert.ok(storageBoxError, "Storage box should be rejected when vehicle does not support it");

  logPass("G) Pricing consistency + storage box rejection");
}

async function runDbExclusionSmokeTest(): Promise<void> {
  const { unitIds } = await createTestVehicle(1);
  const unitId = unitIds[0]!;
  const pickup = baseDate(70, 10);
  const returnAt = baseDate(70, 12);

  const bookingA = await prisma.booking.create({
    data: {
      bookingReference: `AUD-EXC-A-${randomBytes(2).toString("hex")}`,
      vehicleUnitId: unitId,
      vehicleType: "Scooter",
      pickupDateTime: pickup,
      returnDateTime: returnAt,
      actualDurationHours: 2,
      billableDays: 1,
      pickupOption: "OFFICE",
      dropoffOption: "OFFICE",
      customerFullName: "Audit",
      customerPhone: "+35699000001",
      customerEmail: TEST_EMAIL,
      customerNationality: "Maltese",
      customerDateOfBirth: new Date("1990-01-01"),
      customerLicenseCategory: "B",
      customerSpecialNotes: TEST_MARKER,
      depositMethod: "IN_PERSON",
      rentalCost: 25,
      subtotal: 25,
    },
  });

  await insertBookingOccupancy(prisma, {
    vehicleUnitId: unitId,
    pickupAt: pickup,
    returnAt,
    bookingId: bookingA.id,
  });

  const bookingB = await prisma.booking.create({
    data: {
      bookingReference: `AUD-EXC-B-${randomBytes(2).toString("hex")}`,
      vehicleUnitId: unitId,
      vehicleType: "Scooter",
      pickupDateTime: addMinutes(pickup, 30),
      returnDateTime: addHours(returnAt, 1),
      actualDurationHours: 2,
      billableDays: 1,
      pickupOption: "OFFICE",
      dropoffOption: "OFFICE",
      customerFullName: "Audit",
      customerPhone: "+35699000001",
      customerEmail: TEST_EMAIL,
      customerNationality: "Maltese",
      customerDateOfBirth: new Date("1990-01-01"),
      customerLicenseCategory: "B",
      customerSpecialNotes: TEST_MARKER,
      depositMethod: "IN_PERSON",
      rentalCost: 25,
      subtotal: 25,
    },
  });

  await assert.rejects(
    () =>
      insertBookingOccupancy(prisma, {
        vehicleUnitId: unitId,
        pickupAt: addMinutes(pickup, 30),
        returnAt: addHours(returnAt, 1),
        bookingId: bookingB.id,
      }),
    (error: unknown) => isVehicleUnitOccupancyExclusionError(error),
  );

  logPass("H) PostgreSQL EXCLUDE constraint smoke test");
}

async function runRestoreCancelledBookingTests(): Promise<void> {
  const { vehicleId, unitIds } = await createTestVehicle(1);
  const unitId = unitIds[0]!;
  const unit = await prisma.vehicleUnit.findUniqueOrThrow({
    where: { id: unitId },
    select: { licensePlate: true },
  });

  const pickup = baseDate(22, 10);
  const returnAt = baseDate(24, 10);
  const bookingId = await createBlockingBooking({
    vehicleId,
    vehicleUnitId: unitId,
    pickup,
    returnAt,
    licensePlate: unit.licensePlate,
  });

  const admin = await prisma.adminUser.create({
    data: {
      name: "Restore Audit Admin",
      email: `restore-audit-${testSuffix}@test.local`,
      role: "STAFF",
      isActive: true,
    },
  });

  try {
    const cancelled = await cancelBooking(
      bookingId,
      {
        refundPayment: false,
        depositOutcome: "UNCHANGED",
        emailSubject: "Cancelled",
        emailBody: "Cancelled for audit.",
        note: "Accidental cancel in audit",
      },
      admin.id,
    );
    assert.equal(cancelled.ok, true);
    const occupancyAfterCancel = await prisma.vehicleUnitOccupancy.findFirst({
      where: { bookingId },
    });
    assert.equal(occupancyAfterCancel, null);

    const restored = await restoreCancelledBooking(
      bookingId,
      { note: "Undo accidental cancellation" },
      admin.id,
    );
    assert.equal(restored.ok, true);
    if (restored.ok) {
      assert.equal(restored.booking.status, "CONFIRMED");
    }

    const occupancyAfterRestore = await prisma.vehicleUnitOccupancy.findFirst({
      where: { bookingId },
    });
    assert.ok(occupancyAfterRestore);
    assert.equal(occupancyAfterRestore?.vehicleUnitId, unitId);

    const restoreAgain = await restoreCancelledBooking(bookingId, {}, admin.id);
    assert.equal(restoreAgain.ok, false);
    if (!restoreAgain.ok) {
      assert.equal(restoreAgain.reason, "invalid_status");
    }

    const cancelledAgain = await cancelBooking(
      bookingId,
      {
        refundPayment: false,
        depositOutcome: "UNCHANGED",
        emailSubject: "Cancelled",
        emailBody: "Cancelled for conflict audit.",
      },
      admin.id,
    );
    assert.equal(cancelledAgain.ok, true);

    const overlappingId = await createBlockingBooking({
      vehicleId,
      vehicleUnitId: unitId,
      pickup: addHours(pickup, 2),
      returnAt: addHours(returnAt, 2),
      licensePlate: unit.licensePlate,
    });
    assert.ok(overlappingId);

    const conflicted = await restoreCancelledBooking(bookingId, {}, admin.id);
    assert.equal(conflicted.ok, false);
    if (!conflicted.ok) {
      assert.equal(conflicted.reason, "occupancy_conflict");
    }

    const stillCancelled = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { status: true },
    });
    assert.equal(stillCancelled.status, "CANCELLED");
  } finally {
    await prisma.bookingStatusHistory.deleteMany({ where: { changedByAdminId: admin.id } });
    await prisma.adminUser.delete({ where: { id: admin.id } }).catch(() => undefined);
  }

  logPass("J) Restore cancelled booking");
}

async function runHandoverUnitChangeTests(): Promise<void> {
  const { vehicleId, unitIds } = await createTestVehicle(2);
  const unitA = unitIds[0]!;
  const unitB = unitIds[1]!;
  const [plateA, plateB] = await Promise.all([
    prisma.vehicleUnit.findUniqueOrThrow({ where: { id: unitA }, select: { licensePlate: true } }),
    prisma.vehicleUnit.findUniqueOrThrow({ where: { id: unitB }, select: { licensePlate: true } }),
  ]);

  const pickup = baseDate(80, 10);
  const returnAt = baseDate(82, 10);
  const bookingId = await createBlockingBooking({
    vehicleId,
    vehicleUnitId: unitA,
    pickup,
    returnAt,
    licensePlate: plateA.licensePlate,
  });

  const admin = await prisma.adminUser.create({
    data: {
      name: "Handover Audit Admin",
      email: `handover-audit-${testSuffix}@test.local`,
      role: "STAFF",
      isActive: true,
    },
  });

  try {
    const handedOver = await handOverVehicle(
      bookingId,
      {
        paymentReceivedAmount: 25,
        paymentMethod: "CASH",
        paymentConfirmed: true,
        securityDepositCollectedAmount: 0,
        depositCollectedConfirmed: true,
        handoverDateTime: pickup,
        vehicleUnitId: unitB,
      },
      admin.id,
    );
    assert.equal(handedOver.ok, true);

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: { vehicleUnitId: true, status: true },
    });
    assert.equal(booking.vehicleUnitId, unitB);
    assert.equal(booking.status, "VEHICLE_HANDED_OVER");

    const occupancy = await prisma.vehicleUnitOccupancy.findFirst({
      where: { bookingId },
      select: { vehicleUnitId: true },
    });
    assert.equal(occupancy?.vehicleUnitId, unitB);

    const available = await findAvailableVehicleUnits({
      vehicleId,
      requestedStart: pickup,
      requestedEnd: returnAt,
    });
    assert.equal(available.length, 1);
    assert.equal(available[0]?.id, unitA);
  } finally {
    await prisma.bookingStatusHistory.deleteMany({ where: { changedByAdminId: admin.id } });
    await prisma.adminUser.delete({ where: { id: admin.id } }).catch(() => undefined);
  }

  const adminForConflict = await prisma.adminUser.create({
    data: {
      name: "Handover Conflict Admin",
      email: `handover-conflict-${testSuffix}@test.local`,
      role: "STAFF",
      isActive: true,
    },
  });

  try {
    const overlapPickup = baseDate(90, 10);
    const overlapReturn = baseDate(92, 10);
    const bookingOnA = await createBlockingBooking({
      vehicleId,
      vehicleUnitId: unitA,
      pickup: overlapPickup,
      returnAt: overlapReturn,
      licensePlate: plateA.licensePlate,
    });
    await createBlockingBooking({
      vehicleId,
      vehicleUnitId: unitB,
      pickup: baseDate(91, 10),
      returnAt: baseDate(93, 10),
      licensePlate: plateB.licensePlate,
    });

    const conflicted = await handOverVehicle(
      bookingOnA,
      {
        paymentReceivedAmount: 25,
        paymentMethod: "CASH",
        paymentConfirmed: true,
        securityDepositCollectedAmount: 0,
        depositCollectedConfirmed: true,
        handoverDateTime: overlapPickup,
        vehicleUnitId: unitB,
      },
      adminForConflict.id,
    );
    assert.equal(conflicted.ok, false);
    if (!conflicted.ok) {
      assert.equal(conflicted.reason, "occupancy_conflict");
    }
  } finally {
    await prisma.bookingStatusHistory.deleteMany({ where: { changedByAdminId: adminForConflict.id } });
    await prisma.adminUser.delete({ where: { id: adminForConflict.id } }).catch(() => undefined);
  }

  logPass("K) Handover unit change syncs occupancy");
}

async function main(): Promise<void> {
  await cleanup();

  await runUnitAssignmentTests();
  await cleanup();

  await runConcurrencyTests();
  await cleanup();

  await runDateBoundaryTests();
  await cleanup();

  await runUnitActiveIntervalReuseTests();
  await cleanup();

  await runStatusTests();
  await cleanup();

  await runUnitStatusTests();
  await cleanup();

  await runIdempotencyTests();
  await cleanup();

  await runSubmitDoesNotGloballyReserveUnitTests();
  await cleanup();

  await runExpiredHoldAutoCleanupAvailabilityTests();
  await cleanup();

  await runAdminUnitLifecycleTests();
  await cleanup();

  await runHoldCleanupTests();
  await cleanup();

  await runPricingConsistencyTests();
  await cleanup();

  await runDbExclusionSmokeTest();
  await cleanup();

  await runRestoreCancelledBookingTests();
  await cleanup();

  await runHandoverUnitChangeTests();
  await cleanup();

  console.log("All booking/availability audit tests passed.");
}

main().catch(async (error) => {
  await cleanup().catch(() => undefined);
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
