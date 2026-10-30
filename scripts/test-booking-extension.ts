/**
 * Booking extension pricing, eligibility, and inventory safety.
 *
 * Run: npm run test:booking-extension
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import type { BookingStatus } from "../src/generated/prisma/index";
import { calculateBookingExtensionCharge } from "../src/lib/admin/bookings/calculate-booking-extension-charge";
import {
  additionalBillableCalendarDays,
  isSelectableExtensionReturn,
  latestExtensionReturn,
  maltaDateTimeToUtc,
} from "../src/lib/admin/bookings/extension-calendar-days";
import { isExtendableBookingStatus } from "../src/lib/admin/bookings/booking-extension-eligibility";

const TEST_MARKER = "booking-extension-test";
const testSuffix = Date.now().toString(36);

function logPass(name: string): void {
  console.log(`${name} PASS`);
}

function atUtc(day: number, hour = 10): Date {
  return new Date(Date.UTC(2099, 9, day, hour, 0, 0, 0));
}

function runPureTests(): void {
  assert.equal(additionalBillableCalendarDays(atUtc(15, 10), atUtc(15, 16)), 0);
  assert.equal(additionalBillableCalendarDays(atUtc(15, 10), atUtc(18, 10)), 3);
  assert.equal(additionalBillableCalendarDays(atUtc(18, 10), atUtc(15, 10)), null);
  logPass("extra billable days follow inclusive Malta calendar days");

  const sameDay = calculateBookingExtensionCharge({
    additionalBillableDays: 0,
    billableDays: 6,
    rentalCost: 180,
    appliedDailyRateSnapshot: 30,
    hotelDiscountPercentSnapshot: 10,
    cdwDailyRate: 3,
    additionalDriverEnabled: true,
    additionalDriverDailyRate: 5,
    currentVehicleDailyRate: 35,
  });
  assert.equal(sameDay.ok, true);
  if (sameDay.ok) {
    assert.equal(sameDay.charge.additionalAmount, 0);
    assert.equal(sameDay.charge.appliedDailyRate, 30);
  }
  logPass("same-calendar-day later return adds no charge");

  const extension = calculateBookingExtensionCharge({
    additionalBillableDays: 3,
    billableDays: 6,
    rentalCost: 180,
    appliedDailyRateSnapshot: 30,
    hotelDiscountPercentSnapshot: 10,
    cdwDailyRate: 3,
    additionalDriverEnabled: true,
    additionalDriverDailyRate: 5,
    currentVehicleDailyRate: 35,
  });
  assert.equal(extension.ok, true);
  if (extension.ok) {
    assert.equal(extension.charge.appliedDailyRate, 30);
    assert.equal(extension.charge.additionalRentalAmount, 90);
    assert.equal(extension.charge.additionalHotelDiscountAmount, 9);
    assert.equal(extension.charge.additionalCdwAmount, 9);
    assert.equal(extension.charge.additionalDriverAmount, 15);
    assert.equal(extension.charge.additionalAmount, 105);
  }
  logPass("extension uses the original applied rate, not the current vehicle rate");

  const noDriver = calculateBookingExtensionCharge({
    additionalBillableDays: 2,
    billableDays: 4,
    rentalCost: 80,
    appliedDailyRateSnapshot: null,
    hotelDiscountPercentSnapshot: null,
    cdwDailyRate: 0,
    additionalDriverEnabled: false,
    additionalDriverDailyRate: 5,
    currentVehicleDailyRate: 99,
  });
  assert.equal(noDriver.ok, true);
  if (noDriver.ok) {
    assert.equal(noDriver.charge.appliedDailyRate, 20);
    assert.equal(noDriver.charge.additionalRentalAmount, 40);
    assert.equal(noDriver.charge.additionalDriverAmount, 0);
    assert.equal(noDriver.charge.additionalHotelDiscountAmount, 0);
    assert.equal(noDriver.charge.additionalAmount, 40);
  }
  logPass("missing snapshot falls back to stored rental per day and skips one-time extras");

  assert.equal(
    calculateBookingExtensionCharge({
      additionalBillableDays: -1,
      billableDays: 1,
      rentalCost: 30,
      appliedDailyRateSnapshot: 30,
      hotelDiscountPercentSnapshot: null,
      cdwDailyRate: 0,
      additionalDriverEnabled: false,
      additionalDriverDailyRate: 0,
    }).ok,
    false,
  );
  logPass("negative extra days are rejected");

  const blocked: BookingStatus[] = ["PENDING_PAYMENT", "RETURNED", "COMPLETED", "CANCELLED"];
  for (const status of blocked) {
    assert.equal(isExtendableBookingStatus(status), false);
  }
  assert.equal(isExtendableBookingStatus("CONFIRMED"), true);
  assert.equal(isExtendableBookingStatus("VEHICLE_HANDED_OVER"), true);
  logPass("only confirmed and handed-over bookings are extendable");

  const maltaReturn = maltaDateTimeToUtc("2026-10-22", "21:00");
  assert.ok(maltaReturn);
  assert.equal(maltaReturn?.toISOString(), "2026-10-22T19:00:00.000Z");
  const nextLock = maltaDateTimeToUtc("2026-10-25", "10:00");
  assert.ok(nextLock && maltaReturn);
  const latest = latestExtensionReturn(maltaReturn!, [{ pickupAt: nextLock!, returnAt: maltaDateTimeToUtc("2026-10-27", "10:00")! }], maltaDateTimeToUtc("2026-11-16", "21:00")!);
  assert.equal(latest.toISOString(), nextLock!.toISOString());
  assert.equal(isSelectableExtensionReturn("2026-10-23", "21:00", maltaReturn!, latest), true);
  assert.equal(isSelectableExtensionReturn("2026-10-25", "21:00", maltaReturn!, latest), false);
  assert.equal(isSelectableExtensionReturn("2026-10-25", "09:00", maltaReturn!, latest), true);
  assert.equal(isSelectableExtensionReturn("2026-10-22", "21:00", maltaReturn!, latest), false);
  assert.equal(isSelectableExtensionReturn("2026-10-26", "12:00", maltaReturn!, latest), false);
  logPass("calendar days stop at the next lock for this unit and cannot skip it");
}

async function runDatabaseTests(): Promise<void> {
  const { assertSafeScriptDatabase } = await import("./assert-safe-script-database");
  assertSafeScriptDatabase("test-booking-extension");
  const { prisma } = await import("../src/lib/prisma");
  const { extendBooking, previewBookingExtension } = await import("../src/lib/admin/bookings/extendBooking");
  const { insertBookingOccupancy } = await import("../src/lib/vehicle-unit-occupancy");

  const createdBookingIds: string[] = [];
  let vehicleId: string | null = null;
  let adminId: string | null = null;

  async function cleanup(): Promise<void> {
    if (createdBookingIds.length > 0) {
      await prisma.booking.deleteMany({ where: { id: { in: createdBookingIds } } });
    }
    if (vehicleId) {
      await prisma.vehicle.delete({ where: { id: vehicleId } }).catch(() => undefined);
    }
    if (adminId) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  try {
    const admin = await prisma.adminUser.create({
      data: {
        name: "Extension Test",
        email: `extension-${testSuffix}@test.local`,
        passwordHash: "test-only",
        role: "STAFF",
      },
    });
    adminId = admin.id;

    const slug = `extension-test-${testSuffix}-${randomBytes(3).toString("hex")}`;
    const vehicle = await prisma.vehicle.create({
      data: {
        name: `Extension Test Scooter ${slug}`,
        slug,
        vehicleType: "Scooter",
        baseDailyRate: 35,
        isActive: true,
        units: {
          create: [
            {
              licensePlate: `EXT${randomBytes(4).toString("hex").toUpperCase()}`,
              status: "OUT_WITH_CUSTOMER",
              isActive: true,
            },
            {
              licensePlate: `EXB${randomBytes(4).toString("hex").toUpperCase()}`,
              status: "AVAILABLE",
              isActive: true,
            },
          ],
        },
      },
      include: { units: { orderBy: { createdAt: "asc" } } },
    });
    vehicleId = vehicle.id;
    const [primaryUnit, otherUnit] = vehicle.units;
    if (!primaryUnit || !otherUnit) {
      throw new Error("Expected two test units");
    }

    async function createBooking(input: {
      unitId: string;
      licensePlate: string;
      pickup: Date;
      returnAt: Date;
      status?: BookingStatus;
      billableDays?: number;
      withOccupancy?: boolean;
    }): Promise<{ id: string; updatedAt: Date }> {
      const booking = await prisma.booking.create({
        data: {
          bookingReference: `EXT-${randomBytes(4).toString("hex").toUpperCase()}`,
          status: input.status ?? "VEHICLE_HANDED_OVER",
          vehicleId: vehicle.id,
          vehicleUnitId: input.unitId,
          vehicleNameSnapshot: "Extension Test Scooter",
          vehicleLicensePlateSnapshot: input.licensePlate,
          vehicleType: "Scooter",
          vehicleTypeSnapshot: "Scooter",
          pickupDateTime: input.pickup,
          returnDateTime: input.returnAt,
          actualDurationHours: 120,
          billableDays: input.billableDays ?? 6,
          pickupOption: "OFFICE",
          dropoffOption: "OFFICE",
          customerFullName: "Extension Customer",
          customerPhone: "+35699000022",
          customerEmail: `extension-${testSuffix}@test.local`,
          customerNationality: "Maltese",
          customerDateOfBirth: new Date("1990-01-01"),
          customerLicenseCategory: "B",
          customerSpecialNotes: TEST_MARKER,
          depositMethod: "IN_PERSON",
          depositAmount: 250,
          baseDailyRateSnapshot: 30,
          appliedDailyRateSnapshot: 30,
          durationDiscountPercentSnapshot: 0,
          rentalCost: 180,
          cdwDailyRate: 3,
          cdwTotal: 18,
          additionalDriverEnabled: true,
          additionalDriverDailyRate: 5,
          additionalDriverTotal: 30,
          hotelDiscountPercentSnapshot: 10,
          hotelDiscountAmountSnapshot: 18,
          subtotalAfterHotelDiscountSnapshot: 162,
          deliveryFee: 20,
          deliveryTotal: 20,
          storageBoxSelected: true,
          storageBoxCost: 10,
          subtotal: 240,
          totalDueOnline: 240,
          totalDueLater: 250,
        },
      });
      createdBookingIds.push(booking.id);
      if (input.withOccupancy !== false && (input.status ?? "VEHICLE_HANDED_OVER") !== "CANCELLED") {
        const blocking = ["PENDING_PAYMENT", "CONFIRMED", "VEHICLE_HANDED_OVER", "RETURNED"];
        if (blocking.includes(input.status ?? "VEHICLE_HANDED_OVER")) {
          await insertBookingOccupancy(prisma, {
            vehicleUnitId: input.unitId,
            pickupAt: input.pickup,
            returnAt: input.returnAt,
            bookingId: booking.id,
          });
        }
      }
      return { id: booking.id, updatedAt: booking.updatedAt };
    }

    const neighbor = await createBooking({
      unitId: primaryUnit.id,
      licensePlate: primaryUnit.licensePlate,
      pickup: atUtc(18),
      returnAt: atUtc(20),
      status: "CONFIRMED",
      billableDays: 3,
    });

    const active = await createBooking({
      unitId: primaryUnit.id,
      licensePlate: primaryUnit.licensePlate,
      pickup: atUtc(10),
      returnAt: atUtc(15),
      status: "VEHICLE_HANDED_OVER",
    });

    const touching = await previewBookingExtension(active.id, atUtc(18));
    assert.equal(touching.ok, true);
    if (touching.ok) {
      assert.equal(touching.preview.available, true);
      assert.equal(touching.preview.additionalBillableDays, 3);
      assert.equal(touching.preview.additionalAmount, 105);
      assert.equal(touching.preview.appliedDailyRate, 30);
    }
    logPass("preview excludes the current booking and allows a return that only touches the next booking");

    const overlapPreview = await previewBookingExtension(active.id, atUtc(19));
    assert.equal(overlapPreview.ok, true);
    if (overlapPreview.ok) {
      assert.equal(overlapPreview.preview.available, false);
      assert.ok(overlapPreview.preview.conflict);
    }
    const beforeOverlapAttempt = await prisma.booking.findUniqueOrThrow({ where: { id: active.id } });
    const rejected = await extendBooking(active.id, atUtc(19), admin.id, beforeOverlapAttempt.updatedAt);
    assert.equal(rejected.ok, false);
    if (!rejected.ok) {
      assert.equal(rejected.reason, "unit_conflict");
    }
    const afterReject = await prisma.booking.findUniqueOrThrow({
      where: { id: active.id },
      include: { extensions: true, unitOccupancies: true },
    });
    assert.equal(afterReject.returnDateTime.toISOString(), atUtc(15).toISOString());
    assert.equal(afterReject.subtotal.toNumber(), 240);
    assert.equal(afterReject.extensions.length, 0);
    assert.equal(afterReject.unitOccupancies[0]?.returnAt.toISOString(), atUtc(15).toISOString());
    logPass("conflicting extension is rejected and leaves the booking unchanged");

    const extended = await extendBooking(active.id, atUtc(18), admin.id, afterReject.updatedAt);
    assert.equal(extended.ok, true);
    const saved = await prisma.booking.findUniqueOrThrow({
      where: { id: active.id },
      include: { extensions: true, unitOccupancies: true },
    });
    assert.equal(saved.returnDateTime.toISOString(), atUtc(18).toISOString());
    assert.equal(saved.billableDays, 9);
    assert.equal(saved.rentalCost.toNumber(), 270);
    assert.equal(saved.cdwTotal.toNumber(), 27);
    assert.equal(saved.additionalDriverTotal.toNumber(), 45);
    assert.equal(saved.hotelDiscountAmountSnapshot?.toNumber(), 27);
    assert.equal(saved.subtotalAfterHotelDiscountSnapshot?.toNumber(), 243);
    assert.equal(saved.subtotal.toNumber(), 345);
    assert.equal(saved.deliveryTotal.toNumber(), 20);
    assert.equal(saved.storageBoxCost.toNumber(), 10);
    assert.equal(saved.depositAmount.toNumber(), 250);
    assert.equal(saved.totalDueOnline.toNumber(), 240);
    assert.equal(saved.totalDueLater.toNumber(), 250);
    assert.equal(saved.extensions.length, 1);
    assert.equal(saved.extensions[0]?.additionalAmount.toNumber(), 105);
    assert.equal(saved.extensions[0]?.appliedDailyRate.toNumber(), 30);
    assert.equal(saved.extensions[0]?.createdByAdminId, admin.id);
    assert.equal(saved.unitOccupancies[0]?.returnAt.toISOString(), atUtc(18).toISOString());
    assert.equal(saved.vehicleUnitId, primaryUnit.id);
    logPass("successful extension updates dates, original-rate totals, occupancy, and audit row");

    const raced = await extendBooking(active.id, atUtc(18, 12), admin.id, afterReject.updatedAt);
    assert.equal(raced.ok, false);
    if (!raced.ok) {
      assert.equal(raced.reason, "concurrent_update");
    }
    const afterRace = await prisma.booking.findUniqueOrThrow({ where: { id: active.id } });
    assert.equal(afterRace.returnDateTime.toISOString(), atUtc(18).toISOString());
    logPass("stale expectedUpdatedAt is rejected and does not apply a second extension");

    const notLater = await extendBooking(active.id, atUtc(18), admin.id, afterRace.updatedAt);
    assert.equal(notLater.ok, false);
    if (!notLater.ok) {
      assert.equal(notLater.reason, "invalid_return");
    }
    logPass("a new return that is not later than the current return is rejected");

    for (const status of ["RETURNED", "COMPLETED", "CANCELLED", "PENDING_PAYMENT"] as const) {
      const blockedBooking = await createBooking({
        unitId: otherUnit.id,
        licensePlate: otherUnit.licensePlate,
        pickup: atUtc(10),
        returnAt: atUtc(12),
        status,
        billableDays: 3,
        withOccupancy: false,
      });
      const blockedResult = await extendBooking(blockedBooking.id, atUtc(14), admin.id, blockedBooking.updatedAt);
      assert.equal(blockedResult.ok, false);
      if (!blockedResult.ok) {
        assert.equal(blockedResult.reason, "invalid_status");
      }
      const unchanged = await prisma.booking.findUniqueOrThrow({
        where: { id: blockedBooking.id },
        include: { extensions: true },
      });
      assert.equal(unchanged.returnDateTime.toISOString(), atUtc(12).toISOString());
      assert.equal(unchanged.extensions.length, 0);
    }
    logPass("returned, completed, cancelled, and unpaid bookings cannot be extended");

    assert.ok(neighbor.id);
  } finally {
    await cleanup();
  }
}

async function main(): Promise<void> {
  runPureTests();
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL is not set; skipped database extension tests");
    return;
  }
  await runDatabaseTests();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
