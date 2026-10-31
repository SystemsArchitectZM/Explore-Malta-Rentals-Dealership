import { isBookableHelmetSize, type BookableHelmetSize } from "@/lib/booking/helmet-sizes";
import type { BookingSubmissionInput } from "@/lib/booking/types";
import { vehicleTypeNeedsHelmetFlow } from "@/features/booking-flow/lib/helmet-rental";
import {
  isInsurancePlanCode,
  mapInsurancePlanToStoredCdw,
} from "@/lib/pricing/insurance-plans";
import { mapVehicleTypeToApiVehicleType } from "@/features/booking-flow/lib/map-booking-flow-to-submission";
import type { KioskBookingState } from "@/features/kiosk/lib/types";

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toHelmetSize(value: string): BookableHelmetSize | null {
  const trimmed = value.trim();
  return isBookableHelmetSize(trimmed) ? trimmed : null;
}

function mapCdwPlanToApi(
  plan: KioskBookingState["addons"]["cdwPlan"],
): BookingSubmissionInput["addons"]["cdwOption"] {
  if (!isInsurancePlanCode(plan)) {
    throw new Error("Insurance plan must be explicitly selected before booking submission");
  }
  return mapInsurancePlanToStoredCdw(plan);
}

export function mapKioskStateToSubmission(
  state: KioskBookingState,
  holdReference: string | null,
  idempotencyKey?: string,
): BookingSubmissionInput {
  const apiVehicle = mapVehicleTypeToApiVehicleType(state.rental.vehicleType, state.rental.vehicleSlug);
  const helmetRequired = vehicleTypeNeedsHelmetFlow(apiVehicle);
  const additionalEnabled = state.addons.additionalDriver === true;

  return {
    holdReference: holdReference ?? undefined,
    idempotencyKey,
    hotelCode: state.hotelCode.appliedCode ?? undefined,
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
      licenseUploadPath: null,
      passportUploadPath: null,
      willPresentLicenseAtPickup: state.customer.licenseConfirmationCheckbox === true,
      willPresentIdAtPickup: state.customer.idConfirmationCheckbox === true,
    },
    additionalDriver: {
      fullName: additionalEnabled ? emptyToNull(state.additionalDriver.fullName) : null,
      phone: additionalEnabled ? emptyToNull(state.additionalDriver.phone) : null,
      email: additionalEnabled ? emptyToNull(state.additionalDriver.email) : null,
      nationality: additionalEnabled ? emptyToNull(state.additionalDriver.nationality) : null,
      dateOfBirth: additionalEnabled ? state.additionalDriver.dateOfBirth.trim() || null : null,
      licenseCategory: additionalEnabled
        ? ((state.additionalDriver.licenseCategory.trim() ||
            null) as BookingSubmissionInput["additionalDriver"]["licenseCategory"])
        : null,
      licenseUploadPath: null,
      passportUploadPath: null,
      willPresentLicenseAtPickup: additionalEnabled
        ? state.additionalDriver.officeIdConfirmed === true
        : false,
      willPresentIdAtPickup: additionalEnabled
        ? state.additionalDriver.officeIdConfirmed === true
        : false,
    },
    deposit: {
      depositMethod: "IN_PERSON",
    },
    payment: {
      // Kiosk counter settlement — same create path as public, without Stripe/ALREADY_PAID.
      mode: "PAY_AT_COUNTER",
      proofPath: null,
    },
    consent: {
      termsAccepted: state.consent.termsAccepted === true,
      termsAcceptedAt:
        state.consent.termsAcceptedAt.trim().length > 0 ? state.consent.termsAcceptedAt.trim() : null,
      consentSource: "kiosk",
    },
  };
}
