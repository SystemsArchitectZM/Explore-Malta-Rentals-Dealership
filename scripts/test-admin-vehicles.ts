import "dotenv/config";
import assert from "node:assert/strict";

import { createAdminVehicleUnit } from "../src/lib/admin/vehicle-units/mutateAdminVehicleUnit";
import { deleteAdminVehicle } from "../src/lib/admin/vehicles/mutateAdminVehicle";
import { getAdminVehicleById } from "../src/lib/admin/vehicles/listAdminVehicles";
import { adminVehicleWriteSchema } from "../src/lib/admin/vehicles/vehicle-schema";
import { prisma } from "../src/lib/prisma";
import { assertSafeScriptDatabase } from "./assert-safe-script-database";

const basePayload = {
  name: "Vehicle Listing Test",
  slug: `vehicle-listing-test-${Date.now()}`,
  vehicleType: "Scooter" as const,
  engineCc: 50,
  brand: null,
  model: null,
  shortDescription: null,
  description: null,
  mainImageUrl: null,
  catalogStatus: "AVAILABLE" as const,
  isActive: true,
  displayOrder: 0,
  helmetIncludedCount: 2,
  supportsStorageBox: false,
  images: [],
  baseDailyRate: 25,
};

async function run() {
  assertSafeScriptDatabase("test-admin-vehicles");
  const parsed = adminVehicleWriteSchema.safeParse(basePayload);
  assert.equal(parsed.success, true, "valid payload should pass schema without license plate");

  const vehicle = await prisma.vehicle.create({
    data: {
      name: basePayload.name,
      slug: basePayload.slug,
      vehicleType: basePayload.vehicleType,
      baseDailyRate: 25,
      catalogStatus: basePayload.catalogStatus,
      isActive: true,
    },
  });

  try {
    const loaded = await getAdminVehicleById(vehicle.id);
    assert.ok(loaded);
    assert.equal(loaded.totalUnits, 0);
    assert.equal(loaded.availableUnits, 0);
    assert.equal(loaded.canDelete, true);

    const unit = await createAdminVehicleUnit(vehicle.id, {
      licensePlate: "TST-9001",
      color: "Black",
      status: "AVAILABLE",
      isActive: true,
      notes: null,
    });
    assert.ok(unit);
    assert.equal(unit.licensePlate, "TST-9001");

    const withUnit = await getAdminVehicleById(vehicle.id);
    assert.ok(withUnit);
    assert.equal(withUnit.totalUnits, 1);
    assert.equal(withUnit.availableUnits, 1);

    try {
      await createAdminVehicleUnit(vehicle.id, {
        licensePlate: "TST-9001",
        color: "Black",
        status: "AVAILABLE",
        isActive: true,
        notes: null,
      });
      assert.fail("duplicate license plate should throw");
    } catch (error) {
      assert.ok(error instanceof Error);
    }

    const deleteResult = await deleteAdminVehicle(vehicle.id);
    assert.equal(deleteResult.ok, true);
    assert.equal(await getAdminVehicleById(vehicle.id), null);
  } finally {
    await prisma.vehicleUnit.deleteMany({ where: { vehicleId: vehicle.id } }).catch(() => undefined);
    await prisma.vehicle.deleteMany({ where: { slug: { startsWith: basePayload.slug } } }).catch(() => undefined);
  }

  const expiredHoldVehicle = await prisma.vehicle.create({
    data: {
      name: "Expired Hold Guard Test Vehicle",
      slug: `expired-hold-guard-test-${Date.now()}`,
      vehicleType: "Scooter",
      baseDailyRate: 25,
      catalogStatus: "AVAILABLE",
      isActive: true,
      reservationHolds: {
        create: [
          {
            holdReference: `HLD-TEST-EXP-${Date.now()}-1`,
            vehicleType: "Scooter",
            sessionKey: "test-session",
            pickupDateTime: new Date("2026-07-01T10:00:00.000Z"),
            returnDateTime: new Date("2026-07-02T10:00:00.000Z"),
            status: "EXPIRED",
            expiresAt: new Date("2026-06-01T10:00:00.000Z"),
          },
          {
            holdReference: `HLD-TEST-EXP-${Date.now()}-2`,
            vehicleType: "Scooter",
            sessionKey: "test-session",
            pickupDateTime: new Date("2026-07-03T10:00:00.000Z"),
            returnDateTime: new Date("2026-07-04T10:00:00.000Z"),
            status: "RELEASED",
            expiresAt: new Date("2026-06-02T10:00:00.000Z"),
          },
        ],
      },
    },
  });

  try {
    const loadedExpiredHoldVehicle = await getAdminVehicleById(expiredHoldVehicle.id);
    assert.ok(loadedExpiredHoldVehicle);
    assert.equal(loadedExpiredHoldVehicle.reservationHoldCount, 0);
    assert.equal(loadedExpiredHoldVehicle.canDelete, true);

    const deleteResult = await deleteAdminVehicle(expiredHoldVehicle.id);
    assert.equal(deleteResult.ok, true);
    assert.equal(await getAdminVehicleById(expiredHoldVehicle.id), null);
  } finally {
    await prisma.reservationHold.deleteMany({ where: { vehicleId: expiredHoldVehicle.id } }).catch(() => undefined);
    await prisma.vehicle.deleteMany({ where: { id: expiredHoldVehicle.id } }).catch(() => undefined);
  }

  const bookedVehicle = await prisma.vehicle.create({
    data: {
      name: "Booked Guard Test Vehicle",
      slug: `booked-guard-test-${Date.now()}`,
      vehicleType: "Scooter",
      baseDailyRate: 25,
      catalogStatus: "AVAILABLE",
      isActive: true,
      units: {
        create: {
          licensePlate: `BKD-${Date.now()}`,
          status: "AVAILABLE",
          isActive: true,
        },
      },
      bookings: {
        create: {
          bookingReference: `TEST-${Date.now()}`,
          status: "CONFIRMED",
          vehicleType: "Scooter",
          pickupDateTime: new Date("2026-07-01T10:00:00.000Z"),
          returnDateTime: new Date("2026-07-02T10:00:00.000Z"),
          actualDurationHours: 24,
          billableDays: 1,
          pickupOption: "OFFICE",
          dropoffOption: "OFFICE",
          customerFullName: "Test User",
          customerPhone: "+35600000000",
          customerEmail: "test@example.com",
          customerNationality: "Malta",
          customerDateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
          customerLicenseCategory: "B",
          depositMethod: "IN_PERSON",
        },
      },
    },
    include: { bookings: true, units: true },
  });

  try {
    const loadedBooked = await getAdminVehicleById(bookedVehicle.id);
    assert.ok(loadedBooked);
    assert.equal(loadedBooked.canDelete, false);

    const blockedDelete = await deleteAdminVehicle(bookedVehicle.id);
    assert.equal(blockedDelete.ok, false);
    if (!blockedDelete.ok) {
      assert.equal(blockedDelete.reason, "has_related_records");
    }
  } finally {
    await prisma.booking.deleteMany({ where: { vehicleId: bookedVehicle.id } });
    await prisma.vehicleUnit.deleteMany({ where: { vehicleId: bookedVehicle.id } });
    await prisma.vehicle.delete({ where: { id: bookedVehicle.id } });
  }

  const cancelledBookingReference = `TEST-CXL-${Date.now()}`;
  const cancelledVehicle = await prisma.vehicle.create({
    data: {
      name: "Cancelled Booking Guard Test Vehicle",
      slug: `cancelled-booking-guard-test-${Date.now()}`,
      vehicleType: "Scooter",
      baseDailyRate: 25,
      catalogStatus: "AVAILABLE",
      isActive: true,
      units: {
        create: {
          licensePlate: `CXL-${Date.now()}`,
          status: "AVAILABLE",
          isActive: true,
        },
      },
      bookings: {
        create: {
          bookingReference: cancelledBookingReference,
          status: "CANCELLED",
          vehicleType: "Scooter",
          pickupDateTime: new Date("2026-07-01T10:00:00.000Z"),
          returnDateTime: new Date("2026-07-02T10:00:00.000Z"),
          actualDurationHours: 24,
          billableDays: 1,
          pickupOption: "OFFICE",
          dropoffOption: "OFFICE",
          customerFullName: "Test User",
          customerPhone: "+35600000000",
          customerEmail: "test@example.com",
          customerNationality: "Malta",
          customerDateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
          customerLicenseCategory: "B",
          depositMethod: "IN_PERSON",
        },
      },
    },
  });

  try {
    const loadedCancelled = await getAdminVehicleById(cancelledVehicle.id);
    assert.ok(loadedCancelled);
    assert.equal(loadedCancelled.bookingCount, 0);
    assert.equal(loadedCancelled.canDelete, true);

    const deleteResult = await deleteAdminVehicle(cancelledVehicle.id);
    assert.equal(deleteResult.ok, true);
    assert.equal(await getAdminVehicleById(cancelledVehicle.id), null);

    const preservedBooking = await prisma.booking.findUnique({
      where: { bookingReference: cancelledBookingReference },
      select: { vehicleId: true, vehicleUnitId: true, status: true },
    });
    assert.ok(preservedBooking);
    assert.equal(preservedBooking.status, "CANCELLED");
    assert.equal(preservedBooking.vehicleId, null);
    assert.equal(preservedBooking.vehicleUnitId, null);
  } finally {
    await prisma.booking.deleteMany({ where: { bookingReference: cancelledBookingReference } });
    await prisma.vehicleUnit.deleteMany({ where: { vehicleId: cancelledVehicle.id } }).catch(() => undefined);
    await prisma.vehicle.deleteMany({ where: { id: cancelledVehicle.id } }).catch(() => undefined);
  }

  console.log("Admin vehicle listing + unit checks passed.");
}

run()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
