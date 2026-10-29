import { randomBytes } from "node:crypto";
import { format } from "date-fns";

import { Prisma, type VehicleType } from "@/generated/prisma/index";
import { colorsMatch, parseVehicleColorValue } from "@/features/vehicles/lib/vehicle-color";
import {
  checkVehicleAvailability,
  type AvailabilityDbClient,
} from "@/lib/availability";
import {
  assignAvailableVehicleUnit,
  NoAvailableVehicleUnitError,
} from "@/lib/vehicle-units";
import {
  convertHoldOccupancyToBooking,
  insertBookingOccupancy,
  isVehicleUnitOccupancyExclusionError,
} from "@/lib/vehicle-unit-occupancy";
import { notifyBookingCreated } from "@/lib/admin/notifications";
import { deliverBookingConfirmationIfNeeded } from "@/lib/email/deliverBookingConfirmation";
import { prisma } from "@/lib/prisma";
import { isLicenseAllowedForEngine } from "@/lib/vehicles/engine-cc";
import {
  calculateBookingPrice,
  pricingConfig,
  type BookingPriceBreakdown,
  type BookingPricingInput,
  type PricingCdwOption,
} from "@/lib/pricing/calculate-booking-price";
import { validateHotelCode, type ValidatedHotelCode } from "@/lib/hotel-codes";
import {
  chargesAfterLoyalty,
  redeemOldestAvailableLoyaltyCredit,
} from "@/lib/loyalty/loyalty-credit";
import { roundPricingAmount } from "@/lib/pricing/duration-pricing";

import { validateBookingPayload } from "./validateBookingPayload";
import { validateStorageBoxSelection } from "./validateStorageBoxSelection";
import type { BookingSubmissionInput, NormalizedBookingPayload, ValidationError } from "./types";

const BOOKING_REFERENCE_PREFIX = "EMR";
const BOOKING_REFERENCE_RETRY_LIMIT = 5;
/** Heartbeat updates the same hold row outside this tx; Serializable + Turso/SQLite often returns P2034. */
const TRANSACTION_WRITE_CONFLICT_RETRY_LIMIT = 10;
/**
 * Neon serverless can take several seconds to wake; booking finalize does many
 * Serializable queries (hold validate, availability, unit assign, occupancy).
 * 30s was timing out in practice (P2028) before Stripe checkout could start.
 */
const BOOKING_TRANSACTION_TIMEOUT_MS = 60_000;
const TRANSACTION_TIMEOUT_RETRY_LIMIT = 3;
const TRANSACTION_TIMEOUT_RETRY_DELAYS_MS = [500, 1500, 3000];

type PricingComputation = {
  breakdown: BookingPriceBreakdown;
  cdwDailyRate: number;
  additionalDriverDailyRate: number;
  resolvedCdwOption: NormalizedBookingPayload["addons"]["cdwOption"];
  baseDailyRateSnapshot: number;
  durationDiscountPercentSnapshot: number;
  appliedDailyRateSnapshot: number;
  validatedHotelCode: ValidatedHotelCode | null;
};

type ResolvedBookingVehicle = {
  vehicleId: string;
  vehicleUnitId?: string;
  vehicleNameSnapshot: string;
  vehicleLicensePlateSnapshot: string;
  vehicleColorSnapshot: string | null;
  vehicleType: VehicleType;
  vehicleTypeSnapshot: VehicleType;
  baseDailyRate: number;
  supportsStorageBox: boolean;
};

export type SubmitBookingResponse = {
  bookingReference: string;
  bookingId: string;
  /** Amount in euros that must be paid online. 0 means no online payment required. */
  totalDueOnline: number;
};

type AvailabilityConflictContext = {
  vehicleId: string | null;
  vehicleType: VehicleType;
  requestedStart: Date;
  requestedEnd: Date;
};

type HoldAvailabilityContext = {
  excludeHoldReference?: string;
  excludeSessionKey?: string;
};

type HoldForFinalization = {
  id: string;
  holdReference: string;
  sessionKey: string;
};

export class SubmitBookingValidationError extends Error {
  readonly errors: ValidationError[];

  constructor(errors: ValidationError[]) {
    super("Booking payload validation failed");
    this.name = "SubmitBookingValidationError";
    this.errors = errors;
  }
}

export class AvailabilityConflictError extends Error {
  readonly context: AvailabilityConflictContext;

  constructor(message: string, context: AvailabilityConflictContext) {
    super(message);
    this.name = "AvailabilityConflictError";
    this.context = context;
  }
}

function generateBookingReference(now = new Date()): string {
  const datePart = format(now, "yyyyMMdd");
  const randomPart = randomBytes(2).toString("hex").toUpperCase();
  return `${BOOKING_REFERENCE_PREFIX}-${datePart}-${randomPart}`;
}

function mapPickupOptionForPricing(option: NormalizedBookingPayload["pickupOption"]): "office" | "delivery" {
  return option === "DELIVERY" ? "delivery" : "office";
}

function mapDropoffOptionForPricing(option: NormalizedBookingPayload["dropoffOption"]): "office" | "dropoff" {
  return option === "DROPOFF" ? "dropoff" : "office";
}

function mapDepositMethodForPricing(
  method: NormalizedBookingPayload["deposit"]["depositMethod"],
): "online" | "in_person" {
  return method === "ONLINE" ? "online" : "in_person";
}

function mapCdwOptionForPricing(option: NormalizedBookingPayload["addons"]["cdwOption"]): PricingCdwOption {
  switch (option) {
    case "REDUCE_350_50CC":
      return "cdw_50cc_reduced_350";
    case "REDUCE_500_125CC":
      return "cdw_125cc_reduced_500";
    case "FULL_COVERAGE_50CC_125CC":
      return "cdw_full_50cc_125cc";
    case "REDUCE_800_ATV":
      return "cdw_atv_reduced_800";
    default:
      return "no_cdw";
  }
}

function mapCdwOptionFromPricing(option: PricingCdwOption): NormalizedBookingPayload["addons"]["cdwOption"] {
  switch (option) {
    case "cdw_50cc_reduced_350":
      return "REDUCE_350_50CC";
    case "cdw_125cc_reduced_500":
      return "REDUCE_500_125CC";
    case "cdw_full_50cc_125cc":
      return "FULL_COVERAGE_50CC_125CC";
    case "cdw_atv_reduced_800":
      return "REDUCE_800_ATV";
    default:
      return "NO_CDW";
  }
}

function toPricingInput(
  payload: NormalizedBookingPayload,
  vehicle: ResolvedBookingVehicle,
): Omit<BookingPricingInput, "vehiclePricing"> {
  return {
    rental: {
      vehicle: {
        id: vehicle.vehicleId ?? undefined,
        name: vehicle.vehicleNameSnapshot ?? undefined,
        type: vehicle.vehicleType,
      },
      pickupDate: format(payload.pickupDateTime, "yyyy-MM-dd"),
      pickupTime: format(payload.pickupDateTime, "HH:mm"),
      returnDate: format(payload.returnDateTime, "yyyy-MM-dd"),
      returnTime: format(payload.returnDateTime, "HH:mm"),
    },
    delivery: {
      pickupOption: mapPickupOptionForPricing(payload.pickupOption),
      pickupAddress: payload.pickupAddress ?? undefined,
      dropoffOption: mapDropoffOptionForPricing(payload.dropoffOption),
      dropoffAddress: payload.dropoffAddress ?? undefined,
    },
    addons: {
      cdwOption: mapCdwOptionForPricing(payload.addons.cdwOption),
      additionalDriver: payload.additionalDriver.enabled,
      storageBox: payload.addons.storageBoxSelected,
      helmetSize1: payload.addons.helmetSize1 ?? undefined,
      helmetSize2: payload.addons.helmetSize2 ?? undefined,
    },
    additionalDriver: {
      enabled: payload.additionalDriver.enabled,
    },
    deposit: {
      method: mapDepositMethodForPricing(payload.deposit.depositMethod),
    },
  };
}

function computePricing(
  payload: NormalizedBookingPayload,
  vehicle: ResolvedBookingVehicle,
  validatedHotelCode: ValidatedHotelCode | null,
): PricingComputation | null {
  const breakdown = calculateBookingPrice({
    ...toPricingInput(payload, vehicle),
    vehiclePricing: {
      baseDailyRate: vehicle.baseDailyRate,
      vehicleType: vehicle.vehicleType,
      supportsStorageBox: vehicle.supportsStorageBox,
    },
    hotelDiscount: validatedHotelCode
      ? { discountPercent: validatedHotelCode.discountPercent }
      : undefined,
  });
  if (!breakdown) {
    return null;
  }

  return {
    breakdown,
    cdwDailyRate: pricingConfig.cdwPerDay[breakdown.cdwOptionApplied],
    additionalDriverDailyRate: payload.additionalDriver.enabled
      ? pricingConfig.addons.additionalDriverPerDay
      : 0,
    resolvedCdwOption: mapCdwOptionFromPricing(breakdown.cdwOptionApplied),
    baseDailyRateSnapshot: breakdown.baseDailyRate,
    durationDiscountPercentSnapshot: breakdown.durationDiscountPercent,
    appliedDailyRateSnapshot: breakdown.appliedDailyRate,
    validatedHotelCode,
  };
}

function isBookingReferenceUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("bookingReference");
  }

  if (typeof target === "string") {
    return target.includes("bookingReference");
  }

  return false;
}

function isIdempotencyKeyUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }

  const target = error.meta?.target;
  if (Array.isArray(target)) {
    return target.includes("idempotencyKey");
  }

  if (typeof target === "string") {
    return target.includes("idempotencyKey");
  }

  return false;
}

function isTransactionWriteConflictError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}

function isTransactionTimeoutError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028";
}

function transactionConflictBackoffMs(attemptIndex: number): number {
  const jitter = 20 + Math.floor(Math.random() * 60);
  return jitter + attemptIndex * 40;
}

async function resolveBookingVehicle(payload: NormalizedBookingPayload): Promise<ResolvedBookingVehicle> {
  // Bookings must target one physical vehicle (vehicleId). Legacy type-only availability
  // (checkVehicleTypeAvailability without vehicleId) is intentionally blocked here.
  if (!payload.vehicleId) {
    throw new SubmitBookingValidationError([
      { path: "rental.vehicleId", message: "A specific vehicle must be selected for booking" },
    ]);
  }

  const vehicle = await prisma.vehicle.findUnique({
    where: { id: payload.vehicleId },
    select: {
      id: true,
      name: true,
      vehicleType: true,
      engineCc: true,
      baseDailyRate: true,
      isActive: true,
      supportsStorageBox: true,
    },
  });

  if (!vehicle) {
    throw new SubmitBookingValidationError([
      { path: "rental.vehicleId", message: "Selected vehicle not found" },
    ]);
  }

  if (!vehicle.isActive) {
    throw new SubmitBookingValidationError([
      { path: "rental.vehicleId", message: "Selected vehicle is not active" },
    ]);
  }

  if (vehicle.vehicleType !== payload.vehicleType) {
    throw new SubmitBookingValidationError([
      { path: "rental.vehicleType", message: "Vehicle type does not match selected vehicle" },
    ]);
  }

  if (
    !isLicenseAllowedForEngine(
      vehicle.vehicleType,
      payload.customer.licenseCategory,
      vehicle.engineCc,
    )
  ) {
    throw new SubmitBookingValidationError([
      { path: "customer.licenseCategory", message: "Invalid license category for selected vehicle" },
    ]);
  }

  if (
    payload.additionalDriver.enabled &&
    payload.additionalDriver.licenseCategory &&
    !isLicenseAllowedForEngine(
      vehicle.vehicleType,
      payload.additionalDriver.licenseCategory,
      vehicle.engineCc,
    )
  ) {
    throw new SubmitBookingValidationError([
      {
        path: "additionalDriver.licenseCategory",
        message: "Invalid license category for selected vehicle",
      },
    ]);
  }

  if (vehicle.baseDailyRate.toNumber() <= 0) {
    throw new SubmitBookingValidationError([
      { path: "rental.vehicleId", message: "Selected vehicle does not have a valid base daily rate" },
    ]);
  }

  return {
    vehicleId: vehicle.id,
    vehicleNameSnapshot: vehicle.name,
    vehicleLicensePlateSnapshot: "",
    vehicleColorSnapshot: payload.selectedColor,
    vehicleType: vehicle.vehicleType,
    vehicleTypeSnapshot: vehicle.vehicleType,
    baseDailyRate: vehicle.baseDailyRate.toNumber(),
    supportsStorageBox: vehicle.supportsStorageBox,
  };
}

async function getActiveTermsVersionId(): Promise<string | null> {
  const activeTerms = await prisma.termsVersion.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  return activeTerms?.id ?? null;
}

async function assertBookingStillAvailable(
  payload: NormalizedBookingPayload,
  vehicle: ResolvedBookingVehicle,
  db: AvailabilityDbClient,
  holdContext?: HoldAvailabilityContext,
): Promise<void> {
  const availabilityColor = payload.selectedColor
    ? parseVehicleColorValue(payload.selectedColor) ?? undefined
    : undefined;

  const availability = await checkVehicleAvailability(
    {
      vehicleId: vehicle.vehicleId,
      vehicleType: vehicle.vehicleType,
      requestedStart: payload.pickupDateTime,
      requestedEnd: payload.returnDateTime,
      color: availabilityColor,
      excludeHoldReference: holdContext?.excludeHoldReference,
      excludeSessionKey: holdContext?.excludeSessionKey,
    },
    db,
    db as unknown as typeof prisma,
  );

  if (!availability.isAvailable) {
    const message = payload.selectedColor
      ? "The selected color is not available for the chosen dates"
      : "Selected vehicle is not available for the chosen dates";
    throw new AvailabilityConflictError(message, {
        vehicleId: vehicle.vehicleId,
        vehicleType: vehicle.vehicleType,
        requestedStart: payload.pickupDateTime,
        requestedEnd: payload.returnDateTime,
      },
    );
  }
}

function mapBookingCreateData(
  bookingReference: string,
  payload: NormalizedBookingPayload,
  pricing: PricingComputation,
  vehicle: ResolvedBookingVehicle,
  termsVersionId: string | null,
): Prisma.BookingUncheckedCreateInput {
  const isAlreadyPaid = payload.payment.mode === "ALREADY_PAID";
  const requiresOnlinePayment = !isAlreadyPaid && pricing.breakdown.totalDueOnline > 0;
  const depositAmount = pricing.breakdown.depositAmount;
  const payableAmount = pricing.breakdown.subtotal + depositAmount;

  return {
    bookingReference,
    // Already-paid hotel bookings are confirmed immediately.
    // Online Stripe checkout soft-reserves until payment succeeds.
    status: requiresOnlinePayment ? "PENDING_PAYMENT" : "CONFIRMED",
    paymentStatus: isAlreadyPaid ? "PAID" : "PENDING",
    securityDepositStatus: isAlreadyPaid ? "COLLECTED" : "PENDING",
    paymentProofUploadPath: isAlreadyPaid ? payload.payment.proofPath : null,
    paymentMethod: isAlreadyPaid ? "OTHER" : null,
    paymentReceivedAmount: isAlreadyPaid ? payableAmount : null,
    securityDepositCollectedAmount: isAlreadyPaid ? depositAmount : null,
    vehicleId: vehicle.vehicleId,
    vehicleUnitId: vehicle.vehicleUnitId ?? null,
    vehicleNameSnapshot: vehicle.vehicleNameSnapshot,
    vehicleLicensePlateSnapshot: vehicle.vehicleLicensePlateSnapshot,
    vehicleColorSnapshot: vehicle.vehicleColorSnapshot,
    vehicleTypeSnapshot: vehicle.vehicleTypeSnapshot,
    termsVersionId,
    vehicleType: vehicle.vehicleType,
    pickupDateTime: payload.pickupDateTime,
    returnDateTime: payload.returnDateTime,
    actualDurationHours: pricing.breakdown.actualDurationHours,
    billableDays: pricing.breakdown.rentalDays,
    pickupOption: payload.pickupOption,
    pickupAddress: payload.pickupAddress,
    pickupLatitude: payload.pickupLatitude,
    pickupLongitude: payload.pickupLongitude,
    dropoffOption: payload.dropoffOption,
    dropoffAddress: payload.dropoffAddress,
    dropoffLatitude: payload.dropoffLatitude,
    dropoffLongitude: payload.dropoffLongitude,
    customerFullName: payload.customer.fullName,
    customerPhone: payload.customer.phone,
    customerEmail: payload.customer.email,
    customerNationality: payload.customer.nationality,
    customerDateOfBirth: payload.customer.dateOfBirth,
    customerLicenseCategory: payload.customer.licenseCategory,
    customerSpecialNotes: payload.customer.specialNotes,
    customerLicenseUploadPath: payload.customer.licenseUploadPath,
    customerPassportUploadPath: payload.customer.passportUploadPath,
    customerWillPresentLicenseAtPickup: payload.customer.willPresentLicenseAtPickup,
    customerWillPresentIdAtPickup: payload.customer.willPresentIdAtPickup,
    additionalDriverEnabled: payload.additionalDriver.enabled,
    additionalDriverFullName: payload.additionalDriver.fullName,
    additionalDriverPhone: payload.additionalDriver.phone,
    additionalDriverEmail: payload.additionalDriver.email,
    additionalDriverNationality: payload.additionalDriver.nationality,
    additionalDriverDateOfBirth: payload.additionalDriver.dateOfBirth,
    additionalDriverLicenseCategory: payload.additionalDriver.licenseCategory,
    additionalDriverLicenseUploadPath: payload.additionalDriver.licenseUploadPath,
    additionalDriverPassportUploadPath: payload.additionalDriver.passportUploadPath,
    additionalDriverWillPresentLicenseAtPickup: payload.additionalDriver.willPresentLicenseAtPickup,
    additionalDriverWillPresentIdAtPickup: payload.additionalDriver.willPresentIdAtPickup,
    cdwOption: pricing.resolvedCdwOption,
    cdwDailyRate: pricing.cdwDailyRate,
    cdwTotal: pricing.breakdown.cdwCost,
    additionalDriverDailyRate: pricing.additionalDriverDailyRate,
    additionalDriverTotal: pricing.breakdown.additionalDriverCost,
    helmetSize1: payload.addons.helmetSize1,
    helmetSize2: payload.addons.helmetSize2,
    storageBoxSelected: vehicle.supportsStorageBox && payload.addons.storageBoxSelected,
    storageBoxCost: pricing.breakdown.storageBoxCost,
    baseDailyRateSnapshot: pricing.baseDailyRateSnapshot,
    durationDiscountPercentSnapshot: pricing.durationDiscountPercentSnapshot,
    appliedDailyRateSnapshot: pricing.appliedDailyRateSnapshot,
    rentalCost: pricing.breakdown.rentalCost,
    hotelCodeId: pricing.validatedHotelCode?.hotelCodeId ?? null,
    hotelPartnerId: pricing.validatedHotelCode?.hotelPartnerId ?? null,
    hotelCodeSnapshot: pricing.validatedHotelCode?.code ?? null,
    hotelPartnerNameSnapshot: pricing.validatedHotelCode?.partnerName ?? null,
    hotelDiscountPercentSnapshot: pricing.breakdown.hotelDiscountPercent || null,
    hotelDiscountAmountSnapshot: pricing.breakdown.hotelDiscountAmount || null,
    subtotalAfterHotelDiscountSnapshot:
      pricing.breakdown.hotelDiscountAmount > 0
        ? pricing.breakdown.rentalCostAfterHotelDiscount
        : null,
    deliveryFee: pricing.breakdown.deliveryFee,
    dropoffFee: pricing.breakdown.dropoffFee,
    deliveryTotal: pricing.breakdown.deliveryTotal,
    subtotal: pricing.breakdown.subtotal,
    depositAmount,
    depositMethod: isAlreadyPaid ? "IN_PERSON" : payload.deposit.depositMethod,
    totalDueOnline: isAlreadyPaid ? 0 : pricing.breakdown.totalDueOnline,
    totalDueLater: isAlreadyPaid ? 0 : pricing.breakdown.totalDueLater,
    termsAccepted: payload.consent.termsAccepted,
    termsAcceptedAt: payload.consent.termsAcceptedAt,
    idempotencyKey: payload.idempotencyKey,
  };
}

async function validateHoldForBooking(
  payload: NormalizedBookingPayload,
  vehicle: ResolvedBookingVehicle,
  tx: Prisma.TransactionClient,
): Promise<HoldForFinalization> {
  if (!payload.holdReference) {
    throw new SubmitBookingValidationError([
      {
        path: "holdReference",
        message: "A hold reference is required for this booking flow",
      },
    ]);
  }

  const hold = await tx.reservationHold.findUnique({
    where: { holdReference: payload.holdReference },
    select: {
      id: true,
      holdReference: true,
      sessionKey: true,
      vehicleId: true,
      vehicleType: true,
      pickupDateTime: true,
      returnDateTime: true,
      selectedColor: true,
      status: true,
      expiresAt: true,
    },
  });

  if (!hold) {
    throw new AvailabilityConflictError("Reservation hold is invalid or unavailable", {
      vehicleId: vehicle.vehicleId,
      vehicleType: vehicle.vehicleType,
      requestedStart: payload.pickupDateTime,
      requestedEnd: payload.returnDateTime,
    });
  }

  if (hold.status === "ACTIVE" && hold.expiresAt <= new Date()) {
    await tx.reservationHold.update({
      where: { id: hold.id },
      data: { status: "EXPIRED" },
    });
    throw new AvailabilityConflictError("Reservation hold has expired", {
      vehicleId: vehicle.vehicleId,
      vehicleType: vehicle.vehicleType,
      requestedStart: payload.pickupDateTime,
      requestedEnd: payload.returnDateTime,
    });
  }

  if (hold.status !== "ACTIVE") {
    throw new AvailabilityConflictError("Reservation hold is no longer active", {
      vehicleId: vehicle.vehicleId,
      vehicleType: vehicle.vehicleType,
      requestedStart: payload.pickupDateTime,
      requestedEnd: payload.returnDateTime,
    });
  }

  if (!vehicle.vehicleId || hold.vehicleId !== vehicle.vehicleId) {
    throw new SubmitBookingValidationError([
      {
        path: "rental.vehicleId",
        message: "Booking vehicle does not match the held vehicle",
      },
    ]);
  }

  if (hold.vehicleType !== vehicle.vehicleType) {
    throw new SubmitBookingValidationError([
      {
        path: "rental.vehicleType",
        message: "Booking vehicle type does not match the held vehicle",
      },
    ]);
  }

  if (
    hold.pickupDateTime.getTime() !== payload.pickupDateTime.getTime() ||
    hold.returnDateTime.getTime() !== payload.returnDateTime.getTime()
  ) {
    throw new SubmitBookingValidationError([
      {
        path: "rental.pickupDate",
        message: "Booking date range must match the held reservation window",
      },
    ]);
  }

  if (
    hold.selectedColor &&
    payload.selectedColor &&
    !colorsMatch(hold.selectedColor, payload.selectedColor)
  ) {
    throw new SubmitBookingValidationError([
      {
        path: "rental.selectedColor",
        message: "Booking color does not match the held reservation",
      },
    ]);
  }

  if (hold.selectedColor && !payload.selectedColor) {
    throw new SubmitBookingValidationError([
      {
        path: "rental.selectedColor",
        message: "Color selection is required to match the held reservation",
      },
    ]);
  }

  return {
    id: hold.id,
    holdReference: hold.holdReference,
    sessionKey: hold.sessionKey,
  };
}

async function createBookingWithUniqueReference(
  payload: NormalizedBookingPayload,
  pricing: PricingComputation,
  vehicle: ResolvedBookingVehicle,
  termsVersionId: string | null,
  requireHoldReference: boolean,
) {
  let lastError: unknown = null;

  referenceAttempt: for (let attempt = 0; attempt < BOOKING_REFERENCE_RETRY_LIMIT; attempt += 1) {
    const bookingReference = generateBookingReference();
    const bookingCreateData = mapBookingCreateData(
      bookingReference,
      payload,
      pricing,
      vehicle,
      termsVersionId,
    );

    for (
      let conflictAttempt = 0;
      conflictAttempt < TRANSACTION_WRITE_CONFLICT_RETRY_LIMIT;
      conflictAttempt += 1
    ) {
      try {
        return await prisma.$transaction(
          async (tx) => {
            let holdForFinalization: HoldForFinalization | null = null;
            if (requireHoldReference) {
              holdForFinalization = await validateHoldForBooking(payload, vehicle, tx);
            }

            await assertBookingStillAvailable(
              payload,
              vehicle,
              tx as unknown as AvailabilityDbClient,
              holdForFinalization
                ? {
                    excludeHoldReference: holdForFinalization.holdReference,
                    excludeSessionKey: holdForFinalization.sessionKey,
                  }
                : undefined,
            );

            let assignedUnitId = holdForFinalization
              ? (
                  await tx.reservationHold.findUnique({
                    where: { id: holdForFinalization.id },
                    select: { vehicleUnitId: true },
                  })
                )?.vehicleUnitId
              : null;

            let assignedLicensePlate = "";
            if (assignedUnitId) {
              const heldUnit = await tx.vehicleUnit.findUnique({
                where: { id: assignedUnitId },
                select: { licensePlate: true, vehicleId: true, isActive: true, status: true },
              });
              if (!heldUnit || heldUnit.vehicleId !== vehicle.vehicleId) {
                assignedUnitId = null;
              } else {
                assignedLicensePlate = heldUnit.licensePlate;
              }
            }

            if (!assignedUnitId) {
              const availabilityColor = payload.selectedColor
                ? parseVehicleColorValue(payload.selectedColor) ?? undefined
                : undefined;
              const assigned = await assignAvailableVehicleUnit(
                {
                  vehicleId: vehicle.vehicleId,
                  requestedStart: payload.pickupDateTime,
                  requestedEnd: payload.returnDateTime,
                  color: availabilityColor,
                  excludeHoldReference: holdForFinalization?.holdReference,
                  excludeSessionKey: holdForFinalization?.sessionKey,
                },
                tx,
              );
              assignedUnitId = assigned.vehicleUnitId;
              assignedLicensePlate = assigned.licensePlate;
            }

            const createdBooking = await tx.booking.create({
              data: {
                ...bookingCreateData,
                vehicleUnitId: assignedUnitId,
                vehicleLicensePlateSnapshot: assignedLicensePlate,
              },
            });

            const redemption = await redeemOldestAvailableLoyaltyCredit(tx, {
              customerEmail: payload.customer.email,
              bookingId: createdBooking.id,
              eligibleChargesEur: pricing.breakdown.subtotal,
            });

            let booking = createdBooking;
            if (redemption.applied) {
              const charges = chargesAfterLoyalty(pricing.breakdown.subtotal, redemption.amountEur);
              const depositAmount = pricing.breakdown.depositAmount;
              const isAlreadyPaid = payload.payment.mode === "ALREADY_PAID";
              const depositOnline = !isAlreadyPaid && payload.deposit.depositMethod === "ONLINE";
              const totalDueOnline = isAlreadyPaid
                ? 0
                : depositOnline
                  ? roundPricingAmount(charges + depositAmount)
                  : charges;
              const totalDueLater = isAlreadyPaid ? 0 : depositOnline ? 0 : depositAmount;
              const loyaltySettlesOnlinePayment =
                !isAlreadyPaid && createdBooking.status === "PENDING_PAYMENT" && totalDueOnline <= 0;

              booking = await tx.booking.update({
                where: { id: createdBooking.id },
                data: {
                  loyaltyCreditAmount: redemption.amountEur,
                  totalDueOnline,
                  totalDueLater,
                  ...(isAlreadyPaid
                    ? { paymentReceivedAmount: roundPricingAmount(charges + depositAmount) }
                    : {}),
                  ...(loyaltySettlesOnlinePayment
                    ? {
                        status: "CONFIRMED",
                        paymentStatus: "PAID",
                        paymentReceivedAmount: 0,
                      }
                    : {}),
                },
              });
            }

            try {
              if (holdForFinalization) {
                const converted = await convertHoldOccupancyToBooking(
                  tx,
                  holdForFinalization.id,
                  booking.id,
                );
                if (!converted) {
                  await insertBookingOccupancy(tx, {
                    vehicleUnitId: assignedUnitId,
                    pickupAt: payload.pickupDateTime,
                    returnAt: payload.returnDateTime,
                    bookingId: booking.id,
                  });
                }
              } else {
                await insertBookingOccupancy(tx, {
                  vehicleUnitId: assignedUnitId,
                  pickupAt: payload.pickupDateTime,
                  returnAt: payload.returnDateTime,
                  bookingId: booking.id,
                });
              }
            } catch (occupancyError) {
              if (isVehicleUnitOccupancyExclusionError(occupancyError)) {
                throw new AvailabilityConflictError(
                  "Selected vehicle is not available for the chosen dates",
                  {
                    vehicleId: vehicle.vehicleId,
                    vehicleType: vehicle.vehicleType,
                    requestedStart: payload.pickupDateTime,
                    requestedEnd: payload.returnDateTime,
                  },
                );
              }
              throw occupancyError;
            }

            if (holdForFinalization) {
              await tx.reservationHold.update({
                where: { id: holdForFinalization.id },
                data: {
                  status: "CONVERTED",
                  bookingId: booking.id,
                  lastHeartbeatAt: new Date(),
                },
              });
            }

            return booking;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: BOOKING_TRANSACTION_TIMEOUT_MS,
          },
        );
      } catch (error) {
        if (error instanceof AvailabilityConflictError || error instanceof NoAvailableVehicleUnitError) {
          if (error instanceof NoAvailableVehicleUnitError) {
            throw new AvailabilityConflictError(error.message, {
              vehicleId: vehicle.vehicleId,
              vehicleType: vehicle.vehicleType,
              requestedStart: payload.pickupDateTime,
              requestedEnd: payload.returnDateTime,
            });
          }
          throw error;
        }
        if (isVehicleUnitOccupancyExclusionError(error)) {
          throw new AvailabilityConflictError(
            "Selected vehicle is not available for the chosen dates",
            {
              vehicleId: vehicle.vehicleId,
              vehicleType: vehicle.vehicleType,
              requestedStart: payload.pickupDateTime,
              requestedEnd: payload.returnDateTime,
            },
          );
        }
        if (isTransactionWriteConflictError(error)) {
          if (conflictAttempt + 1 >= TRANSACTION_WRITE_CONFLICT_RETRY_LIMIT) {
            throw error;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, transactionConflictBackoffMs(conflictAttempt));
          });
          continue;
        }
        if (isTransactionTimeoutError(error)) {
          if (conflictAttempt + 1 >= TRANSACTION_TIMEOUT_RETRY_LIMIT) {
            throw error;
          }
          const delay =
            TRANSACTION_TIMEOUT_RETRY_DELAYS_MS[conflictAttempt] ??
            TRANSACTION_TIMEOUT_RETRY_DELAYS_MS[TRANSACTION_TIMEOUT_RETRY_DELAYS_MS.length - 1]!;
          if (process.env.NODE_ENV !== "production") {
            console.warn(
              `[submitBooking] Transaction timed out (P2028); retrying in ${delay}ms`,
              { attempt: conflictAttempt + 1 },
            );
          }
          await new Promise((resolve) => {
            setTimeout(resolve, delay);
          });
          continue;
        }
        if (isIdempotencyKeyUniqueConstraintError(error) && payload.idempotencyKey) {
          const existing = await prisma.booking.findUnique({
            where: { idempotencyKey: payload.idempotencyKey },
          });
          if (existing) {
            return existing;
          }
        }
        if (!isBookingReferenceUniqueConstraintError(error)) {
          throw error;
        }
        lastError = error;
        continue referenceAttempt;
      }
    }
  }

  throw lastError ?? new Error("Failed to generate a unique booking reference");
}

async function resolveIdempotentBooking(
  idempotencyKey: string | null,
  holdReference: string | null,
): Promise<SubmitBookingResponse | null> {
  const toResponse = (booking: {
    id: string;
    bookingReference: string;
    totalDueOnline: { toNumber(): number } | number;
  }): SubmitBookingResponse => ({
    bookingId: booking.id,
    bookingReference: booking.bookingReference,
    totalDueOnline:
      typeof booking.totalDueOnline === "number"
        ? booking.totalDueOnline
        : booking.totalDueOnline.toNumber(),
  });

  if (idempotencyKey) {
    const existing = await prisma.booking.findUnique({
      where: { idempotencyKey },
      select: { id: true, bookingReference: true, totalDueOnline: true },
    });
    if (existing) {
      return toResponse(existing);
    }
  }

  if (holdReference) {
    const hold = await prisma.reservationHold.findUnique({
      where: { holdReference },
      select: { status: true, bookingId: true },
    });
    if (hold?.status === "CONVERTED" && hold.bookingId) {
      const booking = await prisma.booking.findUnique({
        where: { id: hold.bookingId },
        select: { id: true, bookingReference: true, totalDueOnline: true },
      });
      if (booking) {
        return toResponse(booking);
      }
    }
  }

  return null;
}

export async function submitBooking(payload: BookingSubmissionInput): Promise<SubmitBookingResponse> {
  const validation = validateBookingPayload(payload);
  if (!validation.success) {
    throw new SubmitBookingValidationError(validation.errors);
  }

  const resolvedVehicle = await resolveBookingVehicle(validation.data);
  const storageBoxError = validateStorageBoxSelection(
    resolvedVehicle.supportsStorageBox,
    validation.data.addons.storageBoxSelected,
  );
  if (storageBoxError) {
    throw new SubmitBookingValidationError([storageBoxError]);
  }

  const idempotentResult = await resolveIdempotentBooking(
    validation.data.idempotencyKey,
    validation.data.holdReference,
  );
  if (idempotentResult) {
    return idempotentResult;
  }

  const requireHoldReference = Boolean(validation.data.holdReference);
  if (!requireHoldReference) {
    await assertBookingStillAvailable(
      validation.data,
      resolvedVehicle,
      prisma as unknown as AvailabilityDbClient,
    );
  }

  let validatedHotelCode: ValidatedHotelCode | null = null;
  if (validation.data.hotelCode) {
    const hotelResult = await validateHotelCode(validation.data.hotelCode);
    if (!hotelResult.valid) {
      throw new SubmitBookingValidationError([
        { path: "hotelCode", message: hotelResult.reason },
      ]);
    }
    validatedHotelCode = hotelResult.data;
  }

  const pricing = computePricing(validation.data, resolvedVehicle, validatedHotelCode);
  if (!pricing) {
    throw new SubmitBookingValidationError([
      { path: "pricing", message: "Unable to calculate booking price" },
    ]);
  }

  const activeTermsVersionId = await getActiveTermsVersionId();
  const booking = await createBookingWithUniqueReference(
    validation.data,
    pricing,
    resolvedVehicle,
    activeTermsVersionId,
    requireHoldReference,
  );

  const storedTotalDueOnline =
    typeof booking.totalDueOnline === "number"
      ? booking.totalDueOnline
      : booking.totalDueOnline.toNumber();
  const totalDueOnline = validation.data.payment.mode === "ALREADY_PAID" ? 0 : storedTotalDueOnline;

  // Only send confirmation email immediately when no online payment is required.
  // When Stripe payment is involved, the webhook or success-page verifier
  // sends the email after payment succeeds.
  if (totalDueOnline <= 0) {
    await deliverBookingConfirmationIfNeeded(booking.id);
  }

  await notifyBookingCreated({
    bookingId: booking.id,
    bookingReference: booking.bookingReference,
    customerFullName: validation.data.customer.fullName,
    vehicleName: resolvedVehicle.vehicleNameSnapshot,
  });

  return {
    bookingReference: booking.bookingReference,
    bookingId: booking.id,
    totalDueOnline,
  };
}
