/**
 * Replace the physical vehicle on a handed-over booking.
 *
 * Run: npm run test:replace-booking-vehicle
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import type { BookingStatus, Prisma, VehicleUnitStatus } from "../src/generated/prisma/index";
import { isVehicleReplacementBookingStatus } from "../src/lib/admin/bookings/vehicle-replacement-eligibility";
import { assertSafeScriptDatabase } from "./assert-safe-script-database";

const testSuffix = Date.now().toString(36);

function logPass(name: string): void {
  console.log(`${name} PASS`);
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function runPureTests(): void {
  assert.equal(isVehicleReplacementBookingStatus("VEHICLE_HANDED_OVER"), true);
  assert.equal(isVehicleReplacementBookingStatus("CONFIRMED"), false);
  assert.equal(isVehicleReplacementBookingStatus("PENDING_PAYMENT"), false);
  assert.equal(isVehicleReplacementBookingStatus("RETURNED"), false);
  assert.equal(isVehicleReplacementBookingStatus("COMPLETED"), false);
  assert.equal(isVehicleReplacementBookingStatus("CANCELLED"), false);
  logPass("vehicle replacement is limited to a handed-over rental");
}

type MoneySnap = {
  rentalCost: number;
  subtotal: number;
  totalDueOnline: number;
  totalDueLater: number;
  depositAmount: number;
  cdwTotal: number;
  additionalDriverTotal: number;
  deliveryTotal: number;
  storageBoxCost: number;
  baseDailyRate: number | null;
  appliedDailyRate: number | null;
  billableDays: number;
  pickup: string;
  returnAt: string;
};

function moneyOf(booking: {
  rentalCost: Prisma.Decimal;
  subtotal: Prisma.Decimal;
  totalDueOnline: Prisma.Decimal;
  totalDueLater: Prisma.Decimal;
  depositAmount: Prisma.Decimal;
  cdwTotal: Prisma.Decimal;
  additionalDriverTotal: Prisma.Decimal;
  deliveryTotal: Prisma.Decimal;
  storageBoxCost: Prisma.Decimal;
  baseDailyRateSnapshot: Prisma.Decimal | null;
  appliedDailyRateSnapshot: Prisma.Decimal | null;
  billableDays: number;
  pickupDateTime: Date;
  returnDateTime: Date;
}): MoneySnap {
  return {
    rentalCost: booking.rentalCost.toNumber(),
    subtotal: booking.subtotal.toNumber(),
    totalDueOnline: booking.totalDueOnline.toNumber(),
    totalDueLater: booking.totalDueLater.toNumber(),
    depositAmount: booking.depositAmount.toNumber(),
    cdwTotal: booking.cdwTotal.toNumber(),
    additionalDriverTotal: booking.additionalDriverTotal.toNumber(),
    deliveryTotal: booking.deliveryTotal.toNumber(),
    storageBoxCost: booking.storageBoxCost.toNumber(),
    baseDailyRate: booking.baseDailyRateSnapshot?.toNumber() ?? null,
    appliedDailyRate: booking.appliedDailyRateSnapshot?.toNumber() ?? null,
    billableDays: booking.billableDays,
    pickup: booking.pickupDateTime.toISOString(),
    returnAt: booking.returnDateTime.toISOString(),
  };
}

async function runDatabaseTests(): Promise<void> {
  assertSafeScriptDatabase("test-replace-booking-vehicle");
  const { prisma } = await import("../src/lib/prisma");
  const { extendBooking } = await import("../src/lib/admin/bookings/extendBooking");
  const { changeBookingVehicle } = await import("../src/lib/admin/bookings/changeBookingVehicle");
  const { completeBooking } = await import("../src/lib/admin/bookings/lifecycle/completeBooking");
  const { markVehicleReturned } = await import("../src/lib/admin/bookings/lifecycle/markVehicleReturned");
  const {
    listReplaceBookingVehicleOptions,
    replaceBookingVehicle,
  } = await import("../src/lib/admin/bookings/replaceBookingVehicle");
  const { insertBookingOccupancy } = await import("../src/lib/vehicle-unit-occupancy");
  const { findAvailableVehicleUnits } = await import("../src/lib/vehicle-units/findAvailableVehicleUnits");

  const vehicleIds: string[] = [];
  const bookingIds: string[] = [];
  let adminId: string | null = null;

  async function cleanup(): Promise<void> {
    if (bookingIds.length > 0) {
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    if (vehicleIds.length > 0) {
      await prisma.availabilityBlock.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
      await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    }
    if (adminId) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  function plate(): string {
    return `RP${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 16);
  }

  async function createVehicle(input: {
    name: string;
    vehicleType?: "Scooter" | "Motorcycle";
    engineCc?: number | null;
    baseDailyRate: number;
    supportsStorageBox?: boolean;
    units: Array<{ color: string | null; status: VehicleUnitStatus }>;
  }) {
    const vehicle = await prisma.vehicle.create({
      data: {
        name: input.name,
        slug: `replace-vehicle-${testSuffix}-${randomBytes(3).toString("hex")}`,
        brand: input.name.split(" ")[0] ?? "Brand",
        model: input.name,
        vehicleType: input.vehicleType ?? "Scooter",
        engineCc: input.engineCc === undefined ? 50 : input.engineCc,
        baseDailyRate: input.baseDailyRate,
        isActive: true,
        catalogStatus: "AVAILABLE",
        supportsStorageBox: input.supportsStorageBox ?? true,
        units: {
          create: input.units.map((unit) => ({
            licensePlate: plate(),
            color: unit.color,
            status: unit.status,
            isActive: true,
          })),
        },
      },
      include: { units: { orderBy: { createdAt: "asc" } } },
    });
    vehicleIds.push(vehicle.id);
    return vehicle;
  }

  async function createBooking(input: {
    vehicleId: string;
    unitId: string;
    plate: string;
    color: string | null;
    name: string;
    pickup: Date;
    returnAt: Date;
    status?: BookingStatus;
    unitStatus?: VehicleUnitStatus;
    storageBoxSelected?: boolean;
    withOccupancy?: boolean;
    billableDays?: number;
    actualDurationHours?: number;
  }) {
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `RPL-${randomBytes(4).toString("hex").toUpperCase()}`,
        status: input.status ?? "VEHICLE_HANDED_OVER",
        vehicleId: input.vehicleId,
        vehicleUnitId: input.unitId,
        vehicleNameSnapshot: input.name,
        vehicleLicensePlateSnapshot: input.plate,
        vehicleColorSnapshot: input.color,
        vehicleType: "Scooter",
        vehicleTypeSnapshot: "Scooter",
        pickupDateTime: input.pickup,
        returnDateTime: input.returnAt,
        handoverDateTime: input.pickup,
        actualDurationHours: input.actualDurationHours ?? 72,
        billableDays: input.billableDays ?? 4,
        pickupOption: "OFFICE",
        dropoffOption: "OFFICE",
        customerFullName: "Replace Vehicle Customer",
        customerPhone: "+35699000066",
        customerEmail: `replace-vehicle-${testSuffix}@test.local`,
        customerNationality: "Maltese",
        customerDateOfBirth: new Date("1990-01-01"),
        customerLicenseCategory: "B",
        depositMethod: "IN_PERSON",
        depositAmount: 250,
        baseDailyRateSnapshot: 30,
        appliedDailyRateSnapshot: 30,
        durationDiscountPercentSnapshot: 0,
        rentalCost: 120,
        cdwDailyRate: 3,
        cdwTotal: 12,
        additionalDriverEnabled: true,
        additionalDriverDailyRate: 5,
        additionalDriverTotal: 20,
        hotelDiscountPercentSnapshot: 10,
        hotelDiscountAmountSnapshot: 12,
        subtotalAfterHotelDiscountSnapshot: 108,
        deliveryFee: 15,
        deliveryTotal: 15,
        storageBoxSelected: input.storageBoxSelected ?? false,
        storageBoxCost: input.storageBoxSelected ? 10 : 0,
        subtotal: 175,
        totalDueOnline: 175,
        totalDueLater: 250,
      },
    });
    bookingIds.push(booking.id);
    if (input.unitStatus) {
      await prisma.vehicleUnit.update({
        where: { id: input.unitId },
        data: { status: input.unitStatus },
      });
    }
    if (input.withOccupancy !== false) {
      await insertBookingOccupancy(prisma, {
        vehicleUnitId: input.unitId,
        pickupAt: input.pickup,
        returnAt: input.returnAt,
        bookingId: booking.id,
      });
    }
    return booking;
  }

  function replacementInput(
    booking: { updatedAt: Date; vehicleUnitId: string | null },
    vehicleUnitId: string,
    previousUnitStatus: "AVAILABLE" | "MAINTENANCE" | "NOT_AVAILABLE" = "MAINTENANCE",
  ) {
    return {
      vehicleUnitId,
      previousUnitStatus,
      reason: "mechanical_issue" as const,
      note: "Engine warning",
      expectedUpdatedAt: booking.updatedAt,
      expectedVehicleUnitId: booking.vehicleUnitId ?? "",
    };
  }

  try {
    runPureTests();

    const admin = await prisma.adminUser.create({
      data: {
        name: "Replace Vehicle Test",
        email: `replace-vehicle-${testSuffix}@test.local`,
        role: "STAFF",
      },
    });
    adminId = admin.id;

    const nmax = await createVehicle({
      name: `Yamaha NMAX ${testSuffix}`,
      baseDailyRate: 30,
      units: [
        { color: "Red", status: "OUT_WITH_CUSTOMER" },
        { color: "Black", status: "AVAILABLE" },
        { color: "White", status: "AVAILABLE" },
        { color: "Grey", status: "AVAILABLE" },
      ],
    });
    const pcx = await createVehicle({
      name: `Honda PCX ${testSuffix}`,
      baseDailyRate: 45,
      units: [
        { color: "Blue", status: "AVAILABLE" },
        { color: "Grey", status: "MAINTENANCE" },
      ],
    });
    const motorcycle = await createVehicle({
      name: `Licence Bike ${testSuffix}`,
      vehicleType: "Motorcycle",
      engineCc: 125,
      baseDailyRate: 60,
      units: [{ color: "Black", status: "AVAILABLE" }],
    });
    const noBox = await createVehicle({
      name: `No Box ${testSuffix}`,
      baseDailyRate: 25,
      supportsStorageBox: false,
      units: [{ color: "Green", status: "AVAILABLE" }],
    });
    const busy = await createVehicle({
      name: `Busy Bike ${testSuffix}`,
      baseDailyRate: 33,
      units: [{ color: "Silver", status: "AVAILABLE" }],
    });
    const pastUsed = await createVehicle({
      name: `Past Used ${testSuffix}`,
      baseDailyRate: 32,
      units: [{ color: "Yellow", status: "AVAILABLE" }],
    });
    const blockedModel = await createVehicle({
      name: `Blocked Model ${testSuffix}`,
      baseDailyRate: 31,
      units: [{ color: "Orange", status: "AVAILABLE" }],
    });

    const currentUnit = nmax.units[0];
    const sameModelUnit = nmax.units[1];
    const secondNmax = nmax.units[2];
    const extensionUnit = nmax.units[3];
    const pcxUnit = pcx.units[0];
    const pcxMaintenance = pcx.units[1];
    const motorcycleUnit = motorcycle.units[0];
    const noBoxUnit = noBox.units[0];
    const busyUnit = busy.units[0];
    const pastUnit = pastUsed.units[0];
    const blockedUnit = blockedModel.units[0];
    if (
      !currentUnit ||
      !sameModelUnit ||
      !secondNmax ||
      !extensionUnit ||
      !pcxUnit ||
      !pcxMaintenance ||
      !motorcycleUnit ||
      !noBoxUnit ||
      !busyUnit ||
      !pastUnit ||
      !blockedUnit
    ) {
      throw new Error("Expected test units");
    }

    const pickup = hoursFromNow(-48);
    const returnAt = hoursFromNow(96);
    const active = await createBooking({
      vehicleId: nmax.id,
      unitId: currentUnit.id,
      plate: currentUnit.licensePlate,
      color: "Red",
      name: nmax.name,
      pickup,
      returnAt,
      unitStatus: "OUT_WITH_CUSTOMER",
    });
    const futureConflict = await createBooking({
      vehicleId: busy.id,
      unitId: busyUnit.id,
      plate: busyUnit.licensePlate,
      color: "Silver",
      name: busy.name,
      pickup: hoursFromNow(24),
      returnAt: hoursFromNow(72),
      status: "CONFIRMED",
      unitStatus: "RESERVED",
    });
    const pastBooking = await createBooking({
      vehicleId: pastUsed.id,
      unitId: pastUnit.id,
      plate: pastUnit.licensePlate,
      color: "Yellow",
      name: pastUsed.name,
      pickup: hoursFromNow(-120),
      returnAt: hoursFromNow(-2),
      status: "CONFIRMED",
      unitStatus: "AVAILABLE",
    });
    await prisma.availabilityBlock.create({
      data: {
        vehicleId: blockedModel.id,
        blockType: "MANUAL_BLOCK",
        startDateTime: hoursFromNow(-1),
        endDateTime: hoursFromNow(200),
        reason: "Workshop",
      },
    });

    const options = await listReplaceBookingVehicleOptions(active.id);
    assert.equal(options.ok, true);
    if (options.ok) {
      const ids = options.options.units.map((unit) => unit.id);
      assert.equal(ids.includes(currentUnit.id), false);
      assert.equal(ids.includes(sameModelUnit.id), true);
      assert.equal(ids.includes(pcxUnit.id), true);
      assert.equal(ids.includes(pcxMaintenance.id), false);
      assert.equal(ids.includes(motorcycleUnit.id), false);
      assert.equal(ids.includes(busyUnit.id), false);
      assert.equal(ids.includes(pastUnit.id), true);
      assert.equal(ids.includes(blockedUnit.id), false);
      assert.equal(options.options.priceUnchanged, true);
      assert.equal(options.options.subtotal, 175);
    }
    logPass("options list specific free units for the remaining rental and hide the current bike");
    assert.equal(futureConflict.id.length > 0 && pastBooking.id.length > 0, true);

    const confirmed = await createBooking({
      vehicleId: nmax.id,
      unitId: secondNmax.id,
      plate: secondNmax.licensePlate,
      color: "White",
      name: nmax.name,
      pickup: hoursFromNow(200),
      returnAt: hoursFromNow(260),
      status: "CONFIRMED",
      unitStatus: "RESERVED",
    });
    const tooEarly = await replaceBookingVehicle(
      confirmed.id,
      replacementInput(confirmed, pcxUnit.id),
      admin.id,
    );
    assert.equal(tooEarly.ok, false);
    if (!tooEarly.ok) assert.equal(tooEarly.reason, "invalid_status");
    logPass("a booking that has not been handed over cannot use replacement");

    const point5 = await changeBookingVehicle(
      active.id,
      pcx.id,
      "Blue",
      "keep_existing",
      admin.id,
      active.updatedAt,
    );
    assert.equal(point5.ok, false);
    if (!point5.ok) assert.equal(point5.reason, "invalid_status");
    logPass("pre-handover vehicle change still refuses a handed-over booking");

    const same = await replaceBookingVehicle(active.id, replacementInput(active, currentUnit.id), admin.id);
    assert.equal(same.ok, false);
    if (!same.ok) assert.equal(same.reason, "same_unit");
    logPass("the bike already with the customer cannot replace itself");

    const licence = await replaceBookingVehicle(
      active.id,
      replacementInput(active, motorcycleUnit.id),
      admin.id,
    );
    assert.equal(licence.ok, false);
    if (!licence.ok) assert.equal(licence.reason, "incompatible_license");
    logPass("a replacement the customer is not licensed to ride is rejected");

    const storageBooking = await createBooking({
      vehicleId: nmax.id,
      unitId: sameModelUnit.id,
      plate: sameModelUnit.licensePlate,
      color: "Black",
      name: nmax.name,
      pickup: hoursFromNow(-10),
      returnAt: hoursFromNow(30),
      storageBoxSelected: true,
      unitStatus: "OUT_WITH_CUSTOMER",
    });
    const storage = await replaceBookingVehicle(
      storageBooking.id,
      replacementInput(storageBooking, noBoxUnit.id),
      admin.id,
    );
    assert.equal(storage.ok, false);
    if (!storage.ok) assert.equal(storage.reason, "incompatible_storage");
    const storageSaved = await prisma.booking.findUniqueOrThrow({ where: { id: storageBooking.id } });
    assert.equal(storageSaved.vehicleUnitId, sameModelUnit.id);
    logPass("a storage-box booking cannot move to a model that does not support one");

    const beforeConflict = await prisma.booking.findUniqueOrThrow({ where: { id: active.id } });
    const unavailable = await replaceBookingVehicle(
      active.id,
      replacementInput(beforeConflict, busyUnit.id),
      admin.id,
    );
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.reason, "no_availability");
    const afterUnavailable = await prisma.booking.findUniqueOrThrow({
      where: { id: active.id },
      include: { unitOccupancies: true },
    });
    assert.equal(afterUnavailable.vehicleUnitId, currentUnit.id);
    assert.equal(afterUnavailable.unitOccupancies.length, 1);
    assert.equal(afterUnavailable.unitOccupancies[0]?.returnAt.toISOString(), returnAt.toISOString());
    logPass("a unit booked during the remaining rental is rejected and the original assignment stays");

    const blocked = await replaceBookingVehicle(
      active.id,
      replacementInput(afterUnavailable, blockedUnit.id),
      admin.id,
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "no_availability");
    logPass("a vehicle-level block prevents replacement even when the unit looks free");

    const beforeSameModel = await prisma.booking.findUniqueOrThrow({ where: { id: active.id } });
    const beforeMoney = moneyOf(beforeSameModel);
    const stripeBefore = await prisma.stripePayment.count({ where: { bookingId: active.id } });
    const sameModel = await replaceBookingVehicle(
      active.id,
      replacementInput(beforeSameModel, pastUnit.id, "MAINTENANCE"),
      admin.id,
    );
    assert.equal(sameModel.ok, true);
    const sameSaved = await prisma.booking.findUniqueOrThrow({
      where: { id: active.id },
      include: {
        unitOccupancies: true,
        vehicleAssignments: { orderBy: { startedAt: "asc" } },
        statusHistory: true,
      },
    });
    assert.equal(sameSaved.id, active.id);
    assert.equal(sameSaved.vehicleId, pastUsed.id);
    assert.equal(sameSaved.vehicleUnitId, pastUnit.id);
    assert.equal(sameSaved.vehicleNameSnapshot, pastUsed.name);
    assert.equal(sameSaved.vehicleLicensePlateSnapshot, pastUnit.licensePlate);
    assert.equal(sameSaved.vehicleColorSnapshot, "Yellow");
    assert.equal(sameSaved.status, "VEHICLE_HANDED_OVER");
    assert.deepEqual(moneyOf(sameSaved), beforeMoney);
    assert.equal(await prisma.stripePayment.count({ where: { bookingId: active.id } }), stripeBefore);

    const oldLock = sameSaved.unitOccupancies.find((row) => row.vehicleUnitId === currentUnit.id);
    const newLock = sameSaved.unitOccupancies.find((row) => row.vehicleUnitId === pastUnit.id);
    assert.ok(oldLock);
    assert.ok(newLock);
    assert.equal(oldLock.returnAt.toISOString(), newLock.pickupAt.toISOString());
    assert.equal(newLock.returnAt.toISOString(), sameSaved.returnDateTime.toISOString());
    assert.ok(oldLock.returnAt.getTime() > sameSaved.pickupDateTime.getTime());
    assert.ok(oldLock.returnAt.getTime() < sameSaved.returnDateTime.getTime());

    assert.equal(sameSaved.vehicleAssignments.length, 2);
    assert.equal(sameSaved.vehicleAssignments[0]?.licensePlateSnapshot, currentUnit.licensePlate);
    assert.equal(sameSaved.vehicleAssignments[0]?.endedAt?.toISOString(), newLock.pickupAt.toISOString());
    assert.equal(sameSaved.vehicleAssignments[0]?.endDisposition, "MAINTENANCE");
    assert.equal(sameSaved.vehicleAssignments[0]?.reason, "mechanical_issue");
    assert.equal(sameSaved.vehicleAssignments[1]?.licensePlateSnapshot, pastUnit.licensePlate);
    assert.equal(sameSaved.vehicleAssignments[1]?.endedAt, null);

    const audit = sameSaved.statusHistory.find((entry) => entry.note?.includes("Booking price unchanged"));
    assert.ok(audit?.note?.includes(currentUnit.licensePlate));
    assert.ok(audit?.note?.includes(pastUnit.licensePlate));

    const oldUnit = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: currentUnit.id } });
    const newUnit = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: pastUnit.id } });
    assert.equal(oldUnit.status, "MAINTENANCE");
    assert.equal(newUnit.status, "OUT_WITH_CUSTOMER");
    const oldStillFree = await findAvailableVehicleUnits({
      vehicleId: nmax.id,
      requestedStart: new Date(oldLock.returnAt.getTime() + 60_000),
      requestedEnd: sameSaved.returnDateTime,
    });
    assert.equal(oldStillFree.some((unit) => unit.id === currentUnit.id), false);
    const newStillOut = await findAvailableVehicleUnits({
      vehicleId: pastUsed.id,
      requestedStart: newLock.pickupAt,
      requestedEnd: newLock.returnAt,
    });
    assert.equal(newStillOut.some((unit) => unit.id === pastUnit.id), false);
    logPass("replacement keeps the booking and price, closes the old interval, and hands over the new unit");

    const returned = await markVehicleReturned(
      active.id,
      {
        returnRecordedAt: new Date(),
        unitStatusAfterReturn: "AVAILABLE",
        note: "Replacement bike returned",
      },
      admin.id,
    );
    assert.equal(returned.ok, true);
    const afterReturn = await prisma.booking.findUniqueOrThrow({ where: { id: active.id } });
    const originalAfterReturn = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: currentUnit.id } });
    const replacementAfterReturn = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: pastUnit.id } });
    assert.equal(afterReturn.status, "RETURNED");
    assert.equal(afterReturn.vehicleUnitId, pastUnit.id);
    assert.equal(originalAfterReturn.status, "MAINTENANCE");
    assert.equal(replacementAfterReturn.status, "AVAILABLE");
    logPass("return updates the replacement unit and leaves the original unit alone");

    const completed = await completeBooking(
      active.id,
      {
        depositOutcome: "REFUNDED",
        depositRefundAmount: 250,
        unitStatusAfterCompletion: "NOT_AVAILABLE",
      },
      admin.id,
    );
    assert.equal(completed.ok, true);
    const afterComplete = await prisma.booking.findUniqueOrThrow({
      where: { id: active.id },
      include: { unitOccupancies: true, vehicleAssignments: true },
    });
    const originalAfterComplete = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: currentUnit.id } });
    const replacementAfterComplete = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: pastUnit.id } });
    assert.equal(afterComplete.unitOccupancies.length, 0);
    assert.equal(afterComplete.vehicleAssignments.length, 2);
    assert.equal(originalAfterComplete.status, "MAINTENANCE");
    assert.equal(replacementAfterComplete.status, "NOT_AVAILABLE");
    logPass("completion releases locks without erasing vehicle history or touching the original unit");

    const extendedBooking = await createBooking({
      vehicleId: nmax.id,
      unitId: extensionUnit.id,
      plate: extensionUnit.licensePlate,
      color: "Grey",
      name: nmax.name,
      pickup: hoursFromNow(-24),
      returnAt: hoursFromNow(48),
      unitStatus: "OUT_WITH_CUSTOMER",
    });
    const extendedReturn = hoursFromNow(24 * 6);
    const extended = await extendBooking(
      extendedBooking.id,
      extendedReturn,
      admin.id,
      extendedBooking.updatedAt,
    );
    assert.equal(extended.ok, true);
    const extendedRow = await prisma.booking.findUniqueOrThrow({
      where: { id: extendedBooking.id },
      include: { extensions: true },
    });
    const extensionAmount = extendedRow.extensions[0]?.additionalAmount.toNumber();
    assert.equal(extendedRow.extensions.length, 1);
    const overlapDuringExtension = await createBooking({
      vehicleId: pcx.id,
      unitId: pcxUnit.id,
      plate: pcxUnit.licensePlate,
      color: "Blue",
      name: pcx.name,
      pickup: hoursFromNow(24 * 3),
      returnAt: hoursFromNow(24 * 4),
      status: "CONFIRMED",
      unitStatus: "RESERVED",
    });
    const extensionConflict = await replaceBookingVehicle(
      extendedBooking.id,
      replacementInput(extendedRow, pcxUnit.id),
      admin.id,
    );
    assert.equal(extensionConflict.ok, false);
    if (!extensionConflict.ok) assert.equal(extensionConflict.reason, "no_availability");
    assert.equal(overlapDuringExtension.returnDateTime.getTime() > hoursFromNow(48).getTime(), true);
    logPass("replacement availability uses the extended return and rejects a later conflict");

    const reloadedExtension = await prisma.booking.findUniqueOrThrow({
      where: { id: extendedBooking.id },
      include: { extensions: true },
    });
    const shortTarget = secondNmax;
    await prisma.vehicleUnit.update({
      where: { id: shortTarget.id },
      data: { status: "AVAILABLE" },
    });
    const beforeReplaceExtension = moneyOf(reloadedExtension);
    const replacedExtension = await replaceBookingVehicle(
      extendedBooking.id,
      replacementInput(reloadedExtension, shortTarget.id, "AVAILABLE"),
      admin.id,
    );
    assert.equal(replacedExtension.ok, true);
    const extensionSaved = await prisma.booking.findUniqueOrThrow({
      where: { id: extendedBooking.id },
      include: { extensions: true, unitOccupancies: true },
    });
    assert.equal(extensionSaved.vehicleId, nmax.id);
    assert.equal(extensionSaved.vehicleUnitId, shortTarget.id);
    assert.deepEqual(moneyOf(extensionSaved), beforeReplaceExtension);
    assert.equal(extensionSaved.extensions[0]?.additionalAmount.toNumber(), extensionAmount);
    const extensionLock = extensionSaved.unitOccupancies.find((row) => row.vehicleUnitId === shortTarget.id);
    assert.equal(extensionLock?.returnAt.toISOString(), extensionSaved.returnDateTime.toISOString());
    const releasedNmax = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: extensionUnit.id } });
    assert.equal(releasedNmax.status, "AVAILABLE");
    logPass("an extended booking keeps its extension price and locks the replacement until the new return");

    const shortBooking = await createBooking({
      vehicleId: pcx.id,
      unitId: pcxMaintenance.id,
      plate: pcxMaintenance.licensePlate,
      color: "Grey",
      name: pcx.name,
      pickup: hoursFromNow(-2),
      returnAt: hoursFromNow(6),
      billableDays: 1,
      actualDurationHours: 8,
      unitStatus: "OUT_WITH_CUSTOMER",
    });
    const shortBefore = await prisma.booking.findUniqueOrThrow({ where: { id: shortBooking.id } });
    const shortMoney = moneyOf(shortBefore);
    const storageFree = await createVehicle({
      name: `Short Replacement ${testSuffix}`,
      baseDailyRate: 80,
      units: [{ color: "Blue", status: "AVAILABLE" }],
    });
    const shortUnit = storageFree.units[0];
    if (!shortUnit) throw new Error("Expected short replacement unit");
    const shortOk = await replaceBookingVehicle(
      shortBooking.id,
      {
        ...replacementInput(shortBefore, shortUnit.id, "NOT_AVAILABLE"),
        reason: "customer_requested",
      },
      admin.id,
    );
    assert.equal(shortOk.ok, true);
    const shortSaved = await prisma.booking.findUniqueOrThrow({ where: { id: shortBooking.id } });
    assert.deepEqual(moneyOf(shortSaved), shortMoney);
    assert.equal(shortSaved.vehicleId, storageFree.id);
    assert.equal(shortSaved.baseDailyRateSnapshot?.toNumber(), 30);
    assert.equal(shortSaved.billableDays, 1);
    const shortOld = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: pcxMaintenance.id } });
    assert.equal(shortOld.status, "NOT_AVAILABLE");
    logPass("a sub-24-hour rental can be replaced onto another model without repricing");

    const sourceModel = await createVehicle({
      name: `Consistency Source ${testSuffix}`,
      baseDailyRate: 28,
      units: [
        { color: "Red", status: "OUT_WITH_CUSTOMER" },
        { color: "Black", status: "AVAILABLE" },
      ],
    });
    const firstModel = await createVehicle({
      name: `Consistency First ${testSuffix}`,
      baseDailyRate: 41,
      units: [
        { color: "Blue", status: "AVAILABLE" },
        { color: "White", status: "RESERVED" },
      ],
    });
    const secondModel = await createVehicle({
      name: `Consistency Second ${testSuffix}`,
      baseDailyRate: 52,
      units: [{ color: "Green", status: "AVAILABLE" }],
    });
    const sourceUnit = sourceModel.units[0];
    const sourceSibling = sourceModel.units[1];
    const firstUnit = firstModel.units[0];
    const firstSibling = firstModel.units[1];
    const secondUnit = secondModel.units[0];
    if (!sourceUnit || !sourceSibling || !firstUnit || !firstSibling || !secondUnit) {
      throw new Error("Expected consistency units");
    }

    const consistentPickup = hoursFromNow(-20);
    const consistentReturn = hoursFromNow(80);
    const consistentBooking = await createBooking({
      vehicleId: sourceModel.id,
      unitId: sourceUnit.id,
      plate: sourceUnit.licensePlate,
      color: "Red",
      name: sourceModel.name,
      pickup: consistentPickup,
      returnAt: consistentReturn,
      unitStatus: "OUT_WITH_CUSTOMER",
    });

    type ConsistencyLink = {
      vehicleId: string;
      unitId: string;
      name: string;
      plate: string;
      color: string;
      releasedStatus: "AVAILABLE" | "MAINTENANCE" | "NOT_AVAILABLE" | null;
    };

    async function assertReplacementConsistency(links: ConsistencyLink[]): Promise<void> {
      const current = links[links.length - 1];
      if (!current) throw new Error("Expected a current vehicle");

      const saved = await prisma.booking.findUniqueOrThrow({
        where: { id: consistentBooking.id },
        include: {
          vehicle: { select: { id: true, name: true, vehicleType: true, catalogStatus: true } },
          vehicleUnit: { select: { id: true, vehicleId: true, licensePlate: true, color: true, status: true } },
          unitOccupancies: { orderBy: { pickupAt: "asc" } },
          vehicleAssignments: { orderBy: { startedAt: "asc" } },
        },
      });
      const liveUnits = await prisma.vehicleUnit.findMany({
        where: {
          id: { in: [sourceUnit.id, sourceSibling.id, firstUnit.id, firstSibling.id, secondUnit.id] },
        },
        select: { id: true, vehicleId: true, licensePlate: true, color: true, status: true, isActive: true },
      });
      const liveById = new Map(liveUnits.map((unit) => [unit.id, unit]));
      const vehicles = await prisma.vehicle.findMany({
        where: { id: { in: [sourceModel.id, firstModel.id, secondModel.id] } },
        select: { id: true, catalogStatus: true },
      });

      assert.equal(saved.status, "VEHICLE_HANDED_OVER");
      assert.equal(saved.pickupDateTime.toISOString(), consistentPickup.toISOString());
      assert.equal(saved.returnDateTime.toISOString(), consistentReturn.toISOString());
      assert.equal(saved.vehicleId, current.vehicleId);
      assert.equal(saved.vehicleUnitId, current.unitId);
      assert.equal(saved.vehicle?.id, current.vehicleId);
      assert.equal(saved.vehicle?.name, current.name);
      assert.equal(saved.vehicle?.catalogStatus, "AVAILABLE");
      assert.equal(saved.vehicleUnit?.id, current.unitId);
      assert.equal(saved.vehicleUnit?.vehicleId, current.vehicleId);
      assert.equal(saved.vehicleUnit?.licensePlate, current.plate);
      assert.equal(saved.vehicleUnit?.status, "OUT_WITH_CUSTOMER");
      assert.equal(saved.vehicleNameSnapshot, current.name);
      assert.equal(saved.vehicleLicensePlateSnapshot, current.plate);
      assert.equal(saved.vehicleColorSnapshot, current.color);
      assert.equal(saved.vehicleTypeSnapshot, saved.vehicle?.vehicleType);
      assert.equal(vehicles.every((vehicle) => vehicle.catalogStatus === "AVAILABLE"), true);

      assert.equal(saved.unitOccupancies.length, links.length);
      assert.equal(saved.vehicleAssignments.length, links.length);
      assert.equal(saved.vehicleAssignments.filter((row) => row.endedAt === null).length, 1);

      for (let index = 0; index < links.length; index += 1) {
        const link = links[index];
        const occupancy = saved.unitOccupancies[index];
        const assignment = saved.vehicleAssignments[index];
        const live = link ? liveById.get(link.unitId) : undefined;
        if (!link || !occupancy || !assignment || !live) {
          throw new Error(`Missing consistency row ${index}`);
        }
        const next = links[index + 1];
        assert.equal(live.vehicleId, link.vehicleId);
        assert.equal(live.licensePlate, link.plate);
        assert.equal(live.color, link.color);
        assert.equal(live.isActive, true);
        assert.equal(live.status, next ? link.releasedStatus : "OUT_WITH_CUSTOMER");
        assert.notEqual(live.status, next ? "OUT_WITH_CUSTOMER" : link.releasedStatus);

        assert.equal(occupancy.vehicleUnitId, link.unitId);
        assert.equal(occupancy.bookingId, saved.id);
        assert.equal(assignment.vehicleId, link.vehicleId);
        assert.equal(assignment.vehicleUnitId, link.unitId);
        assert.equal(assignment.vehicleNameSnapshot, link.name);
        assert.equal(assignment.licensePlateSnapshot, link.plate);
        assert.equal(assignment.colorSnapshot, link.color);
        assert.equal(assignment.startedAt.toISOString(), occupancy.pickupAt.toISOString());

        if (index === 0) {
          assert.equal(occupancy.pickupAt.toISOString(), saved.pickupDateTime.toISOString());
        }
        if (!next) {
          assert.equal(occupancy.returnAt.toISOString(), saved.returnDateTime.toISOString());
          assert.equal(assignment.endedAt, null);
          assert.equal(assignment.endDisposition, null);
        } else {
          const nextOccupancy = saved.unitOccupancies[index + 1];
          assert.ok(nextOccupancy);
          assert.equal(occupancy.returnAt.toISOString(), nextOccupancy.pickupAt.toISOString());
          assert.equal(assignment.endedAt?.toISOString(), occupancy.returnAt.toISOString());
          assert.equal(assignment.endDisposition, link.releasedStatus);
          assert.ok(occupancy.returnAt.getTime() > occupancy.pickupAt.getTime());
          assert.ok(occupancy.returnAt.getTime() < saved.returnDateTime.getTime());
        }
      }

      const coveredUnitIds = new Set(links.map((link) => link.unitId));
      const strayOccupancy = await prisma.vehicleUnitOccupancy.count({
        where: {
          bookingId: saved.id,
          vehicleUnitId: { notIn: [...coveredUnitIds] },
        },
      });
      assert.equal(strayOccupancy, 0);

      const openPastLocks = await prisma.vehicleUnitOccupancy.count({
        where: {
          bookingId: saved.id,
          vehicleUnitId: { not: current.unitId },
          returnAt: { gt: new Date() },
        },
      });
      assert.equal(openPastLocks, 0);

      for (const sibling of [
        { id: sourceSibling.id, vehicleId: sourceModel.id, status: "AVAILABLE" as const },
        { id: firstSibling.id, vehicleId: firstModel.id, status: "RESERVED" as const },
      ]) {
        const siblingUnit = liveById.get(sibling.id);
        assert.equal(siblingUnit?.vehicleId, sibling.vehicleId);
        assert.equal(siblingUnit?.status, sibling.status);
        const siblingLocks = await prisma.vehicleUnitOccupancy.count({ where: { vehicleUnitId: sibling.id } });
        assert.equal(siblingLocks, 0);
      }

      const currentFree = await findAvailableVehicleUnits({
        vehicleId: current.vehicleId,
        requestedStart: new Date(),
        requestedEnd: saved.returnDateTime,
      });
      assert.equal(currentFree.some((unit) => unit.id === current.unitId), false);

      for (const link of links) {
        if (link.releasedStatus !== "AVAILABLE") continue;
        const releasedFree = await findAvailableVehicleUnits({
          vehicleId: link.vehicleId,
          requestedStart: new Date(),
          requestedEnd: saved.returnDateTime,
        });
        assert.equal(releasedFree.some((unit) => unit.id === link.unitId), true);
      }
    }

    const beforeFirst = await prisma.booking.findUniqueOrThrow({ where: { id: consistentBooking.id } });
    const firstSwap = await replaceBookingVehicle(
      consistentBooking.id,
      replacementInput(beforeFirst, firstUnit.id, "AVAILABLE"),
      admin.id,
    );
    assert.equal(firstSwap.ok, true);
    await assertReplacementConsistency([
      {
        vehicleId: sourceModel.id,
        unitId: sourceUnit.id,
        name: sourceModel.name,
        plate: sourceUnit.licensePlate,
        color: "Red",
        releasedStatus: "AVAILABLE",
      },
      {
        vehicleId: firstModel.id,
        unitId: firstUnit.id,
        name: firstModel.name,
        plate: firstUnit.licensePlate,
        color: "Blue",
        releasedStatus: null,
      },
    ]);

    const beforeSecond = await prisma.booking.findUniqueOrThrow({ where: { id: consistentBooking.id } });
    const secondSwap = await replaceBookingVehicle(
      consistentBooking.id,
      replacementInput(beforeSecond, secondUnit.id, "MAINTENANCE"),
      admin.id,
    );
    assert.equal(secondSwap.ok, true);
    await assertReplacementConsistency([
      {
        vehicleId: sourceModel.id,
        unitId: sourceUnit.id,
        name: sourceModel.name,
        plate: sourceUnit.licensePlate,
        color: "Red",
        releasedStatus: "AVAILABLE",
      },
      {
        vehicleId: firstModel.id,
        unitId: firstUnit.id,
        name: firstModel.name,
        plate: firstUnit.licensePlate,
        color: "Blue",
        releasedStatus: "MAINTENANCE",
      },
      {
        vehicleId: secondModel.id,
        unitId: secondUnit.id,
        name: secondModel.name,
        plate: secondUnit.licensePlate,
        color: "Green",
        releasedStatus: null,
      },
    ]);

    const beforeExtend = await prisma.booking.findUniqueOrThrow({
      where: { id: consistentBooking.id },
      include: { unitOccupancies: { orderBy: { pickupAt: "asc" } } },
    });
    const closedEnds = beforeExtend.unitOccupancies
      .filter((row) => row.vehicleUnitId !== secondUnit.id)
      .map((row) => row.returnAt.toISOString());
    const extendedReturnAt = hoursFromNow(100);
    const extendedConsistent = await extendBooking(
      consistentBooking.id,
      extendedReturnAt,
      admin.id,
      beforeExtend.updatedAt,
    );
    assert.equal(extendedConsistent.ok, true);
    const afterExtend = await prisma.booking.findUniqueOrThrow({
      where: { id: consistentBooking.id },
      include: {
        unitOccupancies: { orderBy: { pickupAt: "asc" } },
        vehicleUnit: { select: { status: true, vehicleId: true } },
      },
    });
    assert.equal(afterExtend.vehicleId, secondModel.id);
    assert.equal(afterExtend.vehicleUnitId, secondUnit.id);
    assert.equal(afterExtend.vehicleUnit?.status, "OUT_WITH_CUSTOMER");
    assert.equal(afterExtend.vehicleUnit?.vehicleId, secondModel.id);
    assert.equal(afterExtend.returnDateTime.toISOString(), extendedReturnAt.toISOString());
    const currentAfterExtend = afterExtend.unitOccupancies.find((row) => row.vehicleUnitId === secondUnit.id);
    assert.equal(currentAfterExtend?.returnAt.toISOString(), extendedReturnAt.toISOString());
    assert.deepEqual(
      afterExtend.unitOccupancies
        .filter((row) => row.vehicleUnitId !== secondUnit.id)
        .map((row) => row.returnAt.toISOString()),
      closedEnds,
    );
    const sourceAfterExtend = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: sourceUnit.id } });
    const firstAfterExtend = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: firstUnit.id } });
    assert.equal(sourceAfterExtend.status, "AVAILABLE");
    assert.equal(firstAfterExtend.status, "MAINTENANCE");

    const intervalsBeforeReturn = afterExtend.unitOccupancies.map((row) => ({
      vehicleUnitId: row.vehicleUnitId,
      pickupAt: row.pickupAt.toISOString(),
      returnAt: row.returnAt.toISOString(),
    }));
    const returnedConsistent = await markVehicleReturned(
      consistentBooking.id,
      {
        returnRecordedAt: new Date(),
        unitStatusAfterReturn: "AVAILABLE",
        note: "Consistency return",
      },
      admin.id,
    );
    assert.equal(returnedConsistent.ok, true);
    const afterConsistentReturn = await prisma.booking.findUniqueOrThrow({
      where: { id: consistentBooking.id },
      include: {
        unitOccupancies: { orderBy: { pickupAt: "asc" } },
        vehicleAssignments: { orderBy: { startedAt: "asc" } },
      },
    });
    const sourceAfterReturn = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: sourceUnit.id } });
    const firstAfterReturn = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: firstUnit.id } });
    const secondAfterReturn = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: secondUnit.id } });
    const sourceSiblingAfterReturn = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: sourceSibling.id } });
    const firstSiblingAfterReturn = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: firstSibling.id } });
    assert.equal(afterConsistentReturn.status, "RETURNED");
    assert.equal(afterConsistentReturn.vehicleId, secondModel.id);
    assert.equal(afterConsistentReturn.vehicleUnitId, secondUnit.id);
    assert.equal(afterConsistentReturn.vehicleNameSnapshot, secondModel.name);
    assert.equal(afterConsistentReturn.vehicleLicensePlateSnapshot, secondUnit.licensePlate);
    assert.deepEqual(
      afterConsistentReturn.unitOccupancies.map((row) => ({
        vehicleUnitId: row.vehicleUnitId,
        pickupAt: row.pickupAt.toISOString(),
        returnAt: row.returnAt.toISOString(),
      })),
      intervalsBeforeReturn,
    );
    assert.equal(afterConsistentReturn.vehicleAssignments.length, 3);
    assert.equal(afterConsistentReturn.vehicleAssignments.filter((row) => row.endedAt === null).length, 1);
    assert.equal(sourceAfterReturn.status, "AVAILABLE");
    assert.equal(firstAfterReturn.status, "MAINTENANCE");
    assert.equal(secondAfterReturn.status, "AVAILABLE");
    assert.equal(sourceSiblingAfterReturn.status, "AVAILABLE");
    assert.equal(firstSiblingAfterReturn.status, "RESERVED");

    const completedConsistent = await completeBooking(
      consistentBooking.id,
      {
        depositOutcome: "REFUNDED",
        depositRefundAmount: 250,
        unitStatusAfterCompletion: "NOT_AVAILABLE",
      },
      admin.id,
    );
    assert.equal(completedConsistent.ok, true);
    const afterConsistentComplete = await prisma.booking.findUniqueOrThrow({
      where: { id: consistentBooking.id },
      include: { unitOccupancies: true, vehicleAssignments: { orderBy: { startedAt: "asc" } } },
    });
    const sourceAfterComplete = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: sourceUnit.id } });
    const firstAfterComplete = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: firstUnit.id } });
    const secondAfterComplete = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: secondUnit.id } });
    assert.equal(afterConsistentComplete.status, "COMPLETED");
    assert.equal(afterConsistentComplete.vehicleId, secondModel.id);
    assert.equal(afterConsistentComplete.vehicleUnitId, secondUnit.id);
    assert.equal(afterConsistentComplete.unitOccupancies.length, 0);
    assert.equal(afterConsistentComplete.vehicleAssignments.length, 3);
    assert.equal(afterConsistentComplete.vehicleAssignments[0]?.vehicleUnitId, sourceUnit.id);
    assert.equal(afterConsistentComplete.vehicleAssignments[0]?.endDisposition, "AVAILABLE");
    assert.equal(afterConsistentComplete.vehicleAssignments[1]?.vehicleUnitId, firstUnit.id);
    assert.equal(afterConsistentComplete.vehicleAssignments[1]?.endDisposition, "MAINTENANCE");
    assert.equal(afterConsistentComplete.vehicleAssignments[2]?.vehicleUnitId, secondUnit.id);
    assert.equal(afterConsistentComplete.vehicleAssignments[2]?.endedAt, null);
    assert.equal(sourceAfterComplete.status, "AVAILABLE");
    assert.equal(firstAfterComplete.status, "MAINTENANCE");
    assert.equal(secondAfterComplete.status, "NOT_AVAILABLE");
    logPass("chained replacement keeps vehicles, units, dates, and statuses consistent");

    const raceBooking = await createBooking({
      vehicleId: nmax.id,
      unitId: currentUnit.id,
      plate: currentUnit.licensePlate,
      color: "Red",
      name: nmax.name,
      pickup: hoursFromNow(-5),
      returnAt: hoursFromNow(40),
      unitStatus: "OUT_WITH_CUSTOMER",
    });
    await prisma.vehicleUnit.update({
      where: { id: currentUnit.id },
      data: { status: "OUT_WITH_CUSTOMER" },
    });
    const raceA = await createVehicle({
      name: `Race A ${testSuffix}`,
      baseDailyRate: 20,
      units: [{ color: "Red", status: "AVAILABLE" }],
    });
    const raceB = await createVehicle({
      name: `Race B ${testSuffix}`,
      baseDailyRate: 22,
      units: [{ color: "Red", status: "AVAILABLE" }],
    });
    const raceUnitA = raceA.units[0];
    const raceUnitB = raceB.units[0];
    if (!raceUnitA || !raceUnitB) throw new Error("Expected race units");
    const raceSource = await prisma.booking.findUniqueOrThrow({ where: { id: raceBooking.id } });
    const [first, second] = await Promise.all([
      replaceBookingVehicle(raceBooking.id, replacementInput(raceSource, raceUnitA.id), admin.id),
      replaceBookingVehicle(raceBooking.id, replacementInput(raceSource, raceUnitB.id), admin.id),
    ]);
    const successes = [first, second].filter((result) => result.ok);
    assert.equal(successes.length, 1);
    const raceSaved = await prisma.booking.findUniqueOrThrow({
      where: { id: raceBooking.id },
      include: { unitOccupancies: true, vehicleAssignments: true },
    });
    assert.equal(
      raceSaved.vehicleUnitId === raceUnitA.id || raceSaved.vehicleUnitId === raceUnitB.id,
      true,
    );
    assert.equal(raceSaved.vehicleAssignments.filter((row) => row.endedAt === null).length, 1);
    assert.equal(raceSaved.unitOccupancies.filter((row) => row.vehicleUnitId === raceSaved.vehicleUnitId).length, 1);
    logPass("two simultaneous replacements leave one current vehicle");
  } finally {
    await cleanup();
  }
}

runDatabaseTests().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
