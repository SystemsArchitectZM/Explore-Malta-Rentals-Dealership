import "dotenv/config";

import type { BookableHelmetSize } from "../src/lib/booking/helmet-sizes";
import { prisma } from "../src/lib/prisma";
import { assertSafeScriptDatabase } from "./assert-safe-script-database";

const BASE_URL = (process.env.HOLD_TEST_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const TEST_EMAIL = "reservation-hold-test@example.com";
const TEST_NAME = "Reservation Hold Test";

type JsonObject = Record<string, unknown>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isoDate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

async function ensureServerReachable(): Promise<void> {
  try {
    await fetch(`${BASE_URL}/api/vehicles`);
  } catch {
    throw new Error(`Cannot reach ${BASE_URL}. Start the app first (npm run dev).`);
  }
}

async function postJson(path: string, payload?: JsonObject): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const body = (await response.json()) as JsonObject;
  return { status: response.status, body };
}

async function getJson(path: string): Promise<{ status: number; body: JsonObject }> {
  const response = await fetch(`${BASE_URL}${path}`);
  const body = (await response.json()) as JsonObject;
  return { status: response.status, body };
}

function bookingFieldsForVehicleType(vehicleType: string): {
  licenseCategory: "AM" | "A1" | "A2" | "A" | "B";
  helmetSize1: BookableHelmetSize | null;
  helmetSize2: BookableHelmetSize | null;
} {
  if (vehicleType === "Scooter") {
    return { licenseCategory: "B", helmetSize1: "M", helmetSize2: "L" };
  }
  if (vehicleType === "Motorcycle") {
    return { licenseCategory: "A1", helmetSize1: "M", helmetSize2: "L" };
  }
  if (vehicleType === "ATV") {
    return { licenseCategory: "B", helmetSize1: "M", helmetSize2: "L" };
  }
  return { licenseCategory: "B", helmetSize1: null, helmetSize2: null };
}

function buildHoldPayload(input: {
  vehicleId: string;
  vehicleType: string;
  pickupDate: string;
  returnDate: string;
  sessionKey: string;
}): JsonObject {
  return {
    vehicleId: input.vehicleId,
    vehicleType: input.vehicleType,
    pickupDate: input.pickupDate,
    pickupTime: "10:00",
    returnDate: input.returnDate,
    returnTime: "10:00",
    sessionKey: input.sessionKey,
    customerEmail: TEST_EMAIL,
    customerName: TEST_NAME,
  };
}

function buildBookingPayload(input: {
  vehicleId: string;
  vehicleType: string;
  pickupDate: string;
  returnDate: string;
  holdReference?: string;
}): JsonObject {
  const bookingFields = bookingFieldsForVehicleType(input.vehicleType);
  return {
    rental: {
      vehicleId: input.vehicleId,
      vehicleType: input.vehicleType,
      pickupDate: input.pickupDate,
      pickupTime: "10:00",
      returnDate: input.returnDate,
      returnTime: "10:00",
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
      helmetSize1: bookingFields.helmetSize1,
      helmetSize2: bookingFields.helmetSize2,
      storageBoxSelected: false,
    },
    customer: {
      fullName: TEST_NAME,
      phone: "+35699123456",
      email: TEST_EMAIL,
      nationality: "Maltese",
      dateOfBirth: "1990-01-01",
      licenseCategory: bookingFields.licenseCategory,
      specialNotes: "Reservation hold automated test",
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
    deposit: {
      depositMethod: "ONLINE",
    },
    consent: {
      termsAccepted: true,
      termsAcceptedAt: new Date().toISOString(),
    },
  };
}

async function cleanupTestData() {
  await prisma.$executeRawUnsafe(
    'DELETE FROM "ReservationHold" WHERE "customerEmail" = $1 OR "sessionKey" LIKE $2',
    TEST_EMAIL,
    "hold-test-%",
  );
  await prisma.$executeRawUnsafe(
    'DELETE FROM "Booking" WHERE "customerEmail" = $1 AND "customerSpecialNotes" = $2',
    TEST_EMAIL,
    "Reservation hold automated test",
  );
}

async function main() {
  assertSafeScriptDatabase("test-reservation-holds");
  await ensureServerReachable();
  await cleanupTestData();

  const vehicleRows = (await prisma.$queryRawUnsafe(
    'SELECT "id", "vehicleType", "name" FROM "Vehicle" WHERE "isActive" = TRUE ORDER BY "displayOrder" ASC, "createdAt" ASC LIMIT 1',
  )) as Array<{ id: string; vehicleType: string; name: string }>;
  const vehicle = vehicleRows[0];
  assert(vehicle, "No active vehicle found for scenario testing.");

  const windows = [
    { pickupDate: isoDate(2099, 11, 1), returnDate: isoDate(2099, 11, 3) }, // A/B/C/H
    { pickupDate: isoDate(2099, 11, 10), returnDate: isoDate(2099, 11, 12) }, // D
    { pickupDate: isoDate(2099, 11, 15), returnDate: isoDate(2099, 11, 17) }, // E
    { pickupDate: isoDate(2099, 11, 20), returnDate: isoDate(2099, 11, 22) }, // F
    { pickupDate: isoDate(2099, 11, 25), returnDate: isoDate(2099, 11, 27) }, // G
  ];

  console.log(`Testing reservation holds on vehicle: ${vehicle.name} (${vehicle.id})`);

  // A) Create hold on available vehicle succeeds.
  const createA = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[0].pickupDate,
      returnDate: windows[0].returnDate,
      sessionKey: "hold-test-a",
    }),
  );
  assert(createA.status === 200, `A failed: expected 200, got ${createA.status} ${JSON.stringify(createA.body)}`);
  const holdA = String(createA.body.holdReference);
  const expiresA = new Date(String(createA.body.expiresAt));
  assert(holdA.length > 0, "A failed: holdReference missing.");
  console.log("A PASS");

  // B) Second user cannot create overlapping hold while first is active.
  const createB = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[0].pickupDate,
      returnDate: windows[0].returnDate,
      sessionKey: "hold-test-b",
    }),
  );
  assert(createB.status === 409, `B failed: expected 409, got ${createB.status} ${JSON.stringify(createB.body)}`);
  console.log("B PASS");

  // C) Heartbeat extends expiresAt.
  const heartbeatC = await postJson(`/api/reservation-holds/${holdA}/heartbeat`);
  assert(heartbeatC.status === 200, `C failed: heartbeat status ${heartbeatC.status} ${JSON.stringify(heartbeatC.body)}`);
  const expiresC = new Date(String(heartbeatC.body.expiresAt));
  assert(expiresC.getTime() > expiresA.getTime(), "C failed: expiresAt was not extended.");
  console.log("C PASS");

  // H) Availability checks now consider active holds.
  const availabilityH = await getJson(
    `/api/availability?vehicleId=${encodeURIComponent(vehicle.id)}&pickupDate=${windows[0].pickupDate}&pickupTime=10:00&returnDate=${windows[0].returnDate}&returnTime=10:00`,
  );
  assert(availabilityH.status === 200, `H failed: availability status ${availabilityH.status}`);
  assert(availabilityH.body.isAvailable === false, `H failed: expected unavailable, got ${JSON.stringify(availabilityH.body)}`);
  assert(
    availabilityH.body.availabilityStatus === "reserved_temporarily",
    `H failed: expected reserved_temporarily, got ${String(availabilityH.body.availabilityStatus)}`,
  );
  console.log("H PASS");

  // D) Expired hold no longer blocks.
  const createD1 = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[1].pickupDate,
      returnDate: windows[1].returnDate,
      sessionKey: "hold-test-d1",
    }),
  );
  assert(createD1.status === 200, `D setup failed: ${createD1.status} ${JSON.stringify(createD1.body)}`);
  const holdD1 = String(createD1.body.holdReference);
  await prisma.$executeRawUnsafe(
    'UPDATE "ReservationHold" SET "expiresAt" = NOW() - INTERVAL \'1 minute\' WHERE "holdReference" = $1',
    holdD1,
  );
  const createD2 = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[1].pickupDate,
      returnDate: windows[1].returnDate,
      sessionKey: "hold-test-d2",
    }),
  );
  assert(createD2.status === 200, `D failed: expected second hold to pass, got ${createD2.status}`);
  console.log("D PASS");

  // E) Released hold no longer blocks.
  const createE1 = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[2].pickupDate,
      returnDate: windows[2].returnDate,
      sessionKey: "hold-test-e1",
    }),
  );
  assert(createE1.status === 200, `E setup failed: ${createE1.status} ${JSON.stringify(createE1.body)}`);
  const holdE1 = String(createE1.body.holdReference);
  const releaseE = await postJson(`/api/reservation-holds/${holdE1}/release`);
  assert(releaseE.status === 200, `E release failed: ${releaseE.status} ${JSON.stringify(releaseE.body)}`);
  const createE2 = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[2].pickupDate,
      returnDate: windows[2].returnDate,
      sessionKey: "hold-test-e2",
    }),
  );
  assert(createE2.status === 200, `E failed: second hold should succeed after release, got ${createE2.status}`);
  console.log("E PASS");

  // F) Booking submission with valid hold succeeds and converts hold.
  const createF = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[3].pickupDate,
      returnDate: windows[3].returnDate,
      sessionKey: "hold-test-f",
    }),
  );
  assert(createF.status === 200, `F setup failed: ${createF.status} ${JSON.stringify(createF.body)}`);
  const holdF = String(createF.body.holdReference);
  const bookingF = await postJson(
    "/api/bookings",
    buildBookingPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[3].pickupDate,
      returnDate: windows[3].returnDate,
      holdReference: holdF,
    }),
  );
  assert(bookingF.status === 200, `F failed: booking should succeed, got ${bookingF.status} ${JSON.stringify(bookingF.body)}`);
  const holdStatusF = await getJson(`/api/reservation-holds/${holdF}`);
  assert(holdStatusF.status === 200, `F failed: could not fetch hold status, ${holdStatusF.status}`);
  assert(
    holdStatusF.body.status === "CONVERTED",
    `F failed: expected CONVERTED hold status, got ${String(holdStatusF.body.status)}`,
  );
  console.log("F PASS");

  // G) Booking submission with expired hold fails.
  const createG = await postJson(
    "/api/reservation-holds",
    buildHoldPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[4].pickupDate,
      returnDate: windows[4].returnDate,
      sessionKey: "hold-test-g",
    }),
  );
  assert(createG.status === 200, `G setup failed: ${createG.status} ${JSON.stringify(createG.body)}`);
  const holdG = String(createG.body.holdReference);
  await prisma.$executeRawUnsafe(
    'UPDATE "ReservationHold" SET "expiresAt" = NOW() - INTERVAL \'1 minute\' WHERE "holdReference" = $1',
    holdG,
  );
  const bookingG = await postJson(
    "/api/bookings",
    buildBookingPayload({
      vehicleId: vehicle.id,
      vehicleType: vehicle.vehicleType,
      pickupDate: windows[4].pickupDate,
      returnDate: windows[4].returnDate,
      holdReference: holdG,
    }),
  );
  assert(bookingG.status === 409, `G failed: expected 409 on expired hold, got ${bookingG.status} ${JSON.stringify(bookingG.body)}`);
  console.log("G PASS");

  await cleanupTestData();
  console.log("All reservation hold scenarios passed: A, B, C, D, E, F, G, H");
}

main().catch(async (error) => {
  await cleanupTestData().catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
