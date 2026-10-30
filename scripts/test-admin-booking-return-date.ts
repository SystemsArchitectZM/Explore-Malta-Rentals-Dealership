/**
 * Admin booking list return-date filter.
 *
 * Run: npm run test:admin-booking-return-date
 *
 * The filter uses Booking.returnDateTime (the current schedule, including extensions)
 * and Europe/Malta calendar-day bounds.
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import type { BookingStatus } from "../src/generated/prisma/index";
import { adminBookingListQuerySchema } from "../src/lib/admin/bookings/booking-schema";
import { extendBooking } from "../src/lib/admin/bookings/extendBooking";
import {
  isMaltaCalendarDateKey,
  maltaCalendarDateKey,
  maltaCalendarDayRange,
  maltaDateTimeToUtc,
} from "../src/lib/admin/bookings/extension-calendar-days";
import { listAdminBookings } from "../src/lib/admin/bookings/listAdminBookings";
import type { AdminBookingListFilters } from "../src/lib/admin/bookings/types";
import { replaceBookingVehicle } from "../src/lib/admin/bookings/replaceBookingVehicle";
import { formatMaltaDateTime } from "../src/lib/format-malta-datetime";
import { prisma } from "../src/lib/prisma";
import { assertSafeScriptDatabase } from "./assert-safe-script-database";
import { insertBookingOccupancy } from "../src/lib/vehicle-unit-occupancy";

const FILTER_DAY = "2026-10-25";
const NEXT_DAY = "2026-10-26";
const EXTENDED_DAY = "2026-10-28";
const token = randomBytes(4).toString("hex");
const searchToken = `RTD${token}`;

function at(dateKey: string, time: string): Date {
  const instant = maltaDateTimeToUtc(dateKey, time);
  if (!instant) {
    throw new Error(`Could not build Malta instant ${dateKey} ${time}`);
  }
  return instant;
}

function assertSchema(): void {
  assert.equal(adminBookingListQuerySchema.safeParse({ returnDate: FILTER_DAY }).success, true);
  assert.equal(adminBookingListQuerySchema.safeParse({}).success, true);
  assert.equal(adminBookingListQuerySchema.safeParse({ returnDate: "2026-02-31" }).success, false);
  assert.equal(adminBookingListQuerySchema.safeParse({ returnDate: "2026-02-29" }).success, false);
  assert.equal(adminBookingListQuerySchema.safeParse({ returnDate: "2024-02-29" }).success, true);
  assert.equal(adminBookingListQuerySchema.safeParse({ returnDate: "25-10-2026" }).success, false);
  assert.equal(adminBookingListQuerySchema.safeParse({ returnDate: "" }).success, false);
  assert.equal(isMaltaCalendarDateKey(FILTER_DAY), true);
  assert.equal(maltaCalendarDayRange("not-a-date"), null);
  assert.equal(maltaCalendarDayRange("2026-13-01"), null);
}

function assertDayBounds(): void {
  const range = maltaCalendarDayRange(FILTER_DAY);
  assert.ok(range);
  const start = at(FILTER_DAY, "00:00");
  const end = at(NEXT_DAY, "00:00");
  assert.equal(range.start.toISOString(), start.toISOString());
  assert.equal(range.end.toISOString(), end.toISOString());
  assert.ok(range.end.getTime() - range.start.getTime() > 24 * 60 * 60 * 1000, "25 Oct 2026 includes the DST fallback hour");

  const shownOnFilterDay = new Date("2026-10-24T22:30:00.000Z");
  const shownOnPreviousDay = new Date("2026-10-24T21:30:00.000Z");
  assert.equal(maltaCalendarDateKey(shownOnFilterDay), FILTER_DAY);
  assert.match(formatMaltaDateTime(shownOnFilterDay.toISOString()), /25 Oct 2026/);
  assert.equal(maltaCalendarDateKey(shownOnPreviousDay), "2026-10-24");
  assert.ok(shownOnFilterDay >= range.start && shownOnFilterDay < range.end);
  assert.ok(shownOnPreviousDay < range.start);
  assert.ok(end.getTime() === range.end.getTime());
}

async function listed(filters: AdminBookingListFilters = {}) {
  return listAdminBookings({
    pageSize: 100,
    ...filters,
    search: filters.search ?? searchToken,
  });
}

async function run(): Promise<void> {
  assertSchema();
  assertDayBounds();
  assertSafeScriptDatabase("test-admin-booking-return-date");

  const bookingIds: string[] = [];
  let vehicleId: string | null = null;
  let adminId: string | null = null;

  async function createBooking(input: {
    referenceSuffix: string;
    pickup: Date;
    returnAt: Date;
    status?: BookingStatus;
    customerFullName?: string;
    billableDays?: number;
    createdAt?: Date;
    vehicleId?: string;
    vehicleUnitId?: string;
    licensePlate?: string;
    withOccupancy?: boolean;
  }) {
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `${searchToken}-${input.referenceSuffix}`,
        status: input.status ?? "CONFIRMED",
        vehicleId: input.vehicleId,
        vehicleUnitId: input.vehicleUnitId,
        vehicleNameSnapshot: input.vehicleId ? "Return Date Scooter" : null,
        vehicleLicensePlateSnapshot: input.licensePlate,
        vehicleType: "Scooter",
        vehicleTypeSnapshot: "Scooter",
        pickupDateTime: input.pickup,
        returnDateTime: input.returnAt,
        actualDurationHours: 6,
        billableDays: input.billableDays ?? 1,
        pickupOption: "OFFICE",
        dropoffOption: "OFFICE",
        customerFullName: input.customerFullName ?? `Return Filter ${token}`,
        customerPhone: "+35699000107",
        customerEmail: `return-date-${token}@test.local`,
        customerNationality: "Maltese",
        customerDateOfBirth: new Date("1990-01-01"),
        customerLicenseCategory: "B",
        depositMethod: "IN_PERSON",
        depositAmount: 100,
        baseDailyRateSnapshot: 30,
        appliedDailyRateSnapshot: 30,
        rentalCost: 30,
        subtotal: 30,
        totalDueOnline: 30,
        totalDueLater: 100,
        createdAt: input.createdAt,
      },
    });
    bookingIds.push(booking.id);
    if (input.withOccupancy && input.vehicleUnitId) {
      await insertBookingOccupancy(prisma, {
        vehicleUnitId: input.vehicleUnitId,
        pickupAt: input.pickup,
        returnAt: input.returnAt,
        bookingId: booking.id,
      });
    }
    return booking;
  }

  try {
    const morning = await createBooking({
      referenceSuffix: "0800",
        pickup: at("2026-10-24", "09:00"),
        returnAt: at(FILTER_DAY, "08:00"),
        createdAt: new Date("2026-03-01T00:00:00.000Z"),
      });
    const afternoon = await createBooking({
      referenceSuffix: "1300",
      pickup: at(FILTER_DAY, "09:00"),
      returnAt: at(FILTER_DAY, "13:00"),
      status: "VEHICLE_HANDED_OVER",
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const late = await createBooking({
      referenceSuffix: "2300",
      pickup: at(FILTER_DAY, "12:00"),
      returnAt: at(FILTER_DAY, "23:00"),
      status: "CANCELLED",
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
    });
    const nextDay = await createBooking({
      referenceSuffix: "nextday",
      pickup: at(FILTER_DAY, "18:00"),
      returnAt: at(NEXT_DAY, "10:00"),
    });
    const sameDayShort = await createBooking({
      referenceSuffix: "short",
        pickup: at(FILTER_DAY, "09:00"),
        returnAt: at(FILTER_DAY, "15:00"),
        billableDays: 1,
        customerFullName: `Ada ${token}`,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      });
    const boundaryInside = await createBooking({
      referenceSuffix: "boundary-in",
      pickup: at("2026-10-24", "18:00"),
      returnAt: new Date("2026-10-24T22:30:00.000Z"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const boundaryOutside = await createBooking({
      referenceSuffix: "boundary-out",
      pickup: at("2026-10-24", "12:00"),
      returnAt: new Date("2026-10-24T21:30:00.000Z"),
    });
    const nextMidnight = await createBooking({
      referenceSuffix: "next-midnight",
      pickup: at(FILTER_DAY, "20:00"),
      returnAt: at(NEXT_DAY, "00:00"),
    });

    const onFilterDay = await listed({ returnDate: FILTER_DAY });
    const matched = new Set(onFilterDay.items.map((item) => item.id));
    assert.equal(onFilterDay.total, 5);
    assert.ok(matched.has(morning.id));
    assert.ok(matched.has(afternoon.id));
    assert.ok(matched.has(late.id));
    assert.ok(matched.has(sameDayShort.id));
    assert.ok(matched.has(boundaryInside.id));
    assert.equal(matched.has(nextDay.id), false);
    assert.equal(matched.has(boundaryOutside.id), false);
    assert.equal(matched.has(nextMidnight.id), false);
    assert.deepEqual(
      onFilterDay.items.map((item) => item.id),
      [late.id, afternoon.id, morning.id, sameDayShort.id, boundaryInside.id],
    );
    const createdOrder = [...onFilterDay.items];
    for (let index = 1; index < createdOrder.length; index += 1) {
      assert.ok(createdOrder[index - 1]!.createdAt >= createdOrder[index]!.createdAt);
    }

    const otherDay = await listed({ returnDate: NEXT_DAY });
    const otherIds = new Set(otherDay.items.map((item) => item.id));
    assert.ok(otherIds.has(nextDay.id));
    assert.ok(otherIds.has(nextMidnight.id));
    assert.equal(otherIds.has(morning.id), false);
    assert.equal(otherIds.has(sameDayShort.id), false);

    const handedOver = await listed({
      returnDate: FILTER_DAY,
      status: "VEHICLE_HANDED_OVER",
    });
    assert.deepEqual(
      handedOver.items.map((item) => item.id),
      [afternoon.id],
    );

    const named = await listed({
      returnDate: FILTER_DAY,
      search: `Ada ${token}`,
    });
    assert.deepEqual(
      named.items.map((item) => item.id),
      [sameDayShort.id],
    );
    const namedOnWrongDay = await listed({
      returnDate: NEXT_DAY,
      search: `Ada ${token}`,
    });
    assert.equal(namedOnWrongDay.total, 0);

    const pageOne = await listAdminBookings({
      search: searchToken,
      returnDate: FILTER_DAY,
      page: 1,
      pageSize: 2,
    });
    const pageTwo = await listAdminBookings({
      search: searchToken,
      returnDate: FILTER_DAY,
      page: 2,
      pageSize: 2,
    });
    assert.equal(pageOne.total, 5);
    assert.equal(pageOne.totalPages, 3);
    assert.equal(pageOne.items.length, 2);
    assert.equal(pageTwo.items.length, 2);
    assert.deepEqual(
      pageOne.items.map((item) => item.id),
      [late.id, afternoon.id],
    );
    const pageIds = new Set([...pageOne.items, ...pageTwo.items].map((item) => item.id));
    assert.equal(pageIds.size, 4);
    assert.equal(pageIds.has(nextDay.id), false);

    const cleared = await listed();
    const clearedIds = new Set(cleared.items.map((item) => item.id));
    assert.ok(clearedIds.has(nextDay.id));
    assert.ok(clearedIds.has(boundaryOutside.id));
    assert.ok(cleared.total > onFilterDay.total);

    const malformed = await listed({ returnDate: "2026-02-31" });
    assert.equal(malformed.total, cleared.total);
    const blank = await listed({ returnDate: "" });
    assert.equal(blank.total, cleared.total);
    const garbage = await listed({ returnDate: "not-a-date" });
    assert.equal(garbage.total, cleared.total);

    const admin = await prisma.adminUser.create({
      data: {
        name: "Return Date Test",
        email: `return-date-${token}@test.local`,
        passwordHash: "test-only",
        role: "STAFF",
      },
    });
    adminId = admin.id;

    const slug = `return-date-${token}`;
    const vehicle = await prisma.vehicle.create({
      data: {
        name: `Return Date Scooter ${token}`,
        slug,
        vehicleType: "Scooter",
        engineCc: 50,
        baseDailyRate: 30,
        isActive: true,
        units: {
          create: [
            {
              licensePlate: `RD1${token}`.slice(0, 16),
              status: "OUT_WITH_CUSTOMER",
              isActive: true,
            },
            {
              licensePlate: `RD2${token}`.slice(0, 16),
              status: "AVAILABLE",
              isActive: true,
            },
          ],
        },
      },
      include: { units: { orderBy: { createdAt: "asc" } } },
    });
    vehicleId = vehicle.id;
    const [currentUnit, replacementUnit] = vehicle.units;
    if (!currentUnit || !replacementUnit) {
      throw new Error("Expected two units");
    }

    const extended = await createBooking({
      referenceSuffix: "extend",
      pickup: at("2026-10-22", "10:00"),
      returnAt: at(FILTER_DAY, "10:00"),
      status: "VEHICLE_HANDED_OVER",
      billableDays: 4,
      vehicleId: vehicle.id,
      vehicleUnitId: currentUnit.id,
      licensePlate: currentUnit.licensePlate,
      withOccupancy: true,
    });
    assert.ok((await listed({ returnDate: FILTER_DAY })).items.some((item) => item.id === extended.id));

    const extension = await extendBooking(
      extended.id,
      at(EXTENDED_DAY, "10:00"),
      admin.id,
      extended.updatedAt,
    );
    assert.equal(extension.ok, true, extension.ok ? "" : extension.reason);
    const afterExtension = await prisma.booking.findUniqueOrThrow({
      where: { id: extended.id },
      select: { returnDateTime: true },
    });
    assert.equal(afterExtension.returnDateTime.toISOString(), at(EXTENDED_DAY, "10:00").toISOString());
    assert.equal(
      (await listed({ returnDate: FILTER_DAY })).items.some((item) => item.id === extended.id),
      false,
    );
    assert.ok((await listed({ returnDate: EXTENDED_DAY })).items.some((item) => item.id === extended.id));

    const replaced = await createBooking({
      referenceSuffix: "replace",
      pickup: at("2026-10-24", "09:00"),
      returnAt: at(FILTER_DAY, "18:00"),
      status: "VEHICLE_HANDED_OVER",
      billableDays: 2,
      vehicleId: vehicle.id,
      vehicleUnitId: replacementUnit.id,
      licensePlate: replacementUnit.licensePlate,
      withOccupancy: true,
    });
    const spare = await prisma.vehicleUnit.create({
      data: {
        vehicleId: vehicle.id,
        licensePlate: `RD3${token}`.slice(0, 16),
        status: "AVAILABLE",
        isActive: true,
      },
    });
    const replacement = await replaceBookingVehicle(
      replaced.id,
      {
        vehicleUnitId: spare.id,
        previousUnitStatus: "MAINTENANCE",
        reason: "mechanical_issue",
        note: "Return date filter check",
        expectedUpdatedAt: replaced.updatedAt,
        expectedVehicleUnitId: replacementUnit.id,
      },
      admin.id,
    );
    assert.equal(replacement.ok, true, replacement.ok ? "" : replacement.reason);
    const afterReplacement = await prisma.booking.findUniqueOrThrow({
      where: { id: replaced.id },
      select: { returnDateTime: true, vehicleAssignments: { select: { endedAt: true } } },
    });
    assert.equal(afterReplacement.returnDateTime.toISOString(), at(FILTER_DAY, "18:00").toISOString());
    assert.ok(afterReplacement.vehicleAssignments.some((assignment) => assignment.endedAt !== null));
    assert.ok((await listed({ returnDate: FILTER_DAY })).items.some((item) => item.id === replaced.id));

    const assignmentDecoy = await createBooking({
      referenceSuffix: "assignment-decoy",
      pickup: at(FILTER_DAY, "09:00"),
      returnAt: at(NEXT_DAY, "18:00"),
      vehicleId: vehicle.id,
      vehicleUnitId: currentUnit.id,
      licensePlate: currentUnit.licensePlate,
    });
    await prisma.bookingVehicleAssignment.create({
      data: {
        bookingId: assignmentDecoy.id,
        vehicleId: vehicle.id,
        vehicleUnitId: currentUnit.id,
        vehicleNameSnapshot: "Return Date Scooter",
        licensePlateSnapshot: currentUnit.licensePlate,
        vehicleTypeSnapshot: "Scooter",
        startedAt: at(FILTER_DAY, "09:00"),
        endedAt: at(FILTER_DAY, "12:00"),
        endDisposition: "MAINTENANCE",
        reason: "mechanical_issue",
      },
    });
    assert.equal(
      (await listed({ returnDate: FILTER_DAY })).items.some((item) => item.id === assignmentDecoy.id),
      false,
    );
    assert.ok((await listed({ returnDate: NEXT_DAY })).items.some((item) => item.id === assignmentDecoy.id));

    console.log("admin booking return-date filter PASS");
  } finally {
    if (bookingIds.length > 0) {
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    if (vehicleId) {
      await prisma.vehicle.delete({ where: { id: vehicleId } }).catch(() => undefined);
    }
    if (adminId) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
  process.exit(0);
}

run().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
