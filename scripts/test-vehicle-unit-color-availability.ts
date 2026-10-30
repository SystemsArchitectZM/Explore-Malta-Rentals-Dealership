/**
 * Vehicle unit color availability tests.
 *
 * Run: npm run test:vehicle-unit-colors
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { Prisma } from "../src/generated/prisma/index";
import {
  colorsMatch,
  normalizeVehicleColorForStorage,
  vehicleColorToValue,
} from "../src/features/vehicles/lib/vehicle-color";
import { createAdminVehicleUnit } from "../src/lib/admin/vehicle-units";
import { submitBooking, type BookingSubmissionInput } from "../src/lib/booking";
import { prisma } from "../src/lib/prisma";
import { assertSafeScriptDatabase } from "./assert-safe-script-database";
import { createReservationHold } from "../src/lib/reservation-holds";
import {
  assignAvailableVehicleUnit,
  findAvailableVehicleUnits,
  getAvailableColorsForVehicle,
  NoAvailableVehicleUnitError,
} from "../src/lib/vehicle-units";

const TEST_EMAIL = "unit-color-audit@test.local";
const TEST_MARKER = "unit-color-audit-test";
const testSuffix = Date.now().toString(36);

function logPass(name: string): void {
  console.log(`${name} PASS`);
}

function baseDate(day: number, hour = 10): Date {
  return new Date(Date.UTC(2099, 7, day, hour, 0, 0, 0));
}

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "VehicleUnitOccupancy"
    WHERE "bookingId" IN (SELECT "id" FROM "Booking" WHERE "customerEmail" = ${TEST_EMAIL})
       OR "reservationHoldId" IN (SELECT "id" FROM "ReservationHold" WHERE "customerEmail" = ${TEST_EMAIL})
  `;
  await prisma.booking.deleteMany({ where: { customerEmail: TEST_EMAIL } });
  await prisma.reservationHold.deleteMany({ where: { customerEmail: TEST_EMAIL } });
  await prisma.vehicleUnit.deleteMany({
    where: { vehicle: { slug: { startsWith: `color-audit-${testSuffix}` } } },
  });
  await prisma.vehicle.deleteMany({ where: { slug: { startsWith: `color-audit-${testSuffix}` } } });
}

async function createTestVehicle() {
  const slug = `color-audit-${testSuffix}-${randomBytes(2).toString("hex")}`;
  return prisma.vehicle.create({
    data: {
      name: `Color Audit ${slug}`,
      slug,
      vehicleType: "Scooter",
      baseDailyRate: 25,
      isActive: true,
      supportsStorageBox: false,
    },
  });
}

function bookingPayload(input: {
  vehicleId: string;
  pickup: Date;
  returnAt: Date;
  holdReference?: string;
  selectedColor?: string;
}): BookingSubmissionInput {
  const fmtDate = (d: Date) => d.toISOString().slice(0, 10);
  const fmtTime = (d: Date) => d.toISOString().slice(11, 16);

  return {
    rental: {
      vehicleId: input.vehicleId,
      vehicleType: "Scooter",
      pickupDate: fmtDate(input.pickup),
      pickupTime: fmtTime(input.pickup),
      returnDate: fmtDate(input.returnAt),
      returnTime: fmtTime(input.returnAt),
      ...(input.selectedColor ? { selectedColor: input.selectedColor } : {}),
    },
    holdReference: input.holdReference,
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
      fullName: "Color Audit",
      phone: "+35699000002",
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
    deposit: { depositMethod: "IN_PERSON" },
    consent: { termsAccepted: true, termsAcceptedAt: new Date().toISOString() },
  };
}

async function testColorNormalization(): Promise<void> {
  assert.equal(normalizeVehicleColorForStorage("black"), "Black");
  assert.equal(normalizeVehicleColorForStorage("BLACK"), "Black");
  assert.equal(vehicleColorToValue("Black"), "black");
  assert.equal(colorsMatch("Black", "black"), true);
  assert.equal(colorsMatch("White", "Black"), false);
  logPass("color normalization");
}

async function testAvailableColorsAndFiltering(): Promise<void> {
  const vehicle = await createTestVehicle();
  const pickup = baseDate(10);
  const returnAt = baseDate(12);

  const blackUnit = await createAdminVehicleUnit(vehicle.id, {
    licensePlate: `BLK-${testSuffix}`.slice(0, 20),
    color: "Black",
    status: "AVAILABLE",
    isActive: true,
    notes: null,
  });
  const whiteUnit = await createAdminVehicleUnit(vehicle.id, {
    licensePlate: `WHT-${testSuffix}`.slice(0, 20),
    color: "White",
    status: "AVAILABLE",
    isActive: true,
    notes: null,
  });
  assert.ok(blackUnit && whiteUnit);

  const colors = await getAvailableColorsForVehicle({
    vehicleId: vehicle.id,
    requestedStart: pickup,
    requestedEnd: returnAt,
  });
  assert.equal(colors.length, 2);
  assert.ok(colors.some((c) => c.value === "black"));
  assert.ok(colors.some((c) => c.value === "white"));

  const blackOnly = await findAvailableVehicleUnits({
    vehicleId: vehicle.id,
    requestedStart: pickup,
    requestedEnd: returnAt,
    color: "Black",
  });
  assert.equal(blackOnly.length, 1);
  assert.equal(blackOnly[0]?.color, "Black");

  logPass("available colors and filtering");
}

async function testHoldAndBookingWithColor(): Promise<void> {
  const vehicle = await createTestVehicle();
  const pickup = baseDate(20);
  const returnAt = baseDate(22);

  await createAdminVehicleUnit(vehicle.id, {
    licensePlate: `RED-${testSuffix}`.slice(0, 20),
    color: "Red",
    status: "AVAILABLE",
    isActive: true,
    notes: null,
  });

  const hold = await createReservationHold({
    vehicleId: vehicle.id,
    pickupDate: pickup.toISOString().slice(0, 10),
    pickupTime: pickup.toISOString().slice(11, 16),
    returnDate: returnAt.toISOString().slice(0, 10),
    returnTime: returnAt.toISOString().slice(11, 16),
    color: "Red",
    customerEmail: TEST_EMAIL,
  });

  const booking = await submitBooking(
    bookingPayload({
      vehicleId: vehicle.id,
      pickup,
      returnAt,
      holdReference: hold.holdReference,
      selectedColor: "Red",
    }),
  );

  const stored = await prisma.booking.findUnique({
    where: { bookingReference: booking.bookingReference },
    select: {
      vehicleColorSnapshot: true,
      vehicleUnitId: true,
      vehicleUnit: { select: { color: true } },
    },
  });
  assert.equal(stored?.vehicleColorSnapshot, "Red");
  assert.equal(stored?.vehicleUnit?.color, "Red");
  assert.ok(stored?.vehicleUnitId);

  logPass("hold and booking with color snapshot");
}

async function testConcurrentColorHold(): Promise<void> {
  const vehicle = await createTestVehicle();
  const pickup = baseDate(30);
  const returnAt = baseDate(32);

  await createAdminVehicleUnit(vehicle.id, {
    licensePlate: `SLV-${testSuffix}`.slice(0, 20),
    color: "Silver",
    status: "AVAILABLE",
    isActive: true,
    notes: null,
  });

  const sessionA = randomBytes(8).toString("hex");
  const sessionB = randomBytes(8).toString("hex");

  await createReservationHold({
    vehicleId: vehicle.id,
    pickupDate: pickup.toISOString().slice(0, 10),
    pickupTime: pickup.toISOString().slice(11, 16),
    returnDate: returnAt.toISOString().slice(0, 10),
    returnTime: returnAt.toISOString().slice(11, 16),
    color: "Silver",
    sessionKey: sessionA,
    customerEmail: TEST_EMAIL,
  });

  const colorsAfterHold = await getAvailableColorsForVehicle({
    vehicleId: vehicle.id,
    requestedStart: pickup,
    requestedEnd: returnAt,
    excludeSessionKey: sessionB,
  });
  assert.equal(colorsAfterHold.some((c) => c.value === "silver"), false);

  await assert.rejects(
    () =>
      createReservationHold({
        vehicleId: vehicle.id,
        pickupDate: pickup.toISOString().slice(0, 10),
        pickupTime: pickup.toISOString().slice(11, 16),
        returnDate: returnAt.toISOString().slice(0, 10),
        returnTime: returnAt.toISOString().slice(11, 16),
        color: "Silver",
        sessionKey: sessionB,
        customerEmail: TEST_EMAIL,
      }),
    (error: unknown) => error instanceof Error && error.name === "ReservationHoldConflictError",
  );

  logPass("concurrent color hold protection");
}

async function testLegacyBookingWithoutColor(): Promise<void> {
  const vehicle = await createTestVehicle();
  const pickup = baseDate(40);
  const returnAt = baseDate(42);

  const unit = await prisma.vehicleUnit.create({
    data: {
      vehicleId: vehicle.id,
      licensePlate: `LEG-${testSuffix}`.slice(0, 20),
      status: "AVAILABLE",
      isActive: true,
      color: null,
    },
  });

  const assigned = await assignAvailableVehicleUnit(
    { vehicleId: vehicle.id, requestedStart: pickup, requestedEnd: returnAt },
    prisma,
  );
  assert.equal(assigned.vehicleUnitId, unit.id);

  const booking = await prisma.booking.create({
    data: {
      bookingReference: `CLR-LEG-${randomBytes(2).toString("hex")}`,
      vehicleId: vehicle.id,
      vehicleUnitId: unit.id,
      vehicleType: "Scooter",
      pickupDateTime: pickup,
      returnDateTime: returnAt,
      actualDurationHours: 48,
      billableDays: 2,
      pickupOption: "OFFICE",
      dropoffOption: "OFFICE",
      customerFullName: "Legacy",
      customerPhone: "+35699000003",
      customerEmail: TEST_EMAIL,
      customerNationality: "Maltese",
      customerDateOfBirth: new Date("1990-01-01"),
      customerLicenseCategory: "B",
      depositMethod: "IN_PERSON",
      vehicleColorSnapshot: null,
    },
  });

  const readBack = await prisma.booking.findUnique({
    where: { id: booking.id },
    select: { vehicleColorSnapshot: true, vehicleUnit: { select: { color: true } } },
  });
  assert.equal(readBack?.vehicleColorSnapshot, null);

  logPass("legacy booking without color");
}

async function main(): Promise<void> {
  assertSafeScriptDatabase("test-vehicle-unit-color-availability");
  await cleanup();
  try {
    await testColorNormalization();
    await testAvailableColorsAndFiltering();
    await testHoldAndBookingWithColor();
    await testConcurrentColorHold();
    await testLegacyBookingWithoutColor();
    console.log("\nAll vehicle unit color tests passed.");
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
