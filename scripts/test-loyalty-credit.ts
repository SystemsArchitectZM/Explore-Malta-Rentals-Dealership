/**
 * €5 next-rental loyalty credit.
 *
 * Run: npm run test:loyalty-credit
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { addDays } from "date-fns";

import type { BookingSubmissionInput } from "../src/lib/booking";
import { submitBooking } from "../src/lib/booking";
import { releaseUnpaidBooking } from "../src/lib/booking/releaseUnpaidBooking";
import { buildBookingConfirmationEmail } from "../src/lib/email/buildBookingConfirmationEmail";
import { buildPostRentalReviewEmail } from "../src/lib/email/buildPostRentalReviewEmail";
import type { SendEmailResult } from "../src/lib/email/types";
import { calculateVehicleChangePrice } from "../src/lib/admin/bookings/calculate-vehicle-change-price";
import { getAdminBookingById } from "../src/lib/admin/bookings/getAdminBookingById";
import { cancelBooking, completeBooking, markVehicleReturned } from "../src/lib/admin/bookings/lifecycle";
import {
  buildLoyaltyCreditEmailSection,
  chargesAfterLoyalty,
  findAvailableLoyaltyCreditOffer,
  issueLoyaltyCreditForReturnedBooking,
  loyaltyDiscountForCharges,
  normalizeLoyaltyCustomerEmail,
  redeemOldestAvailableLoyaltyCredit,
} from "../src/lib/loyalty/loyalty-credit";
import { prisma } from "../src/lib/prisma";
import { deliverReviewRequestEmail } from "../src/lib/reviews/deliver-review-request-email";
import { insertBookingOccupancy } from "../src/lib/vehicle-unit-occupancy";

const testSuffix = Date.now().toString(36);
const customerEmail = `Loyalty-${testSuffix}@Example.com`;
const normalizedEmail = `loyalty-${testSuffix}@example.com`;
const otherEmail = `other-loyalty-${testSuffix}@example.com`;

function logPass(name: string): void {
  console.log(`${name} PASS`);
}

function plate(): string {
  return `LY${randomBytes(3).toString("hex").toUpperCase()}`;
}

function runPureTests(): void {
  assert.equal(normalizeLoyaltyCustomerEmail("  Guest@Example.com "), "guest@example.com");
  assert.equal(normalizeLoyaltyCustomerEmail("first.last@gmail.com"), "first.last@gmail.com");
  assert.equal(loyaltyDiscountForCharges(4.99), 0);
  assert.equal(loyaltyDiscountForCharges(5), 5);
  assert.equal(loyaltyDiscountForCharges(80), 5);
  assert.equal(chargesAfterLoyalty(80, 5), 75);
  assert.equal(chargesAfterLoyalty(3, 5), 0);

  const section = buildLoyaltyCreditEmailSection();
  assert.match(section.text, /€5 credit toward your next booking/);
  assert.match(section.text, /does not depend on leaving a Google review/);
  assert.doesNotMatch(section.text, /leave a review to receive|once you review/i);

  const reviewUrl = "https://example.com/google-review";
  const email = buildPostRentalReviewEmail({
    customerFullName: "Alex Guest",
    bookingReference: "EMR-LOYAL",
    vehicleName: "Yamaha NMAX",
    reviewUrl,
    additionalHtml: section.html,
    additionalText: section.text,
  });
  assert.match(email.html, /€5 off your next rental/);
  assert.match(email.html, /Leave a Google Review/);
  assert.match(email.text, /does not depend on leaving a Google review/);
  assert.doesNotMatch(email.html, /leave a review to receive|once you review/i);
  const reviewBeforeCredit = email.text.indexOf("€5 off your next rental");
  const reviewAsk = email.text.indexOf("shared your experience with us on Google");
  assert.ok(reviewBeforeCredit >= 0 && reviewAsk > reviewBeforeCredit);

  const priced = calculateVehicleChangePrice({
    priceMode: "apply_catalog",
    hasExtensions: false,
    billableDays: 6,
    currentRentalCost: 180,
    currentSubtotal: 230,
    currentTotalDueOnline: 225,
    currentTotalDueLater: 250,
    depositAmount: 250,
    depositMethod: "IN_PERSON",
    hotelDiscountPercentSnapshot: 10,
    hotelDiscountAmountSnapshot: 18,
    replacementBaseDailyRate: 40,
    loyaltyCreditAmount: 5,
  });
  assert.equal(priced.ok, true);
  if (priced.ok) {
    assert.equal(priced.pricing.finalSubtotal, 284);
    assert.equal(priced.pricing.finalTotalDueOnline, 279);
    assert.equal(priced.pricing.finalTotalDueLater, 250);
    assert.equal(priced.pricing.duesUpdated, true);
  }

  const confirmation = buildBookingConfirmationEmail({
    customerFullName: "Alex Guest",
    bookingReference: "EMR-LOYAL",
    vehicleType: "Scooter",
    pickupDateTime: new Date("2026-11-01T09:00:00.000Z"),
    returnDateTime: new Date("2026-11-03T09:00:00.000Z"),
    billableDays: 2,
    actualDurationHours: { toString: () => "48.00" },
    pickupOption: "OFFICE",
    pickupAddress: null,
    dropoffOption: "OFFICE",
    dropoffAddress: null,
    cdwOption: "NO_CDW",
    additionalDriverEnabled: false,
    storageBoxSelected: false,
    helmetSize1: null,
    helmetSize2: null,
    subtotal: 60,
    loyaltyCreditAmount: 5,
    totalDueOnline: 55,
    depositAmount: 250,
    depositMethod: "IN_PERSON",
    totalDueLater: 250,
    termsAccepted: true,
  } as unknown as Parameters<typeof buildBookingConfirmationEmail>[0]);
  assert.match(confirmation.text, /Loyalty credit: -€5\.00/);
  assert.match(confirmation.text, /Deposit amount:/);

  logPass("loyalty pricing, identity, and email rules");
}

function bookingPayload(input: {
  vehicleId: string;
  pickup: Date;
  returnAt: Date;
  email: string;
  idempotencyKey: string;
  alreadyPaid?: boolean;
}): BookingSubmissionInput {
  const fmtDate = (value: Date) => value.toISOString().slice(0, 10);
  const fmtTime = (value: Date) => value.toISOString().slice(11, 16);
  return {
    rental: {
      vehicleId: input.vehicleId,
      vehicleType: "Scooter",
      pickupDate: fmtDate(input.pickup),
      pickupTime: fmtTime(input.pickup),
      returnDate: fmtDate(input.returnAt),
      returnTime: fmtTime(input.returnAt),
    },
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
      fullName: "Loyalty Guest",
      phone: "+35699000125",
      email: input.email,
      nationality: "Maltese",
      dateOfBirth: "1991-02-02",
      licenseCategory: "B",
      specialNotes: `loyalty-credit-${testSuffix}`,
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
    // Standard Stripe bookings must collect the deposit online; ALREADY_PAID keeps IN_PERSON.
    deposit: { depositMethod: input.alreadyPaid ? "IN_PERSON" : "ONLINE" },
    payment: input.alreadyPaid
      ? { mode: "ALREADY_PAID", proofPath: `uploads/loyalty-${testSuffix}.pdf` }
      : { mode: "STRIPE", proofPath: null },
    consent: { termsAccepted: true, termsAcceptedAt: new Date().toISOString() },
  };
}

async function main(): Promise<void> {
  runPureTests();
  process.env.RESEND_API_KEY = "";

  const db = prisma;
  const bookingIds: string[] = [];
  const vehicleIds: string[] = [];
  let adminId: string | null = null;

  async function cleanup(): Promise<void> {
    if (bookingIds.length > 0) {
      await db.customerLoyaltyCredit.deleteMany({
        where: {
          OR: [{ sourceBookingId: { in: bookingIds } }, { redeemedBookingId: { in: bookingIds } }],
        },
      });
      await db.emailLog.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.bookingStatusHistory.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.bookingReviewRequest.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.vehicleUnitOccupancy.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await db.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    if (vehicleIds.length > 0) {
      await db.vehicleUnit.deleteMany({ where: { vehicleId: { in: vehicleIds } } });
      await db.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    }
    if (adminId) {
      await db.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
  }

  async function createVehicle() {
    const vehicle = await db.vehicle.create({
      data: {
        name: `Loyalty NMAX ${testSuffix}`,
        slug: `loyalty-credit-${testSuffix}-${randomBytes(3).toString("hex")}`,
        brand: "Yamaha",
        model: "NMAX",
        vehicleType: "Scooter",
        engineCc: 50,
        baseDailyRate: 30,
        isActive: true,
        catalogStatus: "AVAILABLE",
        supportsStorageBox: false,
        units: {
          create: [
            { licensePlate: plate(), color: "Red", status: "OUT_WITH_CUSTOMER", isActive: true },
            { licensePlate: plate(), color: "Black", status: "AVAILABLE", isActive: true },
          ],
        },
      },
      include: { units: { orderBy: { createdAt: "asc" } } },
    });
    vehicleIds.push(vehicle.id);
    return vehicle;
  }

  async function createSourceBooking(input: {
    vehicleId: string;
    unitId: string;
    plate: string;
    email?: string;
    billableDays?: number;
    status?: "VEHICLE_HANDED_OVER" | "COMPLETED";
  }) {
    const pickup = addDays(new Date(), -(bookingIds.length + 5));
    const returnAt = addDays(pickup, 1);
    const booking = await db.booking.create({
      data: {
        bookingReference: `LYL-${randomBytes(4).toString("hex").toUpperCase()}`,
        status: input.status ?? "VEHICLE_HANDED_OVER",
        vehicleId: input.vehicleId,
        vehicleUnitId: input.unitId,
        vehicleNameSnapshot: `Loyalty NMAX ${testSuffix}`,
        vehicleLicensePlateSnapshot: input.plate,
        vehicleColorSnapshot: "Red",
        vehicleType: "Scooter",
        vehicleTypeSnapshot: "Scooter",
        pickupDateTime: pickup,
        returnDateTime: returnAt,
        handoverDateTime: pickup,
        actualDurationHours: 24,
        billableDays: input.billableDays ?? 2,
        pickupOption: "OFFICE",
        dropoffOption: "OFFICE",
        customerFullName: "Loyalty Guest",
        customerPhone: "+35699000125",
        customerEmail: input.email ?? customerEmail,
        customerNationality: "Maltese",
        customerDateOfBirth: new Date("1991-02-02"),
        customerLicenseCategory: "B",
        depositMethod: "IN_PERSON",
        depositAmount: 250,
        baseDailyRateSnapshot: 30,
        appliedDailyRateSnapshot: 30,
        durationDiscountPercentSnapshot: 0,
        rentalCost: 60,
        cdwDailyRate: 0,
        cdwTotal: 0,
        additionalDriverDailyRate: 0,
        additionalDriverTotal: 0,
        subtotal: 60,
        totalDueOnline: 60,
        totalDueLater: 250,
        paymentStatus: "PAID",
      },
    });
    bookingIds.push(booking.id);
    if (input.status !== "COMPLETED") {
      await insertBookingOccupancy(db, {
        vehicleUnitId: input.unitId,
        pickupAt: pickup,
        returnAt,
        bookingId: booking.id,
      });
    }
    return booking;
  }

  try {
    const admin = await db.adminUser.create({
      data: {
        name: "Loyalty Credit Test",
        email: `loyalty-admin-${testSuffix}@test.local`,
        role: "STAFF",
      },
    });
    adminId = admin.id;
    const fleet = await createVehicle();
    const outUnit = fleet.units[0]!;
    const spareUnit = fleet.units[1]!;

    const source = await createSourceBooking({
      vehicleId: fleet.id,
      unitId: outUnit.id,
      plate: outUnit.licensePlate,
    });
    const returned = await markVehicleReturned(
      source.id,
      { returnRecordedAt: new Date(), unitStatusAfterReturn: "AVAILABLE", note: "Returned" },
      admin.id,
    );
    assert.equal(returned.ok, true);
    const repeated = await markVehicleReturned(
      source.id,
      { returnRecordedAt: new Date(), unitStatusAfterReturn: "AVAILABLE" },
      admin.id,
    );
    assert.equal(repeated.ok, false);

    const issuedAgain = await issueLoyaltyCreditForReturnedBooking(db, {
      id: source.id,
      customerEmail: source.customerEmail,
    });
    assert.equal(issuedAgain.created, false);

    let credits = await db.customerLoyaltyCredit.findMany({
      where: { sourceBookingId: source.id },
    });
    assert.equal(credits.length, 1);
    assert.equal(credits[0]?.status, "AVAILABLE");
    assert.equal(credits[0]?.amount.toNumber(), 5);
    assert.equal(credits[0]?.currency, "EUR");
    assert.equal(credits[0]?.customerEmailNormalized, normalizedEmail);
    logPass("a returned rental issues one €5 credit");
    logPass("repeating return processing does not issue another credit");

    const completed = await completeBooking(
      source.id,
      {
        depositOutcome: "REFUNDED",
        depositRefundAmount: 250,
        unitStatusAfterCompletion: "AVAILABLE",
        note: "Completed",
      },
      admin.id,
    );
    assert.equal(completed.ok, true);
    credits = await db.customerLoyaltyCredit.findMany({ where: { sourceBookingId: source.id } });
    assert.equal(credits.length, 1);
    logPass("completing the booking does not issue a second credit");

    const shortRental = await createSourceBooking({
      vehicleId: fleet.id,
      unitId: spareUnit.id,
      plate: spareUnit.licensePlate,
      billableDays: 1,
    });
    const shortReturned = await markVehicleReturned(
      shortRental.id,
      { returnRecordedAt: new Date(), unitStatusAfterReturn: "AVAILABLE" },
      admin.id,
    );
    assert.equal(shortReturned.ok, true);
    const shortCredit = await db.customerLoyaltyCredit.findUnique({ where: { sourceBookingId: shortRental.id } });
    assert.equal(shortCredit?.status, "AVAILABLE");
    logPass("a one-day rental earns the same €5 credit");

    const historical = await createSourceBooking({
      vehicleId: fleet.id,
      unitId: spareUnit.id,
      plate: spareUnit.licensePlate,
      status: "COMPLETED",
    });
    const historicalCredit = await db.customerLoyaltyCredit.findUnique({
      where: { sourceBookingId: historical.id },
    });
    assert.equal(historicalCredit, null);
    logPass("an older completed booking is not backfilled");

    const invalid = await createSourceBooking({
      vehicleId: fleet.id,
      unitId: spareUnit.id,
      plate: spareUnit.licensePlate,
      email: "not-an-email",
    });
    const invalidReturn = await markVehicleReturned(
      invalid.id,
      { returnRecordedAt: new Date(), unitStatusAfterReturn: "AVAILABLE" },
      admin.id,
    );
    assert.equal(invalidReturn.ok, true);
    assert.equal(
      await db.customerLoyaltyCredit.findUnique({ where: { sourceBookingId: invalid.id } }),
      null,
    );
    logPass("a rental without a usable email does not invent a credit");

    const offer = await findAvailableLoyaltyCreditOffer(db, customerEmail);
    assert.deepEqual(offer, { available: true, amountEur: 5 });
    assert.equal(Object.keys(offer).length, 2);

    const previousReviewUrl = process.env.GOOGLE_REVIEW_URL;
    process.env.GOOGLE_REVIEW_URL = "https://example.com/google-review";
    const sent: Array<{ html: string; text: string }> = [];
    const delivery = await deliverReviewRequestEmail(
      {
        id: source.id,
        bookingReference: source.bookingReference,
        customerEmail: normalizedEmail,
        customerFullName: "Loyalty Guest",
        vehicleName: "Loyalty NMAX",
      },
      {
        send: async (message) => {
          sent.push(message);
          const result: SendEmailResult = {
            ok: true,
            deliveryMode: "development_console",
            providerMessageId: "loyalty-test",
          };
          return result;
        },
      },
    );
    if (previousReviewUrl === undefined) delete process.env.GOOGLE_REVIEW_URL;
    else process.env.GOOGLE_REVIEW_URL = previousReviewUrl;
    assert.equal(delivery.ok, true);
    assert.match(sent[0]?.html ?? "", /€5 off your next rental/);
    assert.match(sent[0]?.html ?? "", /Leave a Google Review/);
    assert.doesNotMatch(sent[0]?.html ?? "", /leave a review to receive|once you review/i);
    const reviewRow = await db.bookingReviewRequest.findUnique({ where: { bookingId: source.id } });
    assert.equal(reviewRow?.status, "PENDING");
    logPass("the post-rental email includes the credit and the review request independently");

    const detail = await getAdminBookingById(source.id);
    assert.equal(detail?.issuedLoyaltyCredit?.status, "AVAILABLE");
    assert.equal(detail?.issuedLoyaltyCredit?.amount, 5);
    assert.equal(detail?.depositAmount, 250);

    const availableBeforeFailure = await db.customerLoyaltyCredit.count({
      where: { customerEmailNormalized: normalizedEmail, status: "AVAILABLE" },
    });
    await assert.rejects(
      db.$transaction(async (tx) => {
        const doomed = await tx.booking.create({
          data: {
            bookingReference: `LYL-FAIL-${randomBytes(3).toString("hex").toUpperCase()}`,
            status: "PENDING_PAYMENT",
            vehicleType: "Scooter",
            pickupDateTime: addDays(new Date(), 40),
            returnDateTime: addDays(new Date(), 42),
            actualDurationHours: 48,
            billableDays: 2,
            pickupOption: "OFFICE",
            dropoffOption: "OFFICE",
            customerFullName: "Loyalty Guest",
            customerPhone: "+35699000125",
            customerEmail: normalizedEmail,
            customerNationality: "Maltese",
            customerDateOfBirth: new Date("1991-02-02"),
            customerLicenseCategory: "B",
            depositMethod: "IN_PERSON",
            depositAmount: 250,
            subtotal: 60,
            totalDueOnline: 60,
            totalDueLater: 250,
          },
        });
        bookingIds.push(doomed.id);
        const claimed = await redeemOldestAvailableLoyaltyCredit(tx, {
          customerEmail: customerEmail,
          bookingId: doomed.id,
          eligibleChargesEur: 60,
        });
        assert.equal(claimed.applied, true);
        throw new Error("booking creation failed");
      }),
    );
    assert.equal(
      await db.customerLoyaltyCredit.count({
        where: { customerEmailNormalized: normalizedEmail, status: "AVAILABLE" },
      }),
      availableBeforeFailure,
    );
    logPass("a failed booking transaction leaves the credit available");

    const ineligible = await db.$transaction((tx) =>
      redeemOldestAvailableLoyaltyCredit(tx, {
        customerEmail: normalizedEmail,
        bookingId: source.id,
        eligibleChargesEur: 4,
      }),
    );
    assert.equal(ineligible.applied, false);
    logPass("a booking below €5 does not consume the credit");

    const firstBooking = await submitBooking(
      bookingPayload({
        vehicleId: fleet.id,
        pickup: addDays(new Date(), 20),
        returnAt: addDays(new Date(), 22),
        email: `  ${customerEmail}  `,
        idempotencyKey: `loyalty-${testSuffix}-public`,
      }),
    );
    bookingIds.push(firstBooking.bookingId);
    const publicBooking = await db.booking.findUniqueOrThrow({ where: { id: firstBooking.bookingId } });
    assert.equal(publicBooking.loyaltyCreditAmount?.toNumber(), 5);
    assert.equal(publicBooking.depositMethod, "ONLINE");
    assert.equal(
      publicBooking.totalDueOnline.toNumber(),
      chargesAfterLoyalty(publicBooking.subtotal.toNumber(), 5) + 250,
    );
    assert.equal(publicBooking.depositAmount.toNumber(), 250);
    assert.equal(publicBooking.totalDueLater.toNumber(), 0);
    assert.equal(publicBooking.subtotal.toNumber() >= 5, true);
    const redeemed = await db.customerLoyaltyCredit.findFirst({
      where: { redeemedBookingId: publicBooking.id },
    });
    assert.equal(redeemed?.status, "REDEEMED");
    assert.equal(redeemed?.sourceBookingId, source.id);
    const stillAvailable = await db.customerLoyaltyCredit.count({
      where: { customerEmailNormalized: normalizedEmail, status: "AVAILABLE" },
    });
    assert.equal(stillAvailable, 1);
    logPass("the next booking applies one €5 credit and leaves the security deposit unchanged");
    logPass("a second available credit is kept for a later booking");

    const released = await db.$transaction((tx) =>
      releaseUnpaidBooking(tx, publicBooking.id, { note: "Payment was not completed" }),
    );
    assert.equal(released.ok && released.released, true);
    const restored = await db.customerLoyaltyCredit.findUnique({ where: { sourceBookingId: source.id } });
    assert.equal(restored?.status, "AVAILABLE");
    assert.equal(restored?.redeemedBookingId, null);
    logPass("an unpaid booking returns its credit to available");

    const stranger = await submitBooking(
      bookingPayload({
        vehicleId: fleet.id,
        pickup: addDays(new Date(), 24),
        returnAt: addDays(new Date(), 26),
        email: otherEmail,
        idempotencyKey: `loyalty-${testSuffix}-other`,
      }),
    );
    bookingIds.push(stranger.bookingId);
    const strangerBooking = await db.booking.findUniqueOrThrow({ where: { id: stranger.bookingId } });
    assert.equal(strangerBooking.loyaltyCreditAmount, null);
    assert.equal(
      await db.customerLoyaltyCredit.count({
        where: { customerEmailNormalized: normalizedEmail, status: "REDEEMED" },
      }),
      0,
    );
    logPass("another customer cannot redeem this credit");

    const adminBooking = await submitBooking(
      bookingPayload({
        vehicleId: fleet.id,
        pickup: addDays(new Date(), 28),
        returnAt: addDays(new Date(), 30),
        email: normalizedEmail,
        idempotencyKey: `loyalty-${testSuffix}-admin`,
        alreadyPaid: true,
      }),
    );
    bookingIds.push(adminBooking.bookingId);
    const manualBooking = await db.booking.findUniqueOrThrow({ where: { id: adminBooking.bookingId } });
    assert.equal(manualBooking.status, "CONFIRMED");
    assert.equal(manualBooking.loyaltyCreditAmount?.toNumber(), 5);
    assert.equal(manualBooking.depositAmount.toNumber(), 250);
    assert.equal(
      manualBooking.paymentReceivedAmount?.toNumber(),
      chargesAfterLoyalty(manualBooking.subtotal.toNumber(), 5) + 250,
    );
    logPass("an admin already-paid booking uses the same credit redemption");

    const cancelled = await cancelBooking(
      manualBooking.id,
      {
        refundPayment: false,
        depositOutcome: "UNCHANGED",
        emailSubject: "Cancelled",
        emailBody: "The booking was cancelled.",
        note: "Customer cancelled",
      },
      admin.id,
    );
    assert.equal(cancelled.ok, true);
    const kept = await db.customerLoyaltyCredit.findFirst({
      where: { redeemedBookingId: manualBooking.id },
    });
    assert.equal(kept?.status, "REDEEMED");
    logPass("cancelling a confirmed booking does not return the credit");

    const pending = await submitBooking(
      bookingPayload({
        vehicleId: fleet.id,
        pickup: addDays(new Date(), 34),
        returnAt: addDays(new Date(), 36),
        email: normalizedEmail,
        idempotencyKey: `loyalty-${testSuffix}-pending-cancel`,
      }),
    );
    bookingIds.push(pending.bookingId);
    const pendingCancelled = await cancelBooking(
      pending.bookingId,
      {
        refundPayment: false,
        depositOutcome: "UNCHANGED",
        emailSubject: "Cancelled",
        emailBody: "Payment was not taken.",
      },
      admin.id,
    );
    assert.equal(pendingCancelled.ok, true);
    assert.equal(
      await db.customerLoyaltyCredit.count({
        where: { customerEmailNormalized: normalizedEmail, status: "AVAILABLE" },
      }),
      1,
    );
    logPass("cancelling a booking before payment returns the credit");

    const [shellA, shellB] = await Promise.all([
      createSourceBooking({
        vehicleId: fleet.id,
        unitId: spareUnit.id,
        plate: spareUnit.licensePlate,
        status: "COMPLETED",
        email: normalizedEmail,
      }),
      createSourceBooking({
        vehicleId: fleet.id,
        unitId: spareUnit.id,
        plate: spareUnit.licensePlate,
        status: "COMPLETED",
        email: normalizedEmail,
      }),
    ]);
    const results = await Promise.all([
      db.$transaction((tx) =>
        redeemOldestAvailableLoyaltyCredit(tx, {
          customerEmail: normalizedEmail,
          bookingId: shellA.id,
          eligibleChargesEur: 60,
        }),
      ),
      db.$transaction((tx) =>
        redeemOldestAvailableLoyaltyCredit(tx, {
          customerEmail: normalizedEmail,
          bookingId: shellB.id,
          eligibleChargesEur: 60,
        }),
      ),
    ]);
    const appliedCount = results.filter((result) => result.applied).length;
    assert.equal(appliedCount, 1);
    assert.equal(
      await db.customerLoyaltyCredit.count({
        where: { customerEmailNormalized: normalizedEmail, status: "AVAILABLE" },
      }),
      0,
    );
    logPass("two checkouts cannot redeem the same credit");

    const redeemedSource = await db.customerLoyaltyCredit.findFirst({
      where: { customerEmailNormalized: normalizedEmail, status: "REDEEMED", redeemedBookingId: { not: null } },
      select: { sourceBookingId: true },
    });
    const redeemedDetail = redeemedSource
      ? await getAdminBookingById(redeemedSource.sourceBookingId)
      : null;
    assert.equal(redeemedDetail?.issuedLoyaltyCredit?.status, "REDEEMED");
    assert.ok(redeemedDetail?.issuedLoyaltyCredit?.redeemedBookingReference);
    logPass("admin booking detail shows issued and redeemed credit");
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    console.log("loyalty credit tests passed");
  })
  .catch(async (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
