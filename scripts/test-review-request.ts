/**
 * Post-return Google review requests.
 *
 * Run: npm run test:review-request
 */
import "dotenv/config";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import type { Booking } from "../src/generated/prisma/index";
import { buildBookingConfirmationEmail } from "../src/lib/email/buildBookingConfirmationEmail";
import { buildPostRentalReviewEmail } from "../src/lib/email/buildPostRentalReviewEmail";
import type { SendEmailResult } from "../src/lib/email/types";
import { isAuthorizedCronRequest } from "../src/lib/reviews/cron-auth";
import { isValidCustomerEmail } from "../src/lib/reviews/customer-email";
import { DEFAULT_GOOGLE_REVIEW_URL, resolveGoogleReviewUrl } from "../src/lib/reviews/google-review-url";
import {
  buildPostRentalWhatsAppLink,
  buildPostRentalWhatsAppMessage,
  normalizeWhatsAppPhone,
} from "../src/lib/reviews/whatsapp-review-link";
import {
  reviewRequestDelayMs,
  reviewRequestScheduledAt,
} from "../src/lib/reviews/review-request-timing";
import type { ReviewEmailSender } from "../src/lib/reviews/deliver-review-request-email";

const testSuffix = Date.now().toString(36);
const reviewUrl = "https://example.com/google-review";

function logPass(name: string): void {
  console.log(`${name} PASS`);
}

function hoursFromNow(hours: number): Date {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function createSender(mode: "ok" | "fail" = "ok") {
  const calls: Array<{ to: string; subject: string; html: string; text: string }> = [];
  const send: ReviewEmailSender = async (input) => {
    calls.push(input);
    if (mode === "fail") {
      throw new Error("provider down");
    }
    const result: SendEmailResult = {
      ok: true,
      deliveryMode: "development_console",
      providerMessageId: "test-message",
    };
    return result;
  };
  return { calls, send };
}

function runPureTests(): void {
  assert.equal(isValidCustomerEmail("guest@example.com"), true);
  assert.equal(isValidCustomerEmail("  guest@example.com  "), true);
  assert.equal(isValidCustomerEmail("not-an-email"), false);
  assert.equal(isValidCustomerEmail(""), false);
  assert.equal(isValidCustomerEmail(null), false);

  assert.equal(reviewRequestDelayMs(""), 2 * 60 * 1000);
  assert.equal(reviewRequestDelayMs("0"), 60 * 1000);
  assert.equal(reviewRequestDelayMs("9"), 5 * 60 * 1000);
  assert.equal(reviewRequestDelayMs("3"), 3 * 60 * 1000);
  const scheduled = reviewRequestScheduledAt(new Date("2026-10-25T12:00:00.000Z"), "2");
  assert.equal(scheduled.toISOString(), "2026-10-25T12:02:00.000Z");

  const configured = resolveGoogleReviewUrl(reviewUrl);
  assert.equal(configured.ok, true);
  if (configured.ok) assert.equal(configured.url, reviewUrl);
  assert.equal(resolveGoogleReviewUrl("http://example.com/review").ok, false);
  const fallback = resolveGoogleReviewUrl("");
  assert.equal(fallback.ok, true);
  if (fallback.ok) assert.equal(fallback.url, DEFAULT_GOOGLE_REVIEW_URL);
  logPass("review request email, delay, and Google URL rules");

  const previous = process.env.GOOGLE_REVIEW_URL;
  process.env.GOOGLE_REVIEW_URL = reviewUrl;
  const email = buildPostRentalReviewEmail({
    customerFullName: "Alex Guest",
    bookingReference: "EMR-1",
    vehicleName: "Yamaha NMAX",
    reviewUrl,
  });
  assert.match(email.subject, /EMR-1/);
  assert.match(email.html, /Leave a Google Review/);
  assert.match(email.html, /https:\/\/example\.com\/google-review/);
  assert.match(email.text, /shared your experience with us on Google/);
  assert.doesNotMatch(email.html, /loyalty|€\s*5|deposit/i);
  assert.doesNotMatch(email.text, /loyalty|€\s*5|deposit/i);
  const withNote = buildPostRentalReviewEmail({
    customerFullName: "Alex Guest",
    bookingReference: "EMR-1",
    vehicleName: "Yamaha NMAX",
    reviewUrl,
    additionalHtml: "<p>Later note</p>",
    additionalText: "Later note",
  });
  assert.match(withNote.html, /Later note/);
  assert.doesNotMatch(email.html, /Later note/);
  if (previous === undefined) delete process.env.GOOGLE_REVIEW_URL;
  else process.env.GOOGLE_REVIEW_URL = previous;

  assert.equal(normalizeWhatsAppPhone("+356 9912 3456"), "35699123456");
  assert.equal(normalizeWhatsAppPhone("+356-9912-3456"), "35699123456");
  assert.equal(normalizeWhatsAppPhone("(356) 9912 3456"), "35699123456");
  assert.equal(normalizeWhatsAppPhone("00356 9912 3456"), "35699123456");
  assert.equal(normalizeWhatsAppPhone("  "), null);
  assert.equal(normalizeWhatsAppPhone("123"), null);
  assert.equal(normalizeWhatsAppPhone(null), null);

  const withCredit = buildPostRentalWhatsAppLink({
    customerPhone: "+356 9912 3456",
    customerFullName: "Alex Guest",
    includeLoyaltyCredit: true,
    googleReviewUrlEnv: reviewUrl,
  });
  assert.equal(withCredit.ok, true);
  if (withCredit.ok) {
    const parsed = new URL(withCredit.url);
    assert.equal(parsed.origin + parsed.pathname, "https://wa.me/35699123456");
    const text = parsed.searchParams.get("text") ?? "";
    assert.match(text, /Hi Alex,/);
    assert.match(text, /Thank you for choosing Explore Malta Rentals/);
    assert.match(text, /€5 credit available toward your next booking/);
    assert.doesNotMatch(text, /review to receive|leave a review to/i);
    assert.match(text, /shared your experience with us on Google/);
    assert.match(text, new RegExp(reviewUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(text, /bookingReference|deposit|EMR-/i);
    assert.match(withCredit.url, /text=/);
    assert.match(withCredit.url, /%20/);
    assert.match(withCredit.url, /%0A/);
    assert.doesNotMatch(withCredit.url, / /);
  }

  const withoutCredit = buildPostRentalWhatsAppMessage({
    customerFullName: "Alex Guest",
    reviewUrl,
    includeLoyaltyCredit: false,
  });
  assert.match(withoutCredit, /Hi Alex,/);
  assert.match(withoutCredit, new RegExp(reviewUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(withoutCredit, /€5/);

  const missingPhone = buildPostRentalWhatsAppLink({
    customerPhone: "",
    customerFullName: "Alex Guest",
    includeLoyaltyCredit: false,
    googleReviewUrlEnv: reviewUrl,
  });
  assert.deepEqual(missingPhone, { ok: false, reason: "invalid_phone" });

  const badReviewUrl = buildPostRentalWhatsAppLink({
    customerPhone: "+356 9912 3456",
    customerFullName: "Alex Guest",
    includeLoyaltyCredit: false,
    googleReviewUrlEnv: "http://example.com/review",
  });
  assert.deepEqual(badReviewUrl, { ok: false, reason: "invalid_review_url" });

  const fallbackLink = buildPostRentalWhatsAppLink({
    customerPhone: "+356 9912 3456",
    customerFullName: "Alex Guest",
    includeLoyaltyCredit: false,
    googleReviewUrlEnv: "",
  });
  assert.equal(fallbackLink.ok, true);
  if (fallbackLink.ok) {
    assert.match(decodeURIComponent(fallbackLink.url), new RegExp(DEFAULT_GOOGLE_REVIEW_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  logPass("WhatsApp click-to-chat link uses the booking phone, review URL, and loyalty credit");
  const confirmation = buildBookingConfirmationEmail({
    customerFullName: "Alex Guest",
    bookingReference: "EMR-CONFIRM",
    vehicleType: "Scooter",
    pickupDateTime: new Date("2026-10-20T09:00:00.000Z"),
    returnDateTime: new Date("2026-10-21T09:00:00.000Z"),
    billableDays: 1,
    actualDurationHours: { toString: () => "24.00" },
    pickupOption: "OFFICE",
    pickupAddress: null,
    dropoffOption: "OFFICE",
    dropoffAddress: null,
    cdwOption: "NO_CDW",
    additionalDriverEnabled: false,
    storageBoxSelected: false,
    helmetSize1: null,
    helmetSize2: null,
    subtotal: 40,
    totalDueOnline: 40,
    depositAmount: 100,
    depositMethod: "IN_PERSON",
    totalDueLater: 100,
    termsAccepted: true,
  } as unknown as Booking);
  assert.match(confirmation.subject, /Booking Confirmation/);
  assert.match(confirmation.html, /EMR-CONFIRM/);
  assert.doesNotMatch(confirmation.html, /Leave a Google Review/);
  logPass("review email is separate from booking confirmation");

  const secret = "cron-test-secret";
  const allowed = new Request("http://localhost/api/cron/review-requests", {
    headers: { authorization: `Bearer ${secret}` },
  });
  const denied = new Request("http://localhost/api/cron/review-requests", {
    headers: { authorization: "Bearer wrong" },
  });
  const headerAllowed = new Request("http://localhost/api/cron/review-requests", {
    headers: { "x-cron-secret": secret },
  });
  assert.equal(isAuthorizedCronRequest(allowed, secret), true);
  assert.equal(isAuthorizedCronRequest(headerAllowed, secret), true);
  assert.equal(isAuthorizedCronRequest(denied, secret), false);
  assert.equal(isAuthorizedCronRequest(allowed, ""), false);
  logPass("review processor rejects unauthorized cron calls");
}

async function runDatabaseTests(): Promise<void> {
  const { prisma } = await import("../src/lib/prisma");
  const { markVehicleReturned } = await import("../src/lib/admin/bookings/lifecycle/markVehicleReturned");
  const { completeBooking } = await import("../src/lib/admin/bookings/lifecycle/completeBooking");
  const { extendBooking } = await import("../src/lib/admin/bookings/extendBooking");
  const { replaceBookingVehicle } = await import("../src/lib/admin/bookings/replaceBookingVehicle");
  const { processDueReviewRequests } = await import("../src/lib/reviews/process-due-review-requests");
  const { resendBookingReviewRequest } = await import("../src/lib/reviews/resend-review-request");
  const { insertBookingOccupancy } = await import("../src/lib/vehicle-unit-occupancy");

  const vehicleIds: string[] = [];
  const bookingIds: string[] = [];
  let adminId: string | null = null;

  async function cleanup(): Promise<void> {
    if (bookingIds.length > 0) {
      await prisma.customerLoyaltyCredit.deleteMany({
        where: {
          OR: [{ sourceBookingId: { in: bookingIds } }, { redeemedBookingId: { in: bookingIds } }],
        },
      });
      await prisma.emailLog.deleteMany({ where: { bookingId: { in: bookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: bookingIds } } });
    }
    await prisma.emailLog.deleteMany({
      where: { recipientEmail: { contains: testSuffix } },
    });
    if (vehicleIds.length > 0) {
      await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
    }
    if (adminId) {
      await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => undefined);
    }
  }

  function plate(): string {
    return `RV${randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 16);
  }

  async function createVehicle(units: Array<{ color: string; status: "AVAILABLE" | "OUT_WITH_CUSTOMER" | "MAINTENANCE" }>) {
    const vehicle = await prisma.vehicle.create({
      data: {
        name: `Review NMAX ${testSuffix}`,
        slug: `review-request-${testSuffix}-${randomBytes(3).toString("hex")}`,
        brand: "Yamaha",
        model: "NMAX",
        vehicleType: "Scooter",
        engineCc: 50,
        baseDailyRate: 30,
        isActive: true,
        catalogStatus: "AVAILABLE",
        supportsStorageBox: false,
        units: {
          create: units.map((unit) => ({
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
    email?: string;
    status?: "VEHICLE_HANDED_OVER" | "CONFIRMED";
    billableDays?: number;
    actualDurationHours?: number;
    pickup?: Date;
    returnAt?: Date;
    withOccupancy?: boolean;
  }) {
    const pickup = input.pickup ?? hoursFromNow(-24);
    const returnAt = input.returnAt ?? hoursFromNow(48);
    const booking = await prisma.booking.create({
      data: {
        bookingReference: `RVW-${randomBytes(4).toString("hex").toUpperCase()}`,
        status: input.status ?? "VEHICLE_HANDED_OVER",
        vehicleId: input.vehicleId,
        vehicleUnitId: input.unitId,
        vehicleNameSnapshot: `Review NMAX ${testSuffix}`,
        vehicleLicensePlateSnapshot: input.plate,
        vehicleColorSnapshot: "Red",
        vehicleType: "Scooter",
        vehicleTypeSnapshot: "Scooter",
        pickupDateTime: pickup,
        returnDateTime: returnAt,
        handoverDateTime: pickup,
        actualDurationHours: input.actualDurationHours ?? 24,
        billableDays: input.billableDays ?? 2,
        pickupOption: "OFFICE",
        dropoffOption: "OFFICE",
        customerFullName: "Review Guest",
        customerPhone: "+35699000111",
        customerEmail: input.email ?? `review-${testSuffix}@example.com`,
        customerNationality: "Maltese",
        customerDateOfBirth: new Date("1992-04-04"),
        customerLicenseCategory: "B",
        depositMethod: "IN_PERSON",
        depositAmount: 150,
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
        totalDueLater: 150,
        paymentStatus: "PAID",
      },
    });
    bookingIds.push(booking.id);
    if (input.withOccupancy !== false && input.status !== "CONFIRMED") {
      await insertBookingOccupancy(prisma, {
        vehicleUnitId: input.unitId,
        pickupAt: pickup,
        returnAt,
        bookingId: booking.id,
      });
    }
    return booking;
  }

  async function returnBooking(bookingId: string) {
    return markVehicleReturned(
      bookingId,
      {
        returnRecordedAt: new Date(),
        unitStatusAfterReturn: "AVAILABLE",
        note: "Returned at office",
      },
      adminId!,
    );
  }

  try {
    const admin = await prisma.adminUser.create({
      data: {
        name: "Review Request Test",
        email: `review-admin-${testSuffix}@test.local`,
        role: "STAFF",
      },
    });
    adminId = admin.id;

    const fleet = await createVehicle([
      { color: "Red", status: "OUT_WITH_CUSTOMER" },
      { color: "Black", status: "AVAILABLE" },
    ]);
    const unit = fleet.units[0]!;
    const booking = await createBooking({
      vehicleId: fleet.id,
      unitId: unit.id,
      plate: unit.licensePlate,
      email: `review-${testSuffix}@example.com`,
    });

    const beforeReturn = Date.now();
    const returned = await returnBooking(booking.id);
    assert.equal(returned.ok, true);
    if (!returned.ok) return;
    assert.equal(returned.booking.status, "RETURNED");
    assert.equal(returned.booking.reviewRequest?.status, "PENDING");
    assert.equal(returned.booking.reviewRequest?.sentAt, null);
    assert.equal(returned.booking.paymentStatus, "PAID");
    assert.equal(returned.booking.depositAmount, 150);

    const scheduledAt = new Date(returned.booking.reviewRequest!.scheduledAt);
    const delay = scheduledAt.getTime() - beforeReturn;
    assert.ok(delay >= 60 * 1000 - 5_000);
    assert.ok(delay <= 5 * 60 * 1000 + 30_000);

    const unitAfterReturn = await prisma.vehicleUnit.findUnique({ where: { id: unit.id } });
    assert.equal(unitAfterReturn?.status, "AVAILABLE");

    const queued = await prisma.emailLog.findMany({
      where: { bookingId: booking.id, emailType: "REVIEW_REQUEST" },
    });
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.status, "QUEUED");
    assert.equal(queued[0]?.sentAt, null);
    logPass("return schedules one review request and does not send it");

    const duplicate = await returnBooking(booking.id);
    assert.equal(duplicate.ok, false);
    if (duplicate.ok) return;
    assert.equal(duplicate.reason, "invalid_status");
    assert.equal(await prisma.bookingReviewRequest.count({ where: { bookingId: booking.id } }), 1);
    logPass("a repeated return does not schedule another review request");

    const early = createSender();
    const notDue = await processDueReviewRequests({
      bookingId: booking.id,
      send: early.send,
      now: new Date(scheduledAt.getTime() - 60_000),
    });
    assert.equal(notDue.sent, 0);
    assert.equal(early.calls.length, 0);
    logPass("a review request is not sent before it is due");

    const previousReviewUrl = process.env.GOOGLE_REVIEW_URL;
    process.env.GOOGLE_REVIEW_URL = reviewUrl;
    const sender = createSender();
    const due = await processDueReviewRequests({
      bookingId: booking.id,
      send: sender.send,
      now: new Date(scheduledAt.getTime() + 1_000),
    });
    if (previousReviewUrl === undefined) delete process.env.GOOGLE_REVIEW_URL;
    else process.env.GOOGLE_REVIEW_URL = previousReviewUrl;
    assert.equal(due.sent, 1);
    assert.equal(sender.calls.length, 1);
    assert.equal(sender.calls[0]?.to, `review-${testSuffix}@example.com`);
    assert.match(sender.calls[0]?.html ?? "", /https:\/\/example\.com\/google-review/);
    assert.match(sender.calls[0]?.html ?? "", /Leave a Google Review/);
    assert.match(sender.calls[0]?.html ?? "", /€5 off your next rental/);
    assert.match(sender.calls[0]?.text ?? "", /does not depend on leaving a Google review/);
    assert.match(sender.calls[0]?.text ?? "", new RegExp(booking.bookingReference));
    assert.doesNotMatch(sender.calls[0]?.html ?? "", /leave a review to receive|once you review|deposit/i);

    const sentRequest = await prisma.bookingReviewRequest.findUnique({ where: { bookingId: booking.id } });
    assert.equal(sentRequest?.status, "SENT");
    assert.ok(sentRequest?.sentAt);
    const sentLog = await prisma.emailLog.findFirst({
      where: { bookingId: booking.id, status: "SENT", emailType: "REVIEW_REQUEST" },
    });
    assert.ok(sentLog);
    logPass("a due review request sends the configured Google review link");

    const again = createSender();
    const duplicateSend = await processDueReviewRequests({
      bookingId: booking.id,
      send: again.send,
      now: new Date(scheduledAt.getTime() + 60_000),
    });
    assert.equal(duplicateSend.sent, 0);
    assert.equal(again.calls.length, 0);
    logPass("the processor does not send a second automatic review email");

    const sentAtBeforeResend = sentRequest!.sentAt!;
    const resendSender = createSender();
    const resent = await resendBookingReviewRequest(booking.id, admin.id, {
      send: resendSender.send,
      now: new Date(sentAtBeforeResend.getTime() + 60_000),
    });
    assert.equal(resent.ok, true, resent.ok ? "" : `${resent.reason}: ${resent.message}`);
    assert.equal(resendSender.calls.length, 1);
    const afterResend = await prisma.bookingReviewRequest.findUnique({ where: { bookingId: booking.id } });
    assert.equal(afterResend?.sentAt?.toISOString(), sentAtBeforeResend.toISOString());
    assert.equal(afterResend?.manualResendCount, 1);
    assert.equal(afterResend?.lastManualResendByAdminId, admin.id);
    assert.ok(afterResend?.lastSentAt && afterResend.lastSentAt >= sentAtBeforeResend);
    const bookingAfterResend = await prisma.booking.findUnique({ where: { id: booking.id } });
    assert.equal(bookingAfterResend?.status, "RETURNED");
    assert.equal(bookingAfterResend?.paymentStatus, "PAID");
    assert.equal(bookingAfterResend?.depositAmount.toNumber(), 150);
    const manualLog = await prisma.emailLog.findFirst({
      where: { bookingId: booking.id, initiatedByAdminId: admin.id, status: "SENT" },
    });
    assert.ok(manualLog);
    logPass("manual resend sends again without changing the rental");

    const failedResend = await resendBookingReviewRequest(booking.id, admin.id, {
      send: createSender("fail").send,
    });
    assert.equal(failedResend.ok, false);
    const afterFailedResend = await prisma.bookingReviewRequest.findUnique({ where: { bookingId: booking.id } });
    assert.equal(afterFailedResend?.status, "SENT");
    assert.equal(afterFailedResend?.sentAt?.toISOString(), sentAtBeforeResend.toISOString());
    assert.equal(afterFailedResend?.manualResendCount, 1);
    assert.match(afterFailedResend?.lastError ?? "", /provider down/);
    assert.equal((await prisma.booking.findUnique({ where: { id: booking.id } }))?.status, "RETURNED");
    logPass("a failed manual resend keeps the earlier sent timestamp");

    const failureFleet = await createVehicle([{ color: "Blue", status: "OUT_WITH_CUSTOMER" }]);
    const failureUnit = failureFleet.units[0]!;
    const failureBooking = await createBooking({
      vehicleId: failureFleet.id,
      unitId: failureUnit.id,
      plate: failureUnit.licensePlate,
      email: `review-fail-${testSuffix}@example.com`,
    });
    const failureReturn = await returnBooking(failureBooking.id);
    assert.equal(failureReturn.ok, true);
    await prisma.bookingReviewRequest.update({
      where: { bookingId: failureBooking.id },
      data: { scheduledAt: new Date(Date.now() - 1_000) },
    });
    const failedSend = await processDueReviewRequests({
      bookingId: failureBooking.id,
      send: createSender("fail").send,
    });
    assert.equal(failedSend.failed, 1);
    const failedRequest = await prisma.bookingReviewRequest.findUnique({ where: { bookingId: failureBooking.id } });
    assert.equal(failedRequest?.status, "PENDING");
    assert.equal(failedRequest?.attempts, 1);
    assert.match(failedRequest?.lastError ?? "", /provider down/);
    assert.equal((await prisma.booking.findUnique({ where: { id: failureBooking.id } }))?.status, "RETURNED");
    assert.equal((await prisma.vehicleUnit.findUnique({ where: { id: failureUnit.id } }))?.status, "AVAILABLE");

    await prisma.bookingReviewRequest.update({
      where: { bookingId: failureBooking.id },
      data: { attempts: 2, scheduledAt: new Date(Date.now() - 1_000), status: "PENDING" },
    });
    await processDueReviewRequests({
      bookingId: failureBooking.id,
      send: createSender("fail").send,
    });
    const exhausted = await prisma.bookingReviewRequest.findUnique({ where: { bookingId: failureBooking.id } });
    assert.equal(exhausted?.status, "FAILED");
    assert.equal(exhausted?.attempts, 3);
    assert.equal((await prisma.booking.findUnique({ where: { id: failureBooking.id } }))?.status, "RETURNED");
    logPass("email failure leaves the booking returned and stays retryable, then failed");

    const missingFleet = await createVehicle([{ color: "White", status: "OUT_WITH_CUSTOMER" }]);
    const missingUnit = missingFleet.units[0]!;
    const missingBooking = await createBooking({
      vehicleId: missingFleet.id,
      unitId: missingUnit.id,
      plate: missingUnit.licensePlate,
      email: "not-an-email",
    });
    const missingReturn = await returnBooking(missingBooking.id);
    assert.equal(missingReturn.ok, true);
    if (missingReturn.ok) {
      assert.equal(missingReturn.booking.status, "RETURNED");
      assert.equal(missingReturn.booking.reviewRequest?.status, "SKIPPED");
    }
    const skippedSend = createSender();
    await processDueReviewRequests({ bookingId: missingBooking.id, send: skippedSend.send, now: hoursFromNow(1) });
    assert.equal(skippedSend.calls.length, 0);
    assert.equal((await prisma.vehicleUnit.findUnique({ where: { id: missingUnit.id } }))?.status, "AVAILABLE");
    logPass("a missing customer email does not block the return");

    const shortFleet = await createVehicle([{ color: "Grey", status: "OUT_WITH_CUSTOMER" }]);
    const shortUnit = shortFleet.units[0]!;
    const shortBooking = await createBooking({
      vehicleId: shortFleet.id,
      unitId: shortUnit.id,
      plate: shortUnit.licensePlate,
      email: `review-short-${testSuffix}@example.com`,
      billableDays: 1,
      actualDurationHours: 4,
      pickup: hoursFromNow(-4),
      returnAt: hoursFromNow(1),
    });
    const shortReturn = await returnBooking(shortBooking.id);
    assert.equal(shortReturn.ok, true);
    if (shortReturn.ok) assert.equal(shortReturn.booking.reviewRequest?.status, "PENDING");
    const completed = await completeBooking(
      shortBooking.id,
      {
        depositOutcome: "REFUNDED",
        depositRefundAmount: 0,
        unitStatusAfterCompletion: "AVAILABLE",
      },
      admin.id,
    );
    assert.equal(completed.ok, true);
    assert.equal(await prisma.bookingReviewRequest.count({ where: { bookingId: shortBooking.id } }), 1);
    assert.equal((await prisma.booking.findUnique({ where: { id: shortBooking.id } }))?.status, "COMPLETED");
    logPass("a short rental returns once and completion does not create another request");

    const extendFleet = await createVehicle([{ color: "Green", status: "OUT_WITH_CUSTOMER" }]);
    const extendUnit = extendFleet.units[0]!;
    const extendStart = hoursFromNow(-12);
    const extendReturn = hoursFromNow(36);
    const extendBookingRow = await createBooking({
      vehicleId: extendFleet.id,
      unitId: extendUnit.id,
      plate: extendUnit.licensePlate,
      email: `review-extend-${testSuffix}@example.com`,
      pickup: extendStart,
      returnAt: extendReturn,
      billableDays: 2,
    });
    const extended = await extendBooking(
      extendBookingRow.id,
      hoursFromNow(84),
      admin.id,
      extendBookingRow.updatedAt,
    );
    assert.equal(extended.ok, true, extended.ok ? "" : extended.reason);
    const afterExtend = await prisma.booking.findUnique({ where: { id: extendBookingRow.id } });
    const extendReturnResult = await returnBooking(extendBookingRow.id);
    assert.equal(extendReturnResult.ok, true);
    const afterReturn = await prisma.booking.findUnique({ where: { id: extendBookingRow.id } });
    assert.equal(afterReturn?.rentalCost.toString(), afterExtend?.rentalCost.toString());
    assert.equal(afterReturn?.subtotal.toString(), afterExtend?.subtotal.toString());
    assert.equal(afterReturn?.billableDays, afterExtend?.billableDays);
    assert.equal(afterReturn?.returnDateTime.toISOString(), afterExtend?.returnDateTime.toISOString());
    assert.equal(await prisma.bookingExtension.count({ where: { bookingId: extendBookingRow.id } }), 1);
    assert.equal((await prisma.bookingReviewRequest.findUnique({ where: { bookingId: extendBookingRow.id } }))?.status, "PENDING");
    logPass("returning an extended booking keeps the extension and schedules a review");

    const replaceFleet = await createVehicle([
      { color: "Orange", status: "OUT_WITH_CUSTOMER" },
      { color: "Silver", status: "AVAILABLE" },
    ]);
    const originalUnit = replaceFleet.units[0]!;
    const nextUnit = replaceFleet.units[1]!;
    const replaceBooking = await createBooking({
      vehicleId: replaceFleet.id,
      unitId: originalUnit.id,
      plate: originalUnit.licensePlate,
      email: `review-replace-${testSuffix}@example.com`,
    });
    const replaced = await replaceBookingVehicle(
      replaceBooking.id,
      {
        vehicleUnitId: nextUnit.id,
        previousUnitStatus: "MAINTENANCE",
        reason: "mechanical_issue",
        note: "Engine warning",
        expectedUpdatedAt: replaceBooking.updatedAt,
        expectedVehicleUnitId: originalUnit.id,
      },
      admin.id,
    );
    assert.equal(replaced.ok, true, replaced.ok ? "" : replaced.reason);
    const replaceReturn = await returnBooking(replaceBooking.id);
    assert.equal(replaceReturn.ok, true);
    assert.equal((await prisma.vehicleUnit.findUnique({ where: { id: originalUnit.id } }))?.status, "MAINTENANCE");
    assert.equal((await prisma.vehicleUnit.findUnique({ where: { id: nextUnit.id } }))?.status, "AVAILABLE");
    assert.equal((await prisma.booking.findUnique({ where: { id: replaceBooking.id } }))?.vehicleUnitId, nextUnit.id);
    assert.equal((await prisma.bookingReviewRequest.findUnique({ where: { bookingId: replaceBooking.id } }))?.status, "PENDING");
    logPass("a replaced vehicle is returned and still schedules a review request");

    const confirmedFleet = await createVehicle([{ color: "Yellow", status: "AVAILABLE" }]);
    const confirmedUnit = confirmedFleet.units[0]!;
    const confirmed = await createBooking({
      vehicleId: confirmedFleet.id,
      unitId: confirmedUnit.id,
      plate: confirmedUnit.licensePlate,
      email: `review-confirmed-${testSuffix}@example.com`,
      status: "CONFIRMED",
      withOccupancy: false,
    });
    const rejectedResend = await resendBookingReviewRequest(confirmed.id, admin.id, { send: createSender().send });
    assert.equal(rejectedResend.ok, false);
    if (!rejectedResend.ok) assert.equal(rejectedResend.reason, "invalid_status");
    assert.equal(await prisma.bookingReviewRequest.count({ where: { bookingId: confirmed.id } }), 0);
    logPass("a review email cannot be sent before the vehicle is returned");

    const { POST } = await import("../src/app/api/admin/bookings/[id]/review-request/resend/route");
    let unauthorizedStatus: number | null = null;
    try {
      const response = await POST(new Request("http://localhost/api/admin/bookings/x/review-request/resend", { method: "POST" }), {
        params: Promise.resolve({ id: booking.id }),
      });
      unauthorizedStatus = response.status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /cookies|request|Unauthorized/i);
      unauthorizedStatus = 401;
    }
    assert.equal(unauthorizedStatus, 401);

    const { GET } = await import("../src/app/api/cron/review-requests/route");
    const cronResponse = await GET(new Request("http://localhost/api/cron/review-requests", {
      headers: { authorization: "Bearer definitely-not-the-secret" },
    }));
    assert.ok(cronResponse.status === 401 || cronResponse.status === 503);
    logPass("review resend and cron routes reject unauthorized callers");
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  runPureTests();
  await runDatabaseTests();
  console.log("Review request checks passed.");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
