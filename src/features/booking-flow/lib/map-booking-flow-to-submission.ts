import { isBookableHelmetSize, type BookableHelmetSize } from "@/lib/booking/helmet-sizes";
import type { BookingSubmissionInput, VehicleType as ApiVehicleType } from "@/lib/booking/types";
import type { BookingFlowState } from "@/features/booking-flow/lib/types";
import { isApiVehicleType } from "@/features/vehicles/data/vehicles";
import {
  isInsurancePlanCode,
  mapInsurancePlanToStoredCdw,
} from "@/lib/pricing/insurance-plans";

export function mapVehicleTypeToApiVehicleType(
  stateVehicleType: string,
  vehicleSlug: string,
): ApiVehicleType {
  if (isApiVehicleType(stateVehicleType)) {
    return stateVehicleType;
  }

  const slug = vehicleSlug.toLowerCase();
  const display = stateVehicleType.toLowerCase();
  if (display === "bicycle" || slug.includes("bicycle")) {
    return "Bicycle";
  }
  if (display === "atv" || slug.includes("atv")) {
    return "ATV";
  }
  if (display === "scooter" || slug.includes("50cc")) {
    return "Scooter";
  }
  if (display === "motorcycle" || slug.includes("125cc")) {
    return "Motorcycle";
  }
  return "Scooter";
}

function isHelmetRequiredForApiVehicle(apiVehicle: ApiVehicleType): boolean {
  return apiVehicle === "Scooter" || apiVehicle === "Motorcycle" || apiVehicle === "ATV";
}

function toHelmetSize(value: string): BookableHelmetSize | null {
  const trimmed = value.trim();
  return isBookableHelmetSize(trimmed) ? trimmed : null;
}

function mapCdwPlanToApi(
  plan: BookingFlowState["addons"]["cdwPlan"],
): BookingSubmissionInput["addons"]["cdwOption"] {
  if (!isInsurancePlanCode(plan)) {
    throw new Error("Insurance plan must be explicitly selected before booking submission");
  }
  return mapInsurancePlanToStoredCdw(plan);
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pathOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mapBookingFlowStateToSubmission(
  state: BookingFlowState,
  holdReference: string | null,
  idempotencyKey?: string,
): BookingSubmissionInput {
  const apiVehicle = mapVehicleTypeToApiVehicleType(state.rental.vehicleType, state.rental.vehicleSlug);
  const helmetRequired = isHelmetRequiredForApiVehicle(apiVehicle);
  const pickupOption = state.delivery.pickupOption === "office" ? "OFFICE" : "DELIVERY";
  const dropoffOption = state.delivery.dropoffOption === "office" ? "OFFICE" : "DROPOFF";
  // Standard Stripe flow is ONLINE-only. ALREADY_PAID keeps offline deposit semantics.
  const depositMethod = state.payment.mode === "already_paid" ? "IN_PERSON" : "ONLINE";
  const additionalEnabled = state.addons.additionalDriver === true;

  const licensePath = pathOrNull(state.customer.driverLicenseUpload);
  const passportPath = pathOrNull(state.customer.passportUpload);
  const officePickup = state.delivery.pickupOption === "office";

  const additionalPassportPath = pathOrNull(state.additionalDriver.passportIdUpload);

  return {
    holdReference: holdReference ?? undefined,
    idempotencyKey,
    rental: {
      vehicleId: state.rental.vehicleId ?? undefined,
      vehicleType: apiVehicle,
      ...(state.rental.engineCc === 50 || state.rental.engineCc === 125
        ? { engineCc: state.rental.engineCc }
        : {}),
      pickupDate: state.rental.pickupDate.trim(),
      returnDate: state.rental.returnDate.trim(),
      pickupTime: state.rental.pickupTime.trim(),
      returnTime: state.rental.returnTime.trim(),
      ...(state.rental.selectedColor ? { selectedColor: state.rental.selectedColor } : {}),
    },
    delivery: {
      pickupOption,
      pickupAddress: emptyToNull(state.delivery.pickupAddress),
      pickupLatitude: null,
      pickupLongitude: null,
      dropoffOption,
      dropoffAddress: emptyToNull(state.delivery.dropoffAddress),
      dropoffLatitude: null,
      dropoffLongitude: null,
    },
    addons: {
      cdwOption: mapCdwPlanToApi(state.addons.cdwPlan),
      additionalDriverEnabled: additionalEnabled,
      helmetSize1: helmetRequired ? toHelmetSize(state.addons.helmetSize1) : null,
      helmetSize2: helmetRequired ? toHelmetSize(state.addons.helmetSize2) : null,
      storageBoxSelected: state.addons.storageBox === true,
    },
    customer: {
      fullName: state.customer.fullName.trim(),
      phone: state.customer.phone.trim(),
      email: state.customer.email.trim(),
      nationality: state.customer.nationality.trim(),
      dateOfBirth: state.customer.dateOfBirth.trim(),
      licenseCategory: state.customer.licenseCategory as BookingSubmissionInput["customer"]["licenseCategory"],
      specialNotes: emptyToNull(state.customer.specialNotes),
      licenseUploadPath: licensePath,
      passportUploadPath: passportPath,
      willPresentLicenseAtPickup: officePickup ? state.customer.licenseConfirmationCheckbox === true : false,
      willPresentIdAtPickup: officePickup ? state.customer.idConfirmationCheckbox === true : false,
    },
    additionalDriver: {
      fullName: additionalEnabled ? emptyToNull(state.additionalDriver.fullName) : null,
      phone: additionalEnabled ? emptyToNull(state.additionalDriver.phone) : null,
      email: additionalEnabled ? emptyToNull(state.additionalDriver.email) : null,
      nationality: additionalEnabled ? emptyToNull(state.additionalDriver.nationality) : null,
      dateOfBirth: additionalEnabled ? state.additionalDriver.dateOfBirth.trim() || null : null,
      licenseCategory: additionalEnabled
        ? ((state.additionalDriver.licenseCategory.trim() || null) as BookingSubmissionInput["additionalDriver"]["licenseCategory"])
        : null,
      licenseUploadPath: null,
      passportUploadPath: additionalEnabled ? additionalPassportPath : null,
      willPresentLicenseAtPickup: additionalEnabled && officePickup ? state.additionalDriver.officeIdConfirmed === true : false,
      willPresentIdAtPickup: additionalEnabled && officePickup ? state.additionalDriver.officeIdConfirmed === true : false,
    },
    deposit: {
      depositMethod,
    },
    payment: {
      mode: state.payment.mode === "already_paid" ? "ALREADY_PAID" : "STRIPE",
      proofPath: state.payment.mode === "already_paid" ? pathOrNull(state.payment.proofPath) : null,
    },
    consent: {
      termsAccepted: state.consent.termsAccepted === true,
      termsAcceptedAt: state.consent.termsAcceptedAt.trim().length > 0 ? state.consent.termsAcceptedAt.trim() : null,
    },
    hotelCode: state.hotelCode.appliedCode ?? undefined,
  };
}
