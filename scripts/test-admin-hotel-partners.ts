/**
 * Admin hotel partner creation with optional initial code.
 *
 * Run: npm run test:admin-hotel-partners
 *
 * Manual test checklist:
 * 1. Sign in as admin and open /{locale}/admin/hotels/new — header shows "Create Hotel".
 * 2. Sidebar shows "Hotels" and "Hotel Codes" (no partner wording).
 * 3. Create hotel only (leave initial code blank) — hotel appears in list with 0 codes.
 * 4. Create hotel with initial code + discount — hotel shows 1 code; code appears on /admin/hotel-codes.
 * 5. Try duplicate initial code — form shows clear duplicate error; hotel is not created.
 * 6. Create inactive hotel with active initial code — blocked with inactive-hotel message.
 * 7. Create inactive hotel with inactive initial code — hotel and code saved inactive.
 * 8. Enter code without discount — client blocks before submit.
 * 9. Enter discount outside 0–100 — client blocks before submit.
 * 10. Booking form shows "Hotel Code" and summary shows "Hotel discount" (no partner wording).
 */
import "dotenv/config";
import assert from "node:assert/strict";

import {
  createAdminHotelCode,
  deleteAdminHotelCode,
  deactivateAdminHotelCode,
} from "../src/lib/admin/hotel-codes";
import {
  adminHotelPartnerCreateSchema,
  createAdminHotelPartner,
  deactivateAdminHotelPartner,
  deleteAdminHotelPartner,
  getAdminHotelPartnerById,
} from "../src/lib/admin/hotel-partners";
import { getAdminHotelCodeById } from "../src/lib/admin/hotel-codes/listAdminHotelCodes";
import { DuplicateHotelCodeError } from "../src/lib/admin/hotel-codes";
import { prisma } from "../src/lib/prisma";
import { assertSafeScriptDatabase } from "./assert-safe-script-database";

const testSuffix = String(Date.now()).slice(-8);
const testPrefix = `HP${testSuffix}`;

async function cleanup(partnerIds: string[]) {
  for (const partnerId of partnerIds) {
    await prisma.hotelCode.deleteMany({ where: { hotelPartnerId: partnerId } }).catch(() => undefined);
    await prisma.hotelPartner.deleteMany({ where: { id: partnerId } }).catch(() => undefined);
  }
}

async function run() {
  assertSafeScriptDatabase("test-admin-hotel-partners");
  const createdPartnerIds: string[] = [];

  try {
    const partnerOnlyPayload = {
      name: `${testPrefix} Partner Only`,
      isActive: true,
    };
    const partnerOnlyParsed = adminHotelPartnerCreateSchema.safeParse(partnerOnlyPayload);
    assert.equal(partnerOnlyParsed.success, true, "partner-only payload should pass schema");

    const partnerOnly = await createAdminHotelPartner(partnerOnlyParsed.data!);
    createdPartnerIds.push(partnerOnly.partner.id);
    assert.equal(partnerOnly.partner.hotelCodeCount, 0);
    assert.equal(partnerOnly.initialCode, undefined);

    const withCodePayload = {
      name: `${testPrefix} With Code`,
      isActive: true,
      initialCode: {
        code: ` ${testPrefix}-CODE `.toLowerCase(),
        discountPercent: 12.5,
        isActive: true,
      },
    };
    const withCodeParsed = adminHotelPartnerCreateSchema.safeParse(withCodePayload);
    assert.equal(withCodeParsed.success, true, "partner with initial code should pass schema");
    const expectedCode = `${testPrefix}-CODE`.toUpperCase();
    if (withCodeParsed.success) {
      assert.equal(withCodeParsed.data.initialCode?.code, expectedCode);
    }

    const withCode = await createAdminHotelPartner(withCodeParsed.data!);
    createdPartnerIds.push(withCode.partner.id);
    assert.ok(withCode.initialCode);
    assert.equal(withCode.initialCode.code, expectedCode);
    assert.equal(withCode.partner.hotelCodeCount, 1);

    const duplicateParsed = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Duplicate`,
      isActive: true,
      initialCode: {
        code: expectedCode,
        discountPercent: 5,
        isActive: true,
      },
    });
    assert.equal(duplicateParsed.success, true);

    let duplicateBlocked = false;
    try {
      await createAdminHotelPartner(duplicateParsed.data!);
    } catch (error) {
      duplicateBlocked = error instanceof DuplicateHotelCodeError;
    }
    assert.equal(duplicateBlocked, true, "duplicate initial code should throw DuplicateHotelCodeError");

    const inactivePartnerActiveCode = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Inactive Partner`,
      isActive: false,
      initialCode: {
        code: `${testPrefix}-INA`,
        discountPercent: 10,
        isActive: true,
      },
    });
    assert.equal(inactivePartnerActiveCode.success, false, "active code on inactive partner should fail schema");

    const inactiveBothParsed = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Inactive Both`,
      isActive: false,
      initialCode: {
        code: `${testPrefix}-INB`,
        discountPercent: 10,
        isActive: false,
      },
    });
    assert.equal(inactiveBothParsed.success, true);
    const inactiveBoth = await createAdminHotelPartner(inactiveBothParsed.data!);
    createdPartnerIds.push(inactiveBoth.partner.id);
    assert.equal(inactiveBoth.partner.isActive, false);
    assert.equal(inactiveBoth.initialCode?.isActive, false);

    const missingDiscount = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Missing Discount`,
      isActive: true,
      initialCode: {
        code: `${testPrefix}-ND`,
        discountPercent: "",
        isActive: true,
      },
    });
    assert.equal(missingDiscount.success, false, "initial code without discount should fail schema");

    const outOfRangeDiscount = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Bad Discount`,
      isActive: true,
      initialCode: {
        code: `${testPrefix}-BD`,
        discountPercent: 150,
        isActive: true,
      },
    });
    assert.equal(outOfRangeDiscount.success, false, "discount above 100 should fail schema");

    const emptyCodeIgnored = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Empty Code`,
      isActive: true,
      initialCode: {
        code: "   ",
        discountPercent: 10,
        isActive: true,
      },
    });
    assert.equal(emptyCodeIgnored.success, true);
    if (emptyCodeIgnored.success) {
      assert.equal(emptyCodeIgnored.data.initialCode, undefined);
    }

    const emptyCodePartner = await createAdminHotelPartner(emptyCodeIgnored.data!);
    createdPartnerIds.push(emptyCodePartner.partner.id);
    assert.equal(emptyCodePartner.initialCode, undefined);
    assert.equal(emptyCodePartner.partner.hotelCodeCount, 0);

    const deletableHotelParsed = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Deletable`,
      isActive: true,
    });
    assert.equal(deletableHotelParsed.success, true);
    const deletableHotel = await createAdminHotelPartner(deletableHotelParsed.data!);
    createdPartnerIds.push(deletableHotel.partner.id);
    const deletableLoaded = await getAdminHotelPartnerById(deletableHotel.partner.id);
    assert.ok(deletableLoaded);
    assert.equal(deletableLoaded.canDelete, true);
    assert.equal(deletableLoaded.deleteBlockedReason, null);

    const deleteEmpty = await deleteAdminHotelPartner(deletableHotel.partner.id);
    assert.equal(deleteEmpty.ok, true);
    createdPartnerIds.pop();

    const hotelWithCode = await createAdminHotelPartner({
      name: `${testPrefix} Has Code`,
      isActive: true,
      initialCode: {
        code: `${testPrefix}-DEL`,
        discountPercent: 5,
        isActive: true,
      },
    });
    createdPartnerIds.push(hotelWithCode.partner.id);
    const withCodeLoaded = await getAdminHotelPartnerById(hotelWithCode.partner.id);
    assert.ok(withCodeLoaded);
    assert.equal(withCodeLoaded.canDelete, false);
    assert.equal(withCodeLoaded.deleteBlockedReason, "HAS_CODES");

    const blockedHotelDelete = await deleteAdminHotelPartner(hotelWithCode.partner.id);
    assert.equal(blockedHotelDelete.ok, false);
    if (!blockedHotelDelete.ok) {
      assert.equal(blockedHotelDelete.reason, "HAS_CODES");
    }

    const unusedCodeHotelParsed = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Unused Code`,
      isActive: true,
    });
    assert.equal(unusedCodeHotelParsed.success, true);
    const unusedCodeHotel = await createAdminHotelPartner(unusedCodeHotelParsed.data!);
    createdPartnerIds.push(unusedCodeHotel.partner.id);
    const unusedCode = await createAdminHotelCode({
      code: `${testPrefix}-UNUSED`,
      hotelPartnerId: unusedCodeHotel.partner.id,
      discountPercent: 10,
      isActive: true,
      validFrom: null,
      validUntil: null,
    });
    const unusedCodeLoaded = await getAdminHotelCodeById(unusedCode.id);
    assert.ok(unusedCodeLoaded);
    assert.equal(unusedCodeLoaded.canDelete, true);

    const deleteUnusedCode = await deleteAdminHotelCode(unusedCode.id);
    assert.equal(deleteUnusedCode.ok, true);

    const usedCode = await createAdminHotelCode({
      code: `${testPrefix}-USED`,
      hotelPartnerId: hotelWithCode.partner.id,
      discountPercent: 8,
      isActive: true,
      validFrom: null,
      validUntil: null,
    });
    const bookingRef = `TEST-${testPrefix}-BK`;
    await prisma.booking.create({
      data: {
        bookingReference: bookingRef,
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
        hotelCodeId: usedCode.id,
        hotelPartnerId: hotelWithCode.partner.id,
        hotelCodeSnapshot: usedCode.code,
        hotelPartnerNameSnapshot: hotelWithCode.partner.name,
        hotelDiscountPercentSnapshot: 8,
        hotelDiscountAmountSnapshot: 10,
        subtotalAfterHotelDiscountSnapshot: 90,
      },
    });

    const usedCodeLoaded = await getAdminHotelCodeById(usedCode.id);
    assert.ok(usedCodeLoaded);
    assert.equal(usedCodeLoaded.canDelete, false);
    assert.equal(usedCodeLoaded.deleteBlockedReason, "has_history");

    const blockedCodeDelete = await deleteAdminHotelCode(usedCode.id);
    assert.equal(blockedCodeDelete.ok, false);
    if (!blockedCodeDelete.ok) {
      assert.equal(blockedCodeDelete.reason, "has_history");
    }

    const deactivateUsedCode = await deactivateAdminHotelCode(usedCode.id);
    assert.equal(deactivateUsedCode.ok, true);
    if (deactivateUsedCode.ok) {
      assert.equal(deactivateUsedCode.code.isActive, false);
    }

    const hotelWithHistoryParsed = adminHotelPartnerCreateSchema.safeParse({
      name: `${testPrefix} Has History`,
      isActive: true,
    });
    assert.equal(hotelWithHistoryParsed.success, true);
    const hotelWithHistory = await createAdminHotelPartner(hotelWithHistoryParsed.data!);
    createdPartnerIds.push(hotelWithHistory.partner.id);
    await prisma.booking.create({
      data: {
        bookingReference: `TEST-${testPrefix}-HIST`,
        status: "CONFIRMED",
        vehicleType: "Scooter",
        pickupDateTime: new Date("2026-07-03T10:00:00.000Z"),
        returnDateTime: new Date("2026-07-04T10:00:00.000Z"),
        actualDurationHours: 24,
        billableDays: 1,
        pickupOption: "OFFICE",
        dropoffOption: "OFFICE",
        customerFullName: "History User",
        customerPhone: "+35600000001",
        customerEmail: "history@example.com",
        customerNationality: "Malta",
        customerDateOfBirth: new Date("1990-01-01T00:00:00.000Z"),
        customerLicenseCategory: "B",
        depositMethod: "IN_PERSON",
        hotelPartnerId: hotelWithHistory.partner.id,
        hotelPartnerNameSnapshot: hotelWithHistory.partner.name,
      },
    });

    const historyLoaded = await getAdminHotelPartnerById(hotelWithHistory.partner.id);
    assert.ok(historyLoaded);
    assert.equal(historyLoaded.canDelete, false);
    assert.equal(historyLoaded.deleteBlockedReason, "HAS_HISTORY");

    const blockedHistoryDelete = await deleteAdminHotelPartner(hotelWithHistory.partner.id);
    assert.equal(blockedHistoryDelete.ok, false);
    if (!blockedHistoryDelete.ok) {
      assert.equal(blockedHistoryDelete.reason, "HAS_HISTORY");
    }

    const cascadeHotel = await createAdminHotelPartner({
      name: `${testPrefix} Cascade`,
      isActive: true,
      initialCode: {
        code: `${testPrefix}-CASC`,
        discountPercent: 5,
        isActive: true,
      },
    });
    createdPartnerIds.push(cascadeHotel.partner.id);
    assert.ok(cascadeHotel.initialCode);
    assert.equal(cascadeHotel.initialCode.isActive, true);

    const deactivateCascade = await deactivateAdminHotelPartner(cascadeHotel.partner.id);
    assert.equal(deactivateCascade.ok, true);
    if (deactivateCascade.ok) {
      assert.equal(deactivateCascade.partner.isActive, false);
      const cascCode = await getAdminHotelCodeById(cascadeHotel.initialCode!.id);
      assert.ok(cascCode);
      assert.equal(cascCode.isActive, false);
    }

    await prisma.booking.deleteMany({
      where: { bookingReference: { in: [bookingRef, `TEST-${testPrefix}-HIST`] } },
    });

    console.log("Admin hotel partner + initial code + delete/deactivate checks passed.");
  } finally {
    await cleanup(createdPartnerIds);
    await prisma.$disconnect();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
