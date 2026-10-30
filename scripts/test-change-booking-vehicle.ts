/**
 * Change the booked vehicle model on an existing booking.
 *
 * Run: npm run test:change-booking-vehicle
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import type { BookingStatus, VehicleUnitStatus } from "../src/generated/prisma/index";
import { calculateVehicleChangePrice } from "../src/lib/admin/bookings/calculate-vehicle-change-price";
import { resolveHandOverVehicleUnitId } from "../src/lib/admin/bookings/resolve-hand-over-vehicle-unit-id";
import { isVehicleChangeBookingStatus } from "../src/lib/admin/bookings/vehicle-change-eligibility";

const testSuffix = Date.now().toString(36);

function logPass(name: string): void {
  console.log(`${name} PASS`);
}

function atUtc(day: number, hour = 10): Date {
  return new Date(Date.UTC(2099, 9, day, hour, 0, 0, 0));
}

function runPureTests(): void {
  assert.equal(isVehicleChangeBookingStatus("CONFIRMED"), true);
  assert.equal(isVehicleChangeBookingStatus("PENDING_PAYMENT"), true);
  assert.equal(isVehicleChangeBookingStatus("VEHICLE_HANDED_OVER"), false);
  assert.equal(isVehicleChangeBookingStatus("RETURNED"), false);
  assert.equal(isVehicleChangeBookingStatus("COMPLETED"), false);
  assert.equal(isVehicleChangeBookingStatus("CANCELLED"), false);
  logPass("vehicle change is limited to bookings before handover");

  const kept = calculateVehicleChangePrice({
    priceMode: "keep_existing",
    hasExtensions: false,
    billableDays: 6,
    currentRentalCost: 180,
    currentSubtotal: 230,
    currentTotalDueOnline: 230,
    currentTotalDueLater: 250,
    depositAmount: 250,
    depositMethod: "IN_PERSON",
    hotelDiscountPercentSnapshot: 10,
    hotelDiscountAmountSnapshot: 18,
    replacementBaseDailyRate: 40,
  });
  assert.equal(kept.ok, true);
  if (kept.ok) {
    assert.equal(kept.pricing.calculatedRentalCost, 240);
    assert.equal(kept.pricing.calculatedHotelDiscountAmount, 24);
    assert.equal(kept.pricing.calculatedSubtotal, 284);
    assert.equal(kept.pricing.priceDifference, 54);
    assert.equal(kept.pricing.finalSubtotal, 230);
    assert.equal(kept.pricing.finalRentalCost, 180);
    assert.equal(kept.pricing.duesUpdated, false);
    assert.equal(kept.pricing.calculatedDurationDiscountPercent, 0);
  }
  logPass("keeping the agreed price shows the catalog difference without changing the total");

  const applied = calculateVehicleChangePrice({
    priceMode: "apply_catalog",
    hasExtensions: false,
    billableDays: 6,
    currentRentalCost: 180,
    currentSubtotal: 230,
    currentTotalDueOnline: 230,
    currentTotalDueLater: 250,
    depositAmount: 250,
    depositMethod: "IN_PERSON",
    hotelDiscountPercentSnapshot: 10,
    hotelDiscountAmountSnapshot: 18,
    replacementBaseDailyRate: 40,
  });
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(applied.pricing.finalRentalCost, 240);
    assert.equal(applied.pricing.finalSubtotal, 284);
    assert.equal(applied.pricing.finalTotalDueOnline, 284);
    assert.equal(applied.pricing.finalTotalDueLater, 250);
    assert.equal(applied.pricing.duesUpdated, true);
    assert.equal(applied.pricing.calculatedAppliedDailyRate, 40);
  }
  logPass("applying the catalog rate updates rental, hotel discount, and matching amounts due");

  const week = calculateVehicleChangePrice({
    priceMode: "apply_catalog",
    hasExtensions: false,
    billableDays: 7,
    currentRentalCost: 200,
    currentSubtotal: 200,
    currentTotalDueOnline: 0,
    currentTotalDueLater: 0,
    depositAmount: 250,
    depositMethod: "IN_PERSON",
    hotelDiscountPercentSnapshot: null,
    hotelDiscountAmountSnapshot: null,
    replacementBaseDailyRate: 50,
  });
  assert.equal(week.ok, true);
  if (week.ok) {
    assert.equal(week.pricing.calculatedDurationDiscountPercent, 20);
    assert.equal(week.pricing.calculatedAppliedDailyRate, 40);
    assert.equal(week.pricing.calculatedRentalCost, 280);
    assert.equal(week.pricing.duesUpdated, false);
    assert.equal(week.pricing.finalTotalDueOnline, 0);
  }
  logPass("duration discount is applied to the new rate and already-zeroed dues stay untouched");

  const extended = calculateVehicleChangePrice({
    priceMode: "apply_catalog",
    hasExtensions: true,
    billableDays: 6,
    currentRentalCost: 180,
    currentSubtotal: 230,
    currentTotalDueOnline: 230,
    currentTotalDueLater: 250,
    depositAmount: 250,
    depositMethod: "IN_PERSON",
    hotelDiscountPercentSnapshot: 10,
    hotelDiscountAmountSnapshot: 18,
    replacementBaseDailyRate: 40,
  });
  assert.equal(extended.ok, false);
  if (!extended.ok) assert.equal(extended.reason, "price_mode_unavailable");
  logPass("an extended booking cannot be repriced from the new model");

  assert.equal(
    resolveHandOverVehicleUnitId({
      formVehicleUnitId: "old-unit",
      bookingVehicleUnitId: "new-unit",
      selectableUnitIds: ["new-unit", "spare-unit"],
    }),
    "new-unit",
  );
  assert.equal(
    resolveHandOverVehicleUnitId({
      formVehicleUnitId: "new-unit",
      bookingVehicleUnitId: "new-unit",
      selectableUnitIds: ["new-unit", "spare-unit"],
    }),
    "new-unit",
  );
  assert.equal(
    resolveHandOverVehicleUnitId({
      formVehicleUnitId: "stale-unit",
      bookingVehicleUnitId: null,
      selectableUnitIds: ["only-available"],
    }),
    "only-available",
  );
  logPass("handover form drops a stale unit id after the booked model changes");
}

async function runDatabaseTests(): Promise<void> {
  const { assertSafeScriptDatabase } = await import("./assert-safe-script-database");
  assertSafeScriptDatabase("test-change-booking-vehicle");
  const { prisma } = await import("../src/lib/prisma");
  const {
    changeBookingVehicle,
    listChangeBookingVehicleOptions,
    previewChangeBookingVehicle,
  } = await import("../src/lib/admin/bookings/changeBookingVehicle");
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
      await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    }
    if (adminId) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  function plate(prefix: string): string {
    return `${prefix}${randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 16);
  }

  async function createVehicle(input: {
    name: string;
    vehicleType?: "Scooter" | "Motorcycle";
    engineCc?: number | null;
    baseDailyRate: number;
    isActive?: boolean;
    catalogStatus?: "AVAILABLE" | "MAINTENANCE" | "INACTIVE";
    supportsStorageBox?: boolean;
    units: Array<{ color: string | null; status: VehicleUnitStatus }>;
  }) {
    const slug = `change-vehicle-${testSuffix}-${randomBytes(3).toString("hex")}`;
    const vehicle = await prisma.vehicle.create({
      data: {
        name: input.name,
        slug,
        vehicleType: input.vehicleType ?? "Scooter",
        engineCc: input.engineCc === undefined ? 50 : input.engineCc,
        baseDailyRate: input.baseDailyRate,
        isActive: input.isActive ?? true,
        catalogStatus: input.catalogStatus ?? "AVAILABLE",
        supportsStorageBox: input.supportsStorageBox ?? true,
        units: {
          create: input.units.map((unit) => ({
            licensePlate: plate(unit.status === "MAINTENANCE" ? "MNT" : "CHG"),
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
    unitId?: string | null;
    plate?: string | null;
    color?: string | null;
    name: string;
    pickup: Date;
    returnAt: Date;
    status?: BookingStatus;
    storageBoxSelected?: boolean;
    withOccupancy?: boolean;
  }) {
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `CHG-${randomBytes(4).toString("hex").toUpperCase()}`,
        status: input.status ?? "CONFIRMED",
        vehicleId: input.vehicleId,
        vehicleUnitId: input.unitId ?? null,
        vehicleNameSnapshot: input.name,
        vehicleLicensePlateSnapshot: input.plate ?? null,
        vehicleColorSnapshot: input.color ?? null,
        vehicleType: "Scooter",
        vehicleTypeSnapshot: "Scooter",
        pickupDateTime: input.pickup,
        returnDateTime: input.returnAt,
        actualDurationHours: 120,
        billableDays: 6,
        pickupOption: "OFFICE",
        dropoffOption: "OFFICE",
        customerFullName: "Change Vehicle Customer",
        customerPhone: "+35699000055",
        customerEmail: `change-vehicle-${testSuffix}@test.local`,
        customerNationality: "Maltese",
        customerDateOfBirth: new Date("1990-01-01"),
        customerLicenseCategory: "B",
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
        storageBoxSelected: input.storageBoxSelected ?? false,
        storageBoxCost: input.storageBoxSelected ? 10 : 0,
        subtotal: 230,
        totalDueOnline: 230,
        totalDueLater: 250,
      },
    });
    bookingIds.push(booking.id);
    if (input.withOccupancy !== false && input.unitId) {
      await insertBookingOccupancy(prisma, {
        vehicleUnitId: input.unitId,
        pickupAt: input.pickup,
        returnAt: input.returnAt,
        bookingId: booking.id,
      });
    }
    return booking;
  }

  try {
    const admin = await prisma.adminUser.create({
      data: {
        name: "Change Vehicle Test",
        email: `change-vehicle-${testSuffix}@test.local`,
        role: "STAFF",
      },
    });
    adminId = admin.id;

    const source = await createVehicle({
      name: `Source PCX ${testSuffix}`,
      baseDailyRate: 30,
      units: [{ color: "Red", status: "RESERVED" }],
    });
    const target = await createVehicle({
      name: `Target NMAX ${testSuffix}`,
      baseDailyRate: 40,
      units: [
        { color: "Black", status: "MAINTENANCE" },
        { color: "Black", status: "AVAILABLE" },
      ],
    });
    const blocked = await createVehicle({
      name: `Blocked Bike ${testSuffix}`,
      baseDailyRate: 45,
      units: [{ color: "White", status: "AVAILABLE" }],
    });
    const motorcycle = await createVehicle({
      name: `Licence Blocked ${testSuffix}`,
      vehicleType: "Motorcycle",
      engineCc: 125,
      baseDailyRate: 55,
      units: [{ color: "Black", status: "AVAILABLE" }],
    });
    const noBox = await createVehicle({
      name: `No Storage ${testSuffix}`,
      baseDailyRate: 28,
      supportsStorageBox: false,
      units: [{ color: "Blue", status: "AVAILABLE" }],
    });
    const inactive = await createVehicle({
      name: `Inactive Bike ${testSuffix}`,
      baseDailyRate: 33,
      isActive: false,
      catalogStatus: "INACTIVE",
      units: [{ color: "Green", status: "AVAILABLE" }],
    });
    const openTarget = await createVehicle({
      name: `Open Model ${testSuffix}`,
      baseDailyRate: 36,
      units: [{ color: "White", status: "AVAILABLE" }],
    });
    const shared = await createVehicle({
      name: `Shared Reserved ${testSuffix}`,
      baseDailyRate: 31,
      units: [{ color: "Grey", status: "RESERVED" }],
    });

    const sourceUnit = source.units[0];
    const maintenanceUnit = target.units[0];
    const freeUnit = target.units[1];
    const blockedUnit = blocked.units[0];
    const openUnit = openTarget.units[0];
    const sharedUnit = shared.units[0];
    const motorcycleUnit = motorcycle.units[0];
    if (!sourceUnit || !maintenanceUnit || !freeUnit || !blockedUnit || !openUnit || !sharedUnit || !motorcycleUnit) {
      throw new Error("Expected test units");
    }

    const booking = await createBooking({
      vehicleId: source.id,
      unitId: sourceUnit.id,
      plate: sourceUnit.licensePlate,
      color: "Red",
      name: source.name,
      pickup: atUtc(10),
      returnAt: atUtc(15),
    });
    const blocker = await createBooking({
      vehicleId: blocked.id,
      unitId: blockedUnit.id,
      plate: blockedUnit.licensePlate,
      color: "White",
      name: blocked.name,
      pickup: atUtc(10),
      returnAt: atUtc(15),
    });
    const storageBooking = await createBooking({
      vehicleId: shared.id,
      unitId: sharedUnit.id,
      plate: sharedUnit.licensePlate,
      color: "Grey",
      name: shared.name,
      pickup: atUtc(1),
      returnAt: atUtc(4),
      storageBoxSelected: true,
    });

    const options = await listChangeBookingVehicleOptions(booking.id);
    assert.equal(options.ok, true);
    if (options.ok) {
      const ids = options.options.vehicles.map((vehicle) => vehicle.id);
      assert.equal(ids.includes(target.id), true);
      assert.equal(ids.includes(noBox.id), true);
      assert.equal(ids.includes(source.id), false);
      assert.equal(ids.includes(blocked.id), false);
      assert.equal(ids.includes(motorcycle.id), false);
      assert.equal(ids.includes(inactive.id), false);
      const targetOption = options.options.vehicles.find((vehicle) => vehicle.id === target.id);
      assert.equal(targetOption?.requiresColor, true);
      assert.deepEqual(
        targetOption?.colors.map((color) => color.label),
        ["Black"],
      );
      assert.equal(options.options.canApplyCatalogPrice, true);
      const reasonFor = (id: string) => options.options.excluded.find((vehicle) => vehicle.id === id)?.reason;
      assert.equal(reasonFor(source.id), "current");
      assert.equal(reasonFor(blocked.id), "unavailable");
      assert.equal(reasonFor(motorcycle.id), "license");
      assert.equal(reasonFor(inactive.id), "inactive");
      assert.equal(reasonFor(noBox.id), undefined);
    }
    logPass("options include only compatible models with a free unit");

    const storageOptions = await listChangeBookingVehicleOptions(storageBooking.id);
    assert.equal(storageOptions.ok, true);
    if (storageOptions.ok) {
      const ids = storageOptions.options.vehicles.map((vehicle) => vehicle.id);
      assert.equal(ids.includes(noBox.id), false);
      assert.equal(ids.includes(target.id), true);
      assert.equal(
        storageOptions.options.excluded.find((vehicle) => vehicle.id === noBox.id)?.reason,
        "storage",
      );
    }
    logPass("a storage-box booking hides models that cannot take a storage box");

    const wrongColor = await changeBookingVehicle(
      booking.id,
      target.id,
      "Red",
      "keep_existing",
      admin.id,
      booking.updatedAt,
    );
    assert.equal(wrongColor.ok, false);
    if (!wrongColor.ok) assert.equal(wrongColor.reason, "invalid_color");
    const afterColor = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    assert.equal(afterColor.vehicleId, source.id);
    assert.equal(afterColor.vehicleColorSnapshot, "Red");
    logPass("an unavailable color is rejected and the booking stays unchanged");

    const unavailable = await changeBookingVehicle(
      booking.id,
      blocked.id,
      "White",
      "keep_existing",
      admin.id,
      afterColor.updatedAt,
    );
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.reason, "no_availability");
    const afterUnavailable = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { unitOccupancies: true },
    });
    assert.equal(afterUnavailable.vehicleId, source.id);
    assert.equal(afterUnavailable.vehicleUnitId, sourceUnit.id);
    assert.equal(afterUnavailable.unitOccupancies[0]?.vehicleUnitId, sourceUnit.id);
    assert.equal(blocker.id.length > 0, true);
    logPass("a fully booked model is rejected and the original unit stays reserved");

    const handedOver = await createBooking({
      vehicleId: motorcycle.id,
      unitId: motorcycleUnit.id,
      plate: motorcycleUnit.licensePlate,
      color: "Black",
      name: motorcycle.name,
      pickup: atUtc(24),
      returnAt: atUtc(26),
      status: "VEHICLE_HANDED_OVER",
    });
    await prisma.vehicleUnit.update({ where: { id: motorcycleUnit.id }, data: { status: "OUT_WITH_CUSTOMER" } });
    const handedResult = await changeBookingVehicle(
      handedOver.id,
      target.id,
      "Black",
      "keep_existing",
      admin.id,
      handedOver.updatedAt,
    );
    assert.equal(handedResult.ok, false);
    if (!handedResult.ok) assert.equal(handedResult.reason, "invalid_status");
    const handedSaved = await prisma.booking.findUniqueOrThrow({ where: { id: handedOver.id } });
    assert.equal(handedSaved.vehicleId, motorcycle.id);
    assert.equal(handedSaved.status, "VEHICLE_HANDED_OVER");
    const handedUnit = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: motorcycleUnit.id } });
    assert.equal(handedUnit.status, "OUT_WITH_CUSTOMER");
    await prisma.vehicleUnit.update({ where: { id: motorcycleUnit.id }, data: { status: "AVAILABLE" } });
    logPass("a handed-over booking cannot change model");

    const completed = await createBooking({
      vehicleId: openTarget.id,
      unitId: openUnit.id,
      plate: openUnit.licensePlate,
      color: "White",
      name: openTarget.name,
      pickup: atUtc(1),
      returnAt: atUtc(3),
      status: "COMPLETED",
      withOccupancy: false,
    });
    const completedResult = await changeBookingVehicle(
      completed.id,
      target.id,
      "Black",
      "keep_existing",
      admin.id,
      completed.updatedAt,
    );
    assert.equal(completedResult.ok, false);
    if (!completedResult.ok) assert.equal(completedResult.reason, "invalid_status");
    logPass("a completed booking cannot change model");

    const stale = await changeBookingVehicle(
      booking.id,
      target.id,
      "Black",
      "keep_existing",
      admin.id,
      new Date(0),
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.reason, "concurrent_update");
    logPass("a stale booking timestamp is rejected");

    const preview = await previewChangeBookingVehicle(booking.id, target.id, "Black", "keep_existing");
    assert.equal(preview.ok, true);
    if (preview.ok) {
      assert.equal(preview.preview.finalSubtotal, 230);
      assert.equal(preview.preview.calculatedSubtotal, 284);
      assert.equal(preview.preview.priceDifference, 54);
      assert.equal(preview.preview.proposedUnitLabel, freeUnit.licensePlate);
      assert.equal(preview.preview.proposedColor, "Black");
      assert.notEqual(preview.preview.proposedUnitLabel, maintenanceUnit.licensePlate);
    }
    logPass("preview keeps the agreed price and proposes a bookable unit of the selected color");

    const changed = await changeBookingVehicle(
      booking.id,
      target.id,
      "Black",
      "keep_existing",
      admin.id,
      afterUnavailable.updatedAt,
    );
    assert.equal(changed.ok, true);
    const saved = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { unitOccupancies: true, statusHistory: true },
    });
    assert.equal(saved.id, booking.id);
    assert.equal(saved.customerFullName, "Change Vehicle Customer");
    assert.equal(saved.pickupDateTime.toISOString(), atUtc(10).toISOString());
    assert.equal(saved.returnDateTime.toISOString(), atUtc(15).toISOString());
    assert.equal(saved.vehicleId, target.id);
    assert.equal(saved.vehicleUnitId, freeUnit.id);
    assert.equal(saved.vehicleNameSnapshot, target.name);
    assert.equal(saved.vehicleColorSnapshot, "Black");
    assert.equal(saved.vehicleLicensePlateSnapshot, freeUnit.licensePlate);
    assert.notEqual(saved.vehicleLicensePlateSnapshot, maintenanceUnit.licensePlate);
    assert.equal(saved.subtotal.toNumber(), 230);
    assert.equal(saved.rentalCost.toNumber(), 180);
    assert.equal(saved.baseDailyRateSnapshot?.toNumber(), 30);
    assert.equal(saved.totalDueOnline.toNumber(), 230);
    assert.equal(saved.cdwTotal.toNumber(), 18);
    assert.equal(saved.unitOccupancies[0]?.vehicleUnitId, freeUnit.id);
    assert.equal(saved.status, "CONFIRMED");
    const sourceUnitAfter = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: sourceUnit.id } });
    assert.equal(sourceUnitAfter.status, "AVAILABLE");
    const freeUnitAfter = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: freeUnit.id } });
    assert.equal(freeUnitAfter.status, "AVAILABLE");
    const oldOccupancy = await prisma.vehicleUnitOccupancy.count({
      where: { bookingId: booking.id, vehicleUnitId: sourceUnit.id },
    });
    assert.equal(oldOccupancy, 0);
    const stripePayments = await prisma.stripePayment.count({ where: { bookingId: booking.id } });
    assert.equal(stripePayments, 0);
    const note = saved.statusHistory.map((entry) => entry.note ?? "").join(" ");
    assert.match(note, /Source PCX/);
    assert.match(note, /Target NMAX/);
    assert.match(note, /kept at EUR 230.00/);
    assert.equal(saved.statusHistory[0]?.changedByAdminId, admin.id);
    logPass("confirmed booking changes model, releases the old unit, and keeps the agreed price");

    const laterShare = await createBooking({
      vehicleId: shared.id,
      unitId: sharedUnit.id,
      plate: sharedUnit.licensePlate,
      color: "Grey",
      name: shared.name,
      pickup: atUtc(20),
      returnAt: atUtc(22),
    });
    const movingShare = await createBooking({
      vehicleId: shared.id,
      unitId: sharedUnit.id,
      plate: sharedUnit.licensePlate,
      color: "Grey",
      name: shared.name,
      pickup: atUtc(10),
      returnAt: atUtc(12),
    });
    const shareTarget = await createVehicle({
      name: `Share Target ${testSuffix}`,
      baseDailyRate: 29,
      units: [{ color: null, status: "AVAILABLE" }],
    });
    const movedShare = await changeBookingVehicle(
      movingShare.id,
      shareTarget.id,
      null,
      "keep_existing",
      admin.id,
      movingShare.updatedAt,
    );
    assert.equal(movedShare.ok, true);
    const sharedAfter = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: sharedUnit.id } });
    assert.equal(sharedAfter.status, "RESERVED");
    const laterStillThere = await prisma.booking.findUniqueOrThrow({ where: { id: laterShare.id } });
    assert.equal(laterStillThere.vehicleUnitId, sharedUnit.id);
    logPass("a reserved unit stays reserved when another booking still occupies it");

    const pricedBooking = await createBooking({
      vehicleId: source.id,
      unitId: sourceUnit.id,
      plate: sourceUnit.licensePlate,
      color: "Red",
      name: source.name,
      pickup: atUtc(16),
      returnAt: atUtc(19),
    });
    await prisma.vehicleUnit.update({ where: { id: sourceUnit.id }, data: { status: "RESERVED" } });
    const priced = await changeBookingVehicle(
      pricedBooking.id,
      noBox.id,
      "Blue",
      "apply_catalog",
      admin.id,
      pricedBooking.updatedAt,
    );
    assert.equal(priced.ok, true);
    const pricedSaved = await prisma.booking.findUniqueOrThrow({ where: { id: pricedBooking.id } });
    assert.equal(pricedSaved.vehicleId, noBox.id);
    assert.equal(pricedSaved.rentalCost.toNumber(), 168);
    assert.equal(pricedSaved.hotelDiscountAmountSnapshot?.toNumber(), 16.8);
    assert.equal(pricedSaved.subtotalAfterHotelDiscountSnapshot?.toNumber(), 151.2);
    assert.equal(pricedSaved.subtotal.toNumber(), 219.2);
    assert.equal(pricedSaved.totalDueOnline.toNumber(), 219.2);
    assert.equal(pricedSaved.totalDueLater.toNumber(), 250);
    assert.equal(pricedSaved.baseDailyRateSnapshot?.toNumber(), 28);
    assert.equal(pricedSaved.appliedDailyRateSnapshot?.toNumber(), 28);
    assert.equal(pricedSaved.cdwTotal.toNumber(), 18);
    assert.equal(pricedSaved.additionalDriverTotal.toNumber(), 30);
    assert.equal(pricedSaved.deliveryTotal.toNumber(), 20);
    assert.equal(pricedSaved.customerEmail, `change-vehicle-${testSuffix}@test.local`);
    logPass("applying the new model rate recalculates rental and hotel discount only");

    const noUnit = await createBooking({
      vehicleId: source.id,
      color: "Red",
      name: source.name,
      pickup: atUtc(27),
      returnAt: atUtc(29),
      status: "PENDING_PAYMENT",
      withOccupancy: false,
    });
    const noUnitChange = await changeBookingVehicle(
      noUnit.id,
      openTarget.id,
      "White",
      "keep_existing",
      admin.id,
      noUnit.updatedAt,
    );
    assert.equal(noUnitChange.ok, true);
    const noUnitSaved = await prisma.booking.findUniqueOrThrow({
      where: { id: noUnit.id },
      include: { unitOccupancies: true },
    });
    assert.equal(noUnitSaved.status, "PENDING_PAYMENT");
    assert.equal(noUnitSaved.vehicleId, openTarget.id);
    assert.equal(noUnitSaved.vehicleUnitId, null);
    assert.equal(noUnitSaved.vehicleColorSnapshot, "White");
    assert.equal(noUnitSaved.vehicleLicensePlateSnapshot, null);
    assert.equal(noUnitSaved.unitOccupancies.length, 0);
    const remaining = await findAvailableVehicleUnits({
      vehicleId: openTarget.id,
      requestedStart: atUtc(27),
      requestedEnd: atUtc(29),
    });
    assert.equal(remaining.length, 0);
    logPass("a booking without a unit updates the model and still holds a fleet slot");

    const licence = await changeBookingVehicle(
      booking.id,
      motorcycle.id,
      "Black",
      "keep_existing",
      admin.id,
      saved.updatedAt,
    );
    assert.equal(licence.ok, false);
    if (!licence.ok) assert.equal(licence.reason, "incompatible_license");
    const storageReject = await changeBookingVehicle(
      storageBooking.id,
      noBox.id,
      "Blue",
      "keep_existing",
      admin.id,
      storageBooking.updatedAt,
    );
    assert.equal(storageReject.ok, false);
    if (!storageReject.ok) assert.equal(storageReject.reason, "incompatible_storage");
    const inactiveReject = await changeBookingVehicle(
      booking.id,
      inactive.id,
      "Green",
      "keep_existing",
      admin.id,
      saved.updatedAt,
    );
    assert.equal(inactiveReject.ok, false);
    if (!inactiveReject.ok) assert.equal(inactiveReject.reason, "vehicle_inactive");
    logPass("licence, storage, and inactive vehicles are rejected on the server");
  } finally {
    await cleanup();
  }
}

/**
 * Dedicated consistency check:
 * change model → old unit/occupancy released → new model/unit locked →
 * handover rejects the old unit and accepts the new unit.
 */
async function runReleaseAndHandoverConsistencyTest(): Promise<void> {
  const { assertSafeScriptDatabase } = await import("./assert-safe-script-database");
  assertSafeScriptDatabase("test-change-booking-vehicle");
  const { prisma } = await import("../src/lib/prisma");
  const { changeBookingVehicle } = await import("../src/lib/admin/bookings/changeBookingVehicle");
  const { handOverVehicle } = await import("../src/lib/admin/bookings/lifecycle/handOverVehicle");
  const { insertBookingOccupancy } = await import("../src/lib/vehicle-unit-occupancy");
  const { findAvailableVehicleUnits } = await import("../src/lib/vehicle-units/findAvailableVehicleUnits");
  const { listAdminVehicleUnits } = await import("../src/lib/admin/vehicle-units/listAdminVehicleUnits");

  const vehicleIds: string[] = [];
  const bookingIds: string[] = [];
  let adminId: string | null = null;

  async function cleanup(): Promise<void> {
    if (bookingIds.length > 0) {
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    if (vehicleIds.length > 0) {
      await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    }
    if (adminId) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }

  function plate(prefix: string): string {
    return `${prefix}${randomBytes(3).toString("hex").toUpperCase()}`.slice(0, 16);
  }

  try {
    const admin = await prisma.adminUser.create({
      data: {
        name: "Change Release Test",
        email: `change-release-${testSuffix}@test.local`,
        role: "STAFF",
      },
    });
    adminId = admin.id;

    const heldSlug = `held-${testSuffix}-${randomBytes(2).toString("hex")}`;
    const nextSlug = `next-${testSuffix}-${randomBytes(2).toString("hex")}`;

    const heldVehicle = await prisma.vehicle.create({
      data: {
        name: `Held Lex Aura ${testSuffix}`,
        slug: heldSlug,
        vehicleType: "Scooter",
        engineCc: 50,
        baseDailyRate: 30,
        isActive: true,
        catalogStatus: "AVAILABLE",
        units: {
          create: [
            {
              licensePlate: plate("HLD"),
              color: "Red",
              status: "RESERVED",
              isActive: true,
            },
          ],
        },
      },
      include: { units: true },
    });
    vehicleIds.push(heldVehicle.id);
    const heldUnit = heldVehicle.units[0];
    if (!heldUnit) throw new Error("Expected held unit");

    const nextVehicle = await prisma.vehicle.create({
      data: {
        name: `Next Blocked Model ${testSuffix}`,
        slug: nextSlug,
        vehicleType: "Scooter",
        engineCc: 50,
        baseDailyRate: 33,
        isActive: true,
        catalogStatus: "AVAILABLE",
        units: {
          create: [
            {
              licensePlate: plate("NXT"),
              color: "Orange",
              status: "AVAILABLE",
              isActive: true,
            },
            {
              licensePlate: plate("NXB"),
              color: "Black",
              status: "MAINTENANCE",
              isActive: true,
            },
          ],
        },
      },
      include: { units: { orderBy: { createdAt: "asc" } } },
    });
    vehicleIds.push(nextVehicle.id);
    const nextUnit = nextVehicle.units.find((unit) => unit.status === "AVAILABLE");
    if (!nextUnit) throw new Error("Expected available replacement unit");

    const pickup = atUtc(3);
    const returnAt = atUtc(5);
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `REL-${randomBytes(4).toString("hex").toUpperCase()}`,
        status: "CONFIRMED",
        vehicleId: heldVehicle.id,
        vehicleUnitId: heldUnit.id,
        vehicleNameSnapshot: heldVehicle.name,
        vehicleLicensePlateSnapshot: heldUnit.licensePlate,
        vehicleColorSnapshot: "Red",
        vehicleType: "Scooter",
        vehicleTypeSnapshot: "Scooter",
        pickupDateTime: pickup,
        returnDateTime: returnAt,
        actualDurationHours: 48,
        billableDays: 3,
        pickupOption: "OFFICE",
        dropoffOption: "OFFICE",
        customerFullName: "Release Consistency Customer",
        customerPhone: "+35699000077",
        customerEmail: `change-release-${testSuffix}@test.local`,
        customerNationality: "Maltese",
        customerDateOfBirth: new Date("1990-01-01"),
        customerLicenseCategory: "B",
        depositMethod: "IN_PERSON",
        depositAmount: 250,
        baseDailyRateSnapshot: 25,
        appliedDailyRateSnapshot: 25,
        rentalCost: 75,
        subtotal: 75,
        totalDueOnline: 75,
        totalDueLater: 250,
      },
    });
    bookingIds.push(booking.id);
    await insertBookingOccupancy(prisma, {
      vehicleUnitId: heldUnit.id,
      pickupAt: pickup,
      returnAt,
      bookingId: booking.id,
    });

    const beforeChange = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: { unitOccupancies: true },
    });
    assert.equal(beforeChange.vehicleId, heldVehicle.id);
    assert.equal(beforeChange.vehicleUnitId, heldUnit.id);
    assert.equal(beforeChange.unitOccupancies[0]?.vehicleUnitId, heldUnit.id);

    const changed = await changeBookingVehicle(
      booking.id,
      nextVehicle.id,
      "Orange",
      "keep_existing",
      admin.id,
      beforeChange.updatedAt,
    );
    assert.equal(changed.ok, true);

    const afterChange = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: {
        vehicle: { select: { id: true, name: true } },
        vehicleUnit: { select: { id: true, vehicleId: true, licensePlate: true, color: true, status: true } },
        unitOccupancies: true,
      },
    });

    assert.equal(afterChange.vehicleId, nextVehicle.id);
    assert.equal(afterChange.vehicle?.id, nextVehicle.id);
    assert.equal(afterChange.vehicleNameSnapshot, nextVehicle.name);
    assert.equal(afterChange.vehicleUnitId, nextUnit.id);
    assert.equal(afterChange.vehicleUnit?.id, nextUnit.id);
    assert.equal(afterChange.vehicleUnit?.vehicleId, nextVehicle.id);
    assert.equal(afterChange.vehicleLicensePlateSnapshot, nextUnit.licensePlate);
    assert.equal(afterChange.vehicleColorSnapshot, "Orange");
    assert.notEqual(afterChange.vehicleUnitId, heldUnit.id);
    assert.notEqual(afterChange.vehicleId, heldVehicle.id);

    assert.equal(afterChange.unitOccupancies.length, 1);
    assert.equal(afterChange.unitOccupancies[0]?.vehicleUnitId, nextUnit.id);
    assert.equal(afterChange.unitOccupancies[0]?.bookingId, booking.id);

    const heldOccupancyLeft = await prisma.vehicleUnitOccupancy.count({
      where: { bookingId: booking.id, vehicleUnitId: heldUnit.id },
    });
    assert.equal(heldOccupancyLeft, 0);
    const heldUnitLinks = await prisma.booking.count({
      where: { vehicleUnitId: heldUnit.id, status: { in: ["PENDING_PAYMENT", "CONFIRMED", "VEHICLE_HANDED_OVER", "RETURNED"] } },
    });
    assert.equal(heldUnitLinks, 0);

    const heldUnitAfter = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: heldUnit.id } });
    assert.equal(heldUnitAfter.status, "AVAILABLE");
    assert.equal(heldUnitAfter.vehicleId, heldVehicle.id);

    const nextUnitAfter = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: nextUnit.id } });
    assert.equal(nextUnitAfter.vehicleId, nextVehicle.id);
    assert.ok(["AVAILABLE", "RESERVED"].includes(nextUnitAfter.status));

    const heldStillFree = await findAvailableVehicleUnits({
      vehicleId: heldVehicle.id,
      requestedStart: pickup,
      requestedEnd: returnAt,
    });
    assert.equal(heldStillFree.some((unit) => unit.id === heldUnit.id), true);

    const nextStillLocked = await findAvailableVehicleUnits({
      vehicleId: nextVehicle.id,
      requestedStart: pickup,
      requestedEnd: returnAt,
    });
    assert.equal(nextStillLocked.some((unit) => unit.id === nextUnit.id), false);

    const adminUnits = await listAdminVehicleUnits(afterChange.vehicleId!);
    assert.equal(adminUnits.every((unit) => unit.vehicleId === nextVehicle.id), true);
    assert.equal(adminUnits.some((unit) => unit.id === nextUnit.id), true);
    assert.equal(adminUnits.some((unit) => unit.id === heldUnit.id), false);

    const staleFormUnitId = resolveHandOverVehicleUnitId({
      formVehicleUnitId: heldUnit.id,
      bookingVehicleUnitId: afterChange.vehicleUnitId,
      selectableUnitIds: adminUnits
        .filter((unit) => unit.isActive && (unit.id === afterChange.vehicleUnitId || unit.status === "AVAILABLE"))
        .map((unit) => unit.id),
    });
    assert.equal(staleFormUnitId, nextUnit.id);
    assert.notEqual(staleFormUnitId, heldUnit.id);

    const staleHandOver = await handOverVehicle(
      booking.id,
      {
        paymentReceivedAmount: 75,
        paymentMethod: "CASH",
        paymentConfirmed: true,
        securityDepositCollectedAmount: 250,
        depositCollectedConfirmed: true,
        handoverDateTime: new Date(),
        handoverNotes: "stale unit attempt",
        vehicleUnitId: heldUnit.id,
      },
      admin.id,
    );
    assert.equal(staleHandOver.ok, false);
    if (!staleHandOver.ok) {
      assert.equal(staleHandOver.reason, "vehicle_unit_mismatch");
    }
    const stillConfirmed = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    assert.equal(stillConfirmed.status, "CONFIRMED");
    assert.equal(stillConfirmed.vehicleId, nextVehicle.id);
    assert.equal(stillConfirmed.vehicleUnitId, nextUnit.id);

    const handOver = await handOverVehicle(
      booking.id,
      {
        paymentReceivedAmount: 75,
        paymentMethod: "CASH",
        paymentConfirmed: true,
        securityDepositCollectedAmount: 250,
        depositCollectedConfirmed: true,
        handoverDateTime: new Date(),
        handoverNotes: "handover after model change",
        vehicleUnitId: nextUnit.id,
      },
      admin.id,
    );
    assert.equal(handOver.ok, true);

    const afterHandOver = await prisma.booking.findUniqueOrThrow({
      where: { id: booking.id },
      include: {
        vehicleUnit: true,
        unitOccupancies: true,
      },
    });
    assert.equal(afterHandOver.status, "VEHICLE_HANDED_OVER");
    assert.equal(afterHandOver.vehicleId, nextVehicle.id);
    assert.equal(afterHandOver.vehicleUnitId, nextUnit.id);
    assert.equal(afterHandOver.vehicleUnit?.status, "OUT_WITH_CUSTOMER");
    assert.equal(afterHandOver.vehicleLicensePlateSnapshot, nextUnit.licensePlate);
    assert.equal(afterHandOver.unitOccupancies[0]?.vehicleUnitId, nextUnit.id);

    const heldUnitFinal = await prisma.vehicleUnit.findUniqueOrThrow({ where: { id: heldUnit.id } });
    assert.equal(heldUnitFinal.status, "AVAILABLE");
    assert.equal(heldUnitFinal.vehicleId, heldVehicle.id);

    logPass("vehicle change releases the old unit lock and lets handover use only the new unit");
  } finally {
    await cleanup();
  }
}

async function main(): Promise<void> {
  runPureTests();
  await runDatabaseTests();
  await runReleaseAndHandoverConsistencyTest();
  console.log("change booking vehicle tests PASS");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
