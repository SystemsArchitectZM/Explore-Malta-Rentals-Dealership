/**
 * Server-side deposit method policy for STRIPE vs ALREADY_PAID.
 * Uses validateBookingPayload only — no database.
 *
 *   npm run test:booking-deposit-method-policy
 */

import assert from "node:assert/strict";

import type { BookingSubmissionInput } from "../src/lib/booking/types";
import { validateBookingPayload } from "../src/lib/booking/validateBookingPayload";
import { calculateBookingPrice } from "../src/lib/pricing/calculate-booking-price";

const BASE: BookingSubmissionInput = {
  rental: {
    vehicleType: "Scooter",
    pickupDate: "2026-06-10",
    returnDate: "2026-06-12",
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
    helmetSize2: "M",
    storageBoxSelected: false,
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
  customer: {
    fullName: "Test Customer",
    phone: "+35699000000",
    email: "test@example.com",
    nationality: "Maltese",
    dateOfBirth: "1990-01-15",
    licenseCategory: "AM",
    specialNotes: "",
    licenseUploadPath: "",
    passportUploadPath: "",
    willPresentLicenseAtPickup: true,
    willPresentIdAtPickup: true,
  },
  deposit: {
    depositMethod: "ONLINE",
  },
  payment: {
    mode: "STRIPE",
    proofPath: null,
  },
  consent: {
    termsAccepted: true,
    termsAcceptedAt: "2026-04-22T12:30:00.000Z",
  },
};

function testStripeRequiresOnlineDeposit() {
  const ok = validateBookingPayload(BASE);
  assert.equal(ok.success, true);

  const rejected = validateBookingPayload({
    ...BASE,
    deposit: { depositMethod: "IN_PERSON" },
    payment: { mode: "STRIPE", proofPath: null },
  });
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    const paths = rejected.errors.map((issue) => issue.path);
    assert.ok(paths.includes("deposit.depositMethod"));
  }
}

function testAlreadyPaidAllowsInPersonDepositWithProof() {
  const result = validateBookingPayload({
    ...BASE,
    deposit: { depositMethod: "IN_PERSON" },
    payment: { mode: "ALREADY_PAID", proofPath: "uploads/proof.jpg" },
  });
  assert.equal(result.success, true);
}

function testAlreadyPaidRequiresProof() {
  const result = validateBookingPayload({
    ...BASE,
    deposit: { depositMethod: "IN_PERSON" },
    payment: { mode: "ALREADY_PAID", proofPath: null },
  });
  assert.equal(result.success, false);
}

function basePricingInput(method: "online" | "in_person") {
  return {
    rental: {
      vehicle: { type: "Scooter" },
      pickupDate: "2026-06-10",
      returnDate: "2026-06-12",
      pickupTime: "10:00",
      returnTime: "10:00",
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
    deposit: { method },
    vehiclePricing: {
      baseDailyRate: 25,
      vehicleType: "Scooter" as const,
      supportsStorageBox: false,
    },
  };
}

function testOnlinePricingIncludesDeposit() {
  const pricing = calculateBookingPrice(basePricingInput("online"));
  assert.ok(pricing);
  assert.equal(pricing.depositAmount, 250);
  assert.equal(pricing.totalDueOnline, pricing.subtotal + 250);
  assert.equal(pricing.totalDueLater, 0);
}

function testInPersonPricingKeepsDepositLater() {
  const pricing = calculateBookingPrice(basePricingInput("in_person"));
  assert.ok(pricing);
  assert.equal(pricing.depositAmount, 250);
  assert.equal(pricing.totalDueOnline, pricing.subtotal);
  assert.equal(pricing.totalDueLater, 250);
}

function main() {
  testStripeRequiresOnlineDeposit();
  testAlreadyPaidAllowsInPersonDepositWithProof();
  testAlreadyPaidRequiresProof();
  testOnlinePricingIncludesDeposit();
  testInPersonPricingKeepsDepositLater();
  console.log("test-booking-deposit-method-policy: all passed");
}

main();
