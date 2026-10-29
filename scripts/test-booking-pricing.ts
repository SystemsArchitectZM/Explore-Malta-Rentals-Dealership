/**
 * Verifies server-side pricing for duration discount rules + vehicle base daily rate.
 *
 * Run: npm run test:booking-pricing
 */
import type { z } from "zod";

import { bookingSubmissionSchema } from "../src/lib/booking/bookingSubmissionSchema";
import {
  BOOKABLE_HELMET_SIZES,
  isBookableHelmetSize,
  isStoredHelmetSize,
  STORED_HELMET_SIZES,
} from "../src/lib/booking/helmet-sizes";
import { buildAdminBookingNotificationEmail } from "../src/lib/email/buildAdminBookingNotificationEmail";
import { buildBookingConfirmationEmail } from "../src/lib/email/buildBookingConfirmationEmail";
import type { Booking } from "../src/generated/prisma/client";
import {
  isPickupDeliveryAllowedForDate,
  isSundayDateOnly,
} from "../src/lib/booking/delivery-availability";
import { normalizeBookingPayload } from "../src/lib/booking/normalizeBookingPayload";
import { calculateBookingPrice, type BookingPricingInput } from "../src/lib/pricing/calculate-booking-price";
import { calculateHotelDiscount } from "../src/lib/hotel-codes/calculate-hotel-discount";
import {
  calculateVehicleRentalPricing,
  resolveDurationPricingTier,
} from "../src/lib/pricing/duration-pricing";
import { PRICING_TIERS } from "../src/lib/pricing/pricing-tiers";
import { calculateCalendarRentalDays, calculateRentalDuration } from "../src/lib/pricing/rental-duration";
import { validateStorageBoxSelection } from "../src/lib/booking/validateStorageBoxSelection";

type BookingPayload = z.input<typeof bookingSubmissionSchema>;

const PICKUP_DATE = "2026-05-10";

function returnDateForRentalDays(rentalDays: number): string {
  const [year, month, day] = PICKUP_DATE.split("-").map(Number);
  const start = new Date(Date.UTC(year!, month! - 1, day!));
  start.setUTCDate(start.getUTCDate() + rentalDays - 1);
  return start.toISOString().slice(0, 10);
}

const basePricingInput = {
  rental: {
    vehicle: { type: "Scooter" },
    pickupDate: PICKUP_DATE,
    returnDate: returnDateForRentalDays(1),
    pickupTime: "09:00",
    returnTime: "18:00",
  },
  delivery: {
    pickupOption: "office" as const,
    dropoffOption: "office" as const,
  },
  addons: {
    cdwOption: "no_cdw" as const,
    additionalDriver: false,
    storageBox: false,
  },
  additionalDriver: { enabled: false },
  deposit: { method: "in_person" as const },
  vehiclePricing: {
    baseDailyRate: 25,
    vehicleType: "Scooter" as const,
  },
} satisfies BookingPricingInput;

function assertApprox(name: string, actual: number, expected: number, tolerance = 0.001): void {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${name}: expected ${expected}, got ${actual}`);
  }
}

function runDurationRuleAssertions(): void {
  const fiveDayTier = resolveDurationPricingTier(5);
  if (!fiveDayTier || fiveDayTier.key !== "TIER_1") {
    throw new Error("5-day booking should match TIER_1 (1–6 days, 0% discount)");
  }

  const flatTierPricing = calculateVehicleRentalPricing(25, 5);
  if (!flatTierPricing) {
    throw new Error("5-day flat tier pricing returned null");
  }
  assertApprox("5-day flat tier applied rate", flatTierPricing.appliedDailyRate, 25);
  assertApprox("5-day flat tier subtotal", flatTierPricing.rentalSubtotal, 125);
  assertApprox(
    "5-day flat tier uses same rate for all days",
    flatTierPricing.rentalSubtotal,
    flatTierPricing.appliedDailyRate * 5,
  );

  const noTier = resolveDurationPricingTier(0);
  if (noTier !== null) {
    throw new Error("0 billable days should not match a duration tier");
  }

  if (PRICING_TIERS.length !== 4) {
    throw new Error("Expected exactly 4 pricing tiers");
  }
}

function runCalendarRentalDaysAssertions(): void {
  const cases: Array<{
    name: string;
    pickupDate: string;
    returnDate: string;
    expected: number | null;
  }> = [
    { name: "same date", pickupDate: "2026-07-24", returnDate: "2026-07-24", expected: 1 },
    { name: "two consecutive dates", pickupDate: "2026-07-24", returnDate: "2026-07-25", expected: 2 },
    { name: "multi-day 24–26 Jul", pickupDate: "2026-07-24", returnDate: "2026-07-26", expected: 3 },
    { name: "month boundary", pickupDate: "2026-07-31", returnDate: "2026-08-01", expected: 2 },
    { name: "year boundary", pickupDate: "2026-12-31", returnDate: "2027-01-01", expected: 2 },
    { name: "leap year Feb 28–Mar 1", pickupDate: "2024-02-28", returnDate: "2024-03-01", expected: 3 },
    { name: "return before pickup", pickupDate: "2026-07-25", returnDate: "2026-07-24", expected: null },
    { name: "invalid date", pickupDate: "2026-13-01", returnDate: "2026-13-02", expected: null },
  ];

  for (const testCase of cases) {
    const actual = calculateCalendarRentalDays(testCase.pickupDate, testCase.returnDate);
    if (actual !== testCase.expected) {
      throw new Error(
        `${testCase.name}: expected ${testCase.expected}, got ${actual}`,
      );
    }
  }

  const sameDayTimed = calculateRentalDuration("2026-07-24", "09:00", "2026-07-24", "18:00");
  if (!sameDayTimed || sameDayTimed.billableDays !== 1) {
    throw new Error(
      `same date different times should bill 1 day, got ${sameDayTimed?.billableDays ?? "null"}`,
    );
  }

  const exactlyAcrossTwoDates = calculateRentalDuration(
    "2026-07-24",
    "17:00",
    "2026-07-25",
    "17:00",
  );
  if (!exactlyAcrossTwoDates || exactlyAcrossTwoDates.billableDays !== 2) {
    throw new Error(
      `24 Jul 5 PM → 25 Jul 5 PM should bill 2 days, got ${exactlyAcrossTwoDates?.billableDays ?? "null"}`,
    );
  }

  const oneMinutePastMidnight = calculateRentalDuration(
    "2026-07-24",
    "23:59",
    "2026-07-25",
    "00:00",
  );
  if (!oneMinutePastMidnight || oneMinutePastMidnight.billableDays !== 2) {
    throw new Error(
      `one minute across midnight should bill 2 days, got ${oneMinutePastMidnight?.billableDays ?? "null"}`,
    );
  }

  const timeOnlyChangeMorning = calculateRentalDuration(
    "2026-07-24",
    "09:00",
    "2026-07-26",
    "09:00",
  );
  const timeOnlyChangeEvening = calculateRentalDuration(
    "2026-07-24",
    "21:00",
    "2026-07-26",
    "21:00",
  );
  if (
    !timeOnlyChangeMorning ||
    !timeOnlyChangeEvening ||
    timeOnlyChangeMorning.billableDays !== 3 ||
    timeOnlyChangeEvening.billableDays !== 3
  ) {
    throw new Error("changing pickup/return time only must not change calendar rental days");
  }

  const returnBeforePickupTimed = calculateRentalDuration(
    "2026-07-25",
    "10:00",
    "2026-07-24",
    "10:00",
  );
  if (returnBeforePickupTimed !== null) {
    throw new Error("return before pickup datetime must be rejected");
  }

  const zeroDuration = calculateRentalDuration("2026-07-24", "10:00", "2026-07-24", "10:00");
  if (zeroDuration !== null) {
    throw new Error("zero-duration rental must be rejected");
  }

  const sameDayEarlierReturn = calculateRentalDuration(
    "2026-07-24",
    "10:00",
    "2026-07-24",
    "09:00",
  );
  if (sameDayEarlierReturn !== null) {
    throw new Error("same-day return before pickup must be rejected");
  }

  const twoHourRental = calculateRentalDuration("2026-07-24", "12:00", "2026-07-24", "14:00");
  if (!twoHourRental || twoHourRental.billableDays !== 1 || twoHourRental.actualDurationHours !== 2) {
    throw new Error(
      `2-hour rental should bill 1 day with 2 actual hours, got ${JSON.stringify(twoHourRental)}`,
    );
  }

  const twentyThreeHours = calculateRentalDuration("2026-07-20", "10:00", "2026-07-21", "09:00");
  if (!twentyThreeHours || twentyThreeHours.billableDays !== 2) {
    throw new Error(
      `23-hour overnight rental must keep inclusive calendar billing (2 days), got ${twentyThreeHours?.billableDays ?? "null"}`,
    );
  }

  console.log("Calendar rental days assertions passed");
}

function runBillableDaysConsistencyAssertions(): void {
  const pickupDate = "2026-05-10";
  const returnDate = "2026-05-12";
  const pickupTime = "10:00";
  const returnTime = "10:01";

  const duration = calculateRentalDuration(pickupDate, pickupTime, returnDate, returnTime);
  if (!duration || duration.billableDays !== 3) {
    throw new Error(
      `May 10–12 inclusive should bill as 3 calendar days, got ${duration?.billableDays ?? "null"}`,
    );
  }

  const normalized = normalizeBookingPayload(
    bookingSubmissionSchema.parse({
      ...bookingBody,
      rental: {
        ...bookingBody.rental,
        pickupDate,
        returnDate,
        pickupTime,
        returnTime,
      },
    }),
  );
  if (normalized.billableDays !== duration.billableDays) {
    throw new Error(
      `normalizeBookingPayload billableDays (${normalized.billableDays}) must match calculateRentalDuration (${duration.billableDays})`,
    );
  }

  const priced = calculateBookingPrice({
    ...basePricingInput,
    rental: {
      ...basePricingInput.rental,
      pickupDate,
      returnDate,
      pickupTime,
      returnTime,
    },
  });
  if (!priced || priced.rentalDays !== duration.billableDays) {
    throw new Error("calculateBookingPrice rentalDays must match shared duration helper");
  }
}

function pricingInputForDays(rentalDays: number, baseDailyRate = 25): BookingPricingInput {
  const returnDate = returnDateForRentalDays(rentalDays);
  const sameDay = returnDate === PICKUP_DATE;
  return {
    ...basePricingInput,
    rental: {
      ...basePricingInput.rental,
      returnDate,
      pickupTime: sameDay ? "09:00" : "10:00",
      returnTime: sameDay ? "18:00" : "10:00",
    },
    vehiclePricing: {
      ...basePricingInput.vehiclePricing,
      baseDailyRate,
    },
  };
}

function runPricingAssertions(): void {
  const cases: Array<{
    name: string;
    rentalDays: number;
    baseDailyRate?: number;
    discountPercent: number;
    appliedDailyRate: number;
    rentalCost: number;
    tierKey?: string;
  }> = [
    { name: "1 day €25", rentalDays: 1, discountPercent: 0, appliedDailyRate: 25, rentalCost: 25, tierKey: "TIER_1" },
    { name: "6 days €25", rentalDays: 6, discountPercent: 0, appliedDailyRate: 25, rentalCost: 150, tierKey: "TIER_1" },
    { name: "7 days €25", rentalDays: 7, discountPercent: 20, appliedDailyRate: 20, rentalCost: 140, tierKey: "TIER_2" },
    { name: "13 days €25", rentalDays: 13, discountPercent: 20, appliedDailyRate: 20, rentalCost: 260, tierKey: "TIER_2" },
    { name: "14 days €25", rentalDays: 14, discountPercent: 28, appliedDailyRate: 18, rentalCost: 252, tierKey: "TIER_3" },
    { name: "20 days €25", rentalDays: 20, discountPercent: 28, appliedDailyRate: 18, rentalCost: 360, tierKey: "TIER_3" },
    { name: "21 days €25", rentalDays: 21, discountPercent: 40, appliedDailyRate: 15, rentalCost: 315, tierKey: "TIER_4" },
    { name: "30 days €25", rentalDays: 30, discountPercent: 40, appliedDailyRate: 15, rentalCost: 450, tierKey: "TIER_4" },
    {
      name: "14 days €20",
      rentalDays: 14,
      baseDailyRate: 20,
      discountPercent: 28,
      appliedDailyRate: 14.4,
      rentalCost: 201.6,
      tierKey: "TIER_3",
    },
    {
      name: "14 days €19.99",
      rentalDays: 14,
      baseDailyRate: 19.99,
      discountPercent: 28,
      appliedDailyRate: 14.39,
      rentalCost: 201.46,
      tierKey: "TIER_3",
    },
    {
      name: "14 days €24.95",
      rentalDays: 14,
      baseDailyRate: 24.95,
      discountPercent: 28,
      appliedDailyRate: 17.96,
      rentalCost: 251.44,
      tierKey: "TIER_3",
    },
  ];

  for (const testCase of cases) {
    const priced = calculateBookingPrice(pricingInputForDays(testCase.rentalDays, testCase.baseDailyRate));
    if (!priced) {
      throw new Error(`${testCase.name}: pricing returned null`);
    }
    assertApprox(`${testCase.name} rental days`, priced.rentalDays, testCase.rentalDays);
    assertApprox(`${testCase.name} discount percent`, priced.durationDiscountPercent, testCase.discountPercent);
    assertApprox(`${testCase.name} applied rate`, priced.appliedDailyRate, testCase.appliedDailyRate);
    assertApprox(`${testCase.name} rental cost`, priced.rentalCost, testCase.rentalCost);
    if (testCase.tierKey && priced.tierKey !== testCase.tierKey) {
      throw new Error(`${testCase.name}: expected tier ${testCase.tierKey}, got ${priced.tierKey}`);
    }
  }

  console.log("Pricing assertions passed for all milestone tier cases");
}

function expectSchemaFailure(
  name: string,
  payload: BookingPayload,
  pathMatch: (path: string) => boolean,
): void {
  const parsed = bookingSubmissionSchema.safeParse(payload);
  if (parsed.success) {
    throw new Error(`${name}: expected schema failure, got success`);
  }
  const paths = parsed.error.issues.map((issue) => issue.path.map(String).join("."));
  if (!paths.some(pathMatch)) {
    throw new Error(`${name}: no matching issue path. Got:\n${paths.join("\n")}`);
  }
  console.log(`OK negative: ${name} (${parsed.error.issues.length} issue(s))`);
}

function expectSchemaSuccess(name: string, payload: BookingPayload): void {
  const parsed = bookingSubmissionSchema.safeParse(payload);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.map(String).join("."));
    throw new Error(`${name}: expected schema success, got issues:\n${paths.join("\n")}`);
  }
  console.log(`OK positive: ${name}`);
}

const SUNDAY_PICKUP_DATE = "2026-07-19";
const SATURDAY_PICKUP_DATE = "2026-07-18";

function runSundayDeliveryRestrictionTests(): void {
  if (!isSundayDateOnly(SUNDAY_PICKUP_DATE)) {
    throw new Error("Sunday test fixture date is not a Sunday");
  }
  if (isPickupDeliveryAllowedForDate(SUNDAY_PICKUP_DATE)) {
    throw new Error("Pickup delivery should be blocked on Sunday");
  }
  if (!isPickupDeliveryAllowedForDate(SATURDAY_PICKUP_DATE)) {
    throw new Error("Pickup delivery should be allowed on Saturday");
  }

  expectSchemaFailure(
    "Sunday delivery pickup",
    {
      ...bookingBody,
      rental: {
        ...bookingBody.rental,
        pickupDate: SUNDAY_PICKUP_DATE,
        returnDate: "2026-07-20",
      },
      delivery: {
        ...bookingBody.delivery,
        pickupOption: "DELIVERY",
        pickupAddress: "Test Hotel, Valletta",
      },
      customer: {
        ...bookingBody.customer,
        licenseUploadPath: "/uploads/license.pdf",
        passportUploadPath: "/uploads/passport.pdf",
        willPresentLicenseAtPickup: false,
        willPresentIdAtPickup: false,
      },
    },
    (p) => p === "delivery.pickupOption",
  );

  expectSchemaSuccess("Sunday office pickup", {
    ...bookingBody,
    rental: {
      ...bookingBody.rental,
      pickupDate: SUNDAY_PICKUP_DATE,
      returnDate: "2026-07-20",
    },
  });

  expectSchemaSuccess("Saturday delivery pickup", {
    ...bookingBody,
    rental: {
      ...bookingBody.rental,
      pickupDate: SATURDAY_PICKUP_DATE,
      returnDate: "2026-07-19",
    },
    delivery: {
      ...bookingBody.delivery,
      pickupOption: "DELIVERY",
      pickupAddress: "Test Hotel, Valletta",
    },
    customer: {
      ...bookingBody.customer,
      licenseUploadPath: "/uploads/license.pdf",
      passportUploadPath: "/uploads/passport.pdf",
      willPresentLicenseAtPickup: false,
      willPresentIdAtPickup: false,
    },
  });

  console.log("Sunday delivery restriction assertions passed");
}

const bookingBody: BookingPayload = {
  rental: {
    vehicleType: "Scooter",
    pickupDate: "2026-05-10",
    returnDate: "2026-05-11",
    pickupTime: "10:00",
    returnTime: "10:00",
  },
  delivery: {
    pickupOption: "OFFICE",
    pickupAddress: "",
    pickupLatitude: null,
    pickupLongitude: null,
    dropoffOption: "OFFICE",
    dropoffAddress: "",
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
    fullName: "Script Test User",
    phone: "+35677770001",
    email: "script-test@example.com",
    nationality: "Maltese",
    dateOfBirth: "1995-06-15",
    licenseCategory: "B",
    specialNotes: "",
    licenseUploadPath: "",
    passportUploadPath: "",
    willPresentLicenseAtPickup: true,
    willPresentIdAtPickup: true,
  },
  additionalDriver: {
    fullName: "",
    phone: "",
    email: "",
    nationality: "",
    dateOfBirth: null,
    licenseCategory: null,
    licenseUploadPath: "",
    passportUploadPath: "",
    willPresentLicenseAtPickup: false,
    willPresentIdAtPickup: false,
  },
  deposit: { depositMethod: "ONLINE" },
  payment: { mode: "STRIPE", proofPath: null },
  consent: {
    termsAccepted: true,
    termsAcceptedAt: new Date().toISOString(),
  },
};

function runShortRentalAssertions(): void {
  const eightHour = calculateBookingPrice({
    ...basePricingInput,
    rental: {
      ...basePricingInput.rental,
      pickupDate: "2026-05-10",
      returnDate: "2026-05-10",
      pickupTime: "09:00",
      returnTime: "17:00",
    },
    vehiclePricing: {
      ...basePricingInput.vehiclePricing,
      baseDailyRate: 40,
    },
  });
  if (!eightHour) {
    throw new Error("8-hour rental pricing returned null");
  }
  assertApprox("8-hour billable days", eightHour.rentalDays, 1);
  assertApprox("8-hour rental cost is one full day", eightHour.rentalCost, 40);
  assertApprox("8-hour actual duration", eightHour.actualDurationHours, 8);
  if (eightHour.tierKey !== "TIER_1" || eightHour.durationDiscountPercent !== 0) {
    throw new Error("sub-24-hour rental must use the 1-day tier, not a longer discount");
  }

  const priced23 = calculateBookingPrice({
    ...basePricingInput,
    rental: {
      ...basePricingInput.rental,
      pickupDate: "2026-05-11",
      returnDate: "2026-05-12",
      pickupTime: "10:00",
      returnTime: "09:00",
    },
    vehiclePricing: {
      ...basePricingInput.vehiclePricing,
      baseDailyRate: 40,
    },
  });
  if (!priced23 || priced23.rentalDays !== 2 || priced23.rentalCost !== 80) {
    throw new Error(
      `23-hour cross-midnight rental must bill 2 calendar days, got days=${priced23?.rentalDays} cost=${priced23?.rentalCost}`,
    );
  }

  expectSchemaSuccess("same-day 8-hour rental", {
    ...bookingBody,
    rental: {
      ...bookingBody.rental,
      pickupDate: "2026-05-10",
      returnDate: "2026-05-10",
      pickupTime: "09:00",
      returnTime: "17:00",
    },
  });

  expectSchemaSuccess("23-hour rental", {
    ...bookingBody,
    rental: {
      ...bookingBody.rental,
      pickupDate: "2026-05-11",
      returnDate: "2026-05-12",
      pickupTime: "10:00",
      returnTime: "09:00",
    },
  });

  expectSchemaFailure(
    "zero duration",
    {
      ...bookingBody,
      rental: {
        ...bookingBody.rental,
        pickupDate: "2026-05-10",
        returnDate: "2026-05-10",
        pickupTime: "10:00",
        returnTime: "10:00",
      },
    },
    (path) => path === "rental.returnTime",
  );

  expectSchemaFailure(
    "negative duration",
    {
      ...bookingBody,
      rental: {
        ...bookingBody.rental,
        pickupDate: "2026-05-10",
        returnDate: "2026-05-10",
        pickupTime: "10:00",
        returnTime: "09:00",
      },
    },
    (path) => path === "rental.returnTime",
  );

  const normalized = normalizeBookingPayload(
    bookingSubmissionSchema.parse({
      ...bookingBody,
      rental: {
        ...bookingBody.rental,
        pickupDate: "2026-05-10",
        returnDate: "2026-05-10",
        pickupTime: "09:00",
        returnTime: "17:00",
      },
    }),
  );
  if (normalized.billableDays !== 1) {
    throw new Error(`normalized short rental must store 1 billable day, got ${normalized.billableDays}`);
  }
  if (normalized.actualDurationHours !== 8) {
    throw new Error(`normalized short rental must keep actual hours, got ${normalized.actualDurationHours}`);
  }
  if (normalized.returnDateTime.getTime() - normalized.pickupDateTime.getTime() !== 8 * 60 * 60 * 1000) {
    throw new Error("short rental must keep the actual pickup/return interval");
  }

  console.log("Short rental assertions passed");
}

function runNegativeValidationTests(): void {
  expectSchemaFailure(
    "wrong license (A1 on Scooter)",
    {
      ...bookingBody,
      customer: { ...bookingBody.customer, licenseCategory: "A1" },
    },
    (p) => p === "customer.licenseCategory",
  );

  expectSchemaFailure(
    "terms not accepted",
    {
      ...bookingBody,
      consent: { ...bookingBody.consent, termsAccepted: false },
    },
    (p) => p === "consent.termsAccepted",
  );

  expectSchemaFailure(
    "delivery without pickup address",
    {
      ...bookingBody,
      delivery: {
        ...bookingBody.delivery,
        pickupOption: "DELIVERY",
        pickupAddress: "",
      },
    },
    (p) => p === "delivery.pickupAddress",
  );

  expectSchemaFailure(
    "ATV with only one helmet size",
    {
      ...bookingBody,
      rental: { ...bookingBody.rental, vehicleType: "ATV" },
      addons: {
        ...bookingBody.addons,
        cdwOption: "NO_CDW",
        helmetSize1: "M",
        helmetSize2: null,
      },
    },
    (p) => p === "addons.helmetSize1" || p === "addons.helmetSize2",
  );

  expectSchemaSuccess("XL helmet size", {
    ...bookingBody,
    addons: {
      ...bookingBody.addons,
      helmetSize1: "XL",
      helmetSize2: "L",
    },
  });

  expectSchemaFailure(
    "legacy Small helmet size on a new booking",
    {
      ...bookingBody,
      addons: {
        ...bookingBody.addons,
        helmetSize1: "S",
        helmetSize2: "M",
      },
    } as unknown as BookingPayload,
    (p) => p === "addons.helmetSize1",
  );

  expectSchemaFailure(
    "unsupported helmet size",
    {
      ...bookingBody,
      addons: {
        ...bookingBody.addons,
        helmetSize1: "XXL",
        helmetSize2: "M",
      },
    } as unknown as BookingPayload,
    (p) => p === "addons.helmetSize1",
  );
}

function helmetEmailFixture(
  helmetSize1: "S" | "XL",
  helmetSize2: "S" | "XL",
): Booking {
  return {
    bookingReference: "EMR-HELMET",
    customerFullName: "Test Rider",
    customerEmail: "rider@example.com",
    customerPhone: "+35600000000",
    vehicleType: "Scooter",
    vehicleNameSnapshot: null,
    vehicleLicensePlateSnapshot: null,
    pickupDateTime: new Date("2026-05-10T10:00:00Z"),
    returnDateTime: new Date("2026-05-11T10:00:00Z"),
    billableDays: 1,
    actualDurationHours: 24,
    pickupOption: "OFFICE",
    pickupAddress: null,
    dropoffOption: "OFFICE",
    dropoffAddress: null,
    cdwOption: "NO_CDW",
    additionalDriverEnabled: false,
    storageBoxSelected: false,
    helmetSize1,
    helmetSize2,
    subtotal: 40,
    totalDueOnline: 0,
    depositAmount: 0,
    depositMethod: "IN_PERSON",
    totalDueLater: 40,
    termsAccepted: true,
  } as unknown as Booking;
}

function runHelmetSizeAssertions(): void {
  if (BOOKABLE_HELMET_SIZES.join(",") !== "M,L,XL") {
    throw new Error(`bookable helmet sizes changed unexpectedly: ${BOOKABLE_HELMET_SIZES.join(",")}`);
  }
  if (STORED_HELMET_SIZES.join(",") !== "S,M,L,XL") {
    throw new Error(`stored helmet sizes changed unexpectedly: ${STORED_HELMET_SIZES.join(",")}`);
  }
  if (isBookableHelmetSize("S") || !isStoredHelmetSize("S") || !isBookableHelmetSize("XL")) {
    throw new Error("helmet size helpers do not distinguish legacy Small from bookable XL");
  }

  const xlBooking = helmetEmailFixture("XL", "XL");
  const customerXl = buildBookingConfirmationEmail(xlBooking);
  if (!customerXl.text.includes("size XL") || !customerXl.html.includes("size XL")) {
    throw new Error("customer confirmation did not render XL");
  }
  const adminXl = buildAdminBookingNotificationEmail(xlBooking);
  if (!adminXl.text.includes("XL, XL") || !adminXl.html.includes("XL, XL")) {
    throw new Error("admin notification did not render XL");
  }

  const smallBooking = helmetEmailFixture("S", "S");
  const customerSmall = buildBookingConfirmationEmail(smallBooking);
  if (!customerSmall.text.includes("size S") || !customerSmall.html.includes("size S")) {
    throw new Error("customer confirmation did not render historical Small");
  }
  const adminSmall = buildAdminBookingNotificationEmail(smallBooking);
  if (!adminSmall.text.includes("S, S") || !adminSmall.html.includes("S, S")) {
    throw new Error("admin notification did not render historical Small");
  }

  console.log("Helmet size assertions passed");
}

function runStorageBoxAssertions(): void {
  const withStorageBoxSelected = calculateBookingPrice({
    ...basePricingInput,
    vehiclePricing: {
      ...basePricingInput.vehiclePricing,
      supportsStorageBox: true,
    },
    addons: {
      ...basePricingInput.addons,
      storageBox: true,
    },
  });
  if (!withStorageBoxSelected) {
    throw new Error("pricing with storage box selected returned null");
  }
  assertApprox("storage box fee when available and selected", withStorageBoxSelected.storageBoxCost, 10);
  assertApprox(
    "subtotal includes storage box fee",
    withStorageBoxSelected.subtotal,
    withStorageBoxSelected.rentalCost + withStorageBoxSelected.storageBoxCost,
  );

  const unavailableWithManipulatedSelection = calculateBookingPrice({
    ...basePricingInput,
    vehiclePricing: {
      ...basePricingInput.vehiclePricing,
      supportsStorageBox: false,
    },
    addons: {
      ...basePricingInput.addons,
      storageBox: true,
    },
  });
  if (!unavailableWithManipulatedSelection) {
    throw new Error("pricing with unavailable storage box returned null");
  }
  assertApprox(
    "no storage box fee when vehicle does not support it",
    unavailableWithManipulatedSelection.storageBoxCost,
    0,
  );
  assertApprox(
    "subtotal excludes storage box fee when unavailable",
    unavailableWithManipulatedSelection.subtotal,
    unavailableWithManipulatedSelection.rentalCost,
  );

  const validationError = validateStorageBoxSelection(false, true);
  if (!validationError || validationError.path !== "addons.storageBoxSelected") {
    throw new Error("expected storage box validation error for unavailable vehicle");
  }

  if (validateStorageBoxSelection(true, true) !== null) {
    throw new Error("storage box should be allowed when vehicle supports it");
  }

  if (validateStorageBoxSelection(false, false) !== null) {
    throw new Error("storage box should be allowed when not selected");
  }

  console.log("Storage box assertions passed");
}

function runHotelDiscountAssertions(): void {
  const hotelDiscountOnly = calculateHotelDiscount(100, 10);
  assertApprox("hotel discount amount", hotelDiscountOnly.discountAmount, 10);
  assertApprox("rental after hotel discount", hotelDiscountOnly.rentalCostAfterDiscount, 90);

  const fiveDayWithHotel = calculateBookingPrice({
    ...pricingInputForDays(5),
    hotelDiscount: { discountPercent: 10 },
  });
  if (!fiveDayWithHotel) {
    throw new Error("5-day booking with hotel discount returned null");
  }

  assertApprox("5-day rental before hotel", fiveDayWithHotel.rentalCost, 125);
  assertApprox("5-day hotel discount", fiveDayWithHotel.hotelDiscountAmount, 12.5);
  assertApprox("5-day rental after hotel", fiveDayWithHotel.rentalCostAfterHotelDiscount, 112.5);
  assertApprox("5-day subtotal with hotel only on rental", fiveDayWithHotel.subtotal, 112.5);

  const fiveDayWithHotelAndDelivery = calculateBookingPrice({
    ...pricingInputForDays(5),
    delivery: {
      pickupOption: "delivery",
      dropoffOption: "dropoff",
    },
    hotelDiscount: { discountPercent: 10 },
  });
  if (!fiveDayWithHotelAndDelivery) {
    throw new Error("5-day booking with hotel discount and delivery returned null");
  }

  assertApprox("delivery unchanged with hotel code", fiveDayWithHotelAndDelivery.deliveryTotal, 30);
  assertApprox(
    "subtotal applies hotel discount only to rental",
    fiveDayWithHotelAndDelivery.subtotal,
    142.5,
  );
}

function runInsurancePlanAssertions(): void {
  const oneDayRental = {
    ...basePricingInput.rental,
    pickupDate: "2026-05-10",
    returnDate: "2026-05-10",
    pickupTime: "10:00",
    returnTime: "18:00",
  } as const;

  const oneDayNoInsurance = calculateBookingPrice({
    ...basePricingInput,
    rental: oneDayRental,
    addons: { ...basePricingInput.addons, cdwOption: "NO_INSURANCE" },
  });
  if (!oneDayNoInsurance) {
    throw new Error("1-day no insurance pricing returned null");
  }
  assertApprox("1-day calendar rental days", oneDayNoInsurance.rentalDays, 1);
  assertApprox("1-day no insurance cost", oneDayNoInsurance.cdwCost, 0);

  const oneDayBasic = calculateBookingPrice({
    ...basePricingInput,
    rental: oneDayRental,
    addons: { ...basePricingInput.addons, cdwOption: "BASIC" },
  });
  if (!oneDayBasic) {
    throw new Error("1-day basic insurance pricing returned null");
  }
  assertApprox("1-day basic insurance cost", oneDayBasic.cdwCost, 3);

  const oneDayFull = calculateBookingPrice({
    ...basePricingInput,
    rental: oneDayRental,
    addons: { ...basePricingInput.addons, cdwOption: "FULL_COVERAGE" },
  });
  if (!oneDayFull) {
    throw new Error("1-day full coverage pricing returned null");
  }
  assertApprox("1-day full coverage cost", oneDayFull.cdwCost, 8);

  const fourDayBasic = calculateBookingPrice({
    ...basePricingInput,
    rental: {
      ...basePricingInput.rental,
      pickupDate: "2026-05-10",
      returnDate: "2026-05-13",
    },
    addons: { ...basePricingInput.addons, cdwOption: "BASIC" },
  });
  if (!fourDayBasic) {
    throw new Error("4-day basic insurance pricing returned null");
  }
  assertApprox("4-day calendar rental days", fourDayBasic.rentalDays, 4);
  assertApprox("4-day basic insurance cost", fourDayBasic.cdwCost, 12);

  const fourDayFull = calculateBookingPrice({
    ...basePricingInput,
    rental: {
      ...basePricingInput.rental,
      pickupDate: "2026-05-10",
      returnDate: "2026-05-13",
    },
    addons: { ...basePricingInput.addons, cdwOption: "FULL_COVERAGE" },
  });
  if (!fourDayFull) {
    throw new Error("4-day full coverage pricing returned null");
  }
  assertApprox("4-day full coverage cost", fourDayFull.cdwCost, 32);

  const overnightCalendar = calculateBookingPrice({
    ...basePricingInput,
    rental: {
      ...basePricingInput.rental,
      pickupDate: "2026-05-10",
      pickupTime: "22:00",
      returnDate: "2026-05-11",
      returnTime: "02:00",
    },
    addons: { ...basePricingInput.addons, cdwOption: "BASIC" },
  });
  if (!overnightCalendar) {
    throw new Error("overnight calendar-day insurance pricing returned null");
  }
  assertApprox("overnight uses 2 calendar days", overnightCalendar.rentalDays, 2);
  assertApprox("overnight basic insurance uses calendar days", overnightCalendar.cdwCost, 6);

  // Insurance is added after rental discount — not discounted by duration rules.
  const discountedWithInsurance = calculateBookingPrice({
    ...pricingInputForDays(5),
    addons: { ...basePricingInput.addons, cdwOption: "FULL_COVERAGE" },
  });
  if (!discountedWithInsurance) {
    throw new Error("discounted rental + insurance pricing returned null");
  }
  assertApprox("5-day rental with duration discount", discountedWithInsurance.rentalCost, 125);
  assertApprox("5-day full insurance not discounted", discountedWithInsurance.cdwCost, 40);
  assertApprox(
    "5-day subtotal rental + insurance",
    discountedWithInsurance.subtotal,
    165,
  );

  const invalidLegacyAtv = bookingSubmissionSchema.safeParse({
    rental: {
      vehicleType: "ATV",
      pickupDate: "2026-05-10",
      returnDate: "2026-05-11",
      pickupTime: "10:00",
      returnTime: "10:00",
    },
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
      cdwOption: "REDUCE_800_ATV",
      additionalDriverEnabled: false,
      helmetSize1: "M",
      helmetSize2: "L",
      storageBoxSelected: false,
    },
    customer: {
      fullName: "Alex Rider",
      phone: "+35677770000",
      email: "alex@example.com",
      nationality: "Maltese",
      dateOfBirth: "1995-06-15",
      licenseCategory: "B",
      specialNotes: null,
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
    consent: { termsAccepted: true, termsAcceptedAt: "2026-05-01T10:00:00.000Z" },
  });
  if (invalidLegacyAtv.success) {
    throw new Error("Legacy ATV CDW option should be rejected for new bookings");
  }

  console.log("Insurance plan assertions passed");
}

async function main(): Promise<void> {
  runDurationRuleAssertions();
  runCalendarRentalDaysAssertions();
  runBillableDaysConsistencyAssertions();
  runPricingAssertions();
  runStorageBoxAssertions();
  runHotelDiscountAssertions();
  runInsurancePlanAssertions();
  runShortRentalAssertions();
  runNegativeValidationTests();
  runHelmetSizeAssertions();
  runSundayDeliveryRestrictionTests();
  console.log("All checks OK.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
