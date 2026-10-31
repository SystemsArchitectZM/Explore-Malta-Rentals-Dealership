import { BOOKING_TIME_SLOTS } from "@/features/booking/lib/time-slots";
import { vehicleTypeNeedsHelmetFlow } from "@/features/booking-flow/lib/helmet-rental";
import { isLicenseAllowedForVehicle } from "@/features/booking-flow/lib/license-categories";
import { mapVehicleTypeToApiVehicleType } from "@/features/booking-flow/lib/map-booking-flow-to-submission";
import type { KioskStepId } from "@/features/kiosk/lib/steps";
import type { KioskBookingState } from "@/features/kiosk/lib/types";
import { isBookableHelmetSize } from "@/lib/booking/helmet-sizes";
import {
  calculateRentalDuration,
  MAX_BILLABLE_RENTAL_DAYS,
  MINIMUM_BILLABLE_RENTAL_DAYS,
} from "@/lib/pricing/rental-duration";
import { isInsurancePlanCode } from "@/lib/pricing/insurance-plans";

function hasText(value: string): boolean {
  return value.trim().length > 0;
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function validateAvailability(state: KioskBookingState): string | null {
  const { pickupDate, pickupTime, returnDate, returnTime } = state.rental;
  if (!hasText(pickupDate)) return "Pickup date is required.";
  if (!hasText(pickupTime)) return "Pickup time is required.";
  if (!hasText(returnDate)) return "Return date is required.";
  if (!hasText(returnTime)) return "Return time is required.";

  // Shop search + kiosk use the same office-hour slots as the public booking search form.
  if (!(BOOKING_TIME_SLOTS as readonly string[]).includes(pickupTime)) {
    return "Pickup time must be within office hours (09:30–19:00).";
  }
  if (!(BOOKING_TIME_SLOTS as readonly string[]).includes(returnTime)) {
    return "Return time must be within office hours (09:30–19:00).";
  }

  const duration = calculateRentalDuration(pickupDate, pickupTime, returnDate, returnTime);
  if (!duration) {
    return "Return must be after pickup.";
  }
  if (duration.billableDays < MINIMUM_BILLABLE_RENTAL_DAYS) {
    return "Minimum rental is 1 billable day (24 hours).";
  }
  if (duration.billableDays > MAX_BILLABLE_RENTAL_DAYS) {
    return "Maximum rental is 4 weeks (28 billable days).";
  }
  return null;
}

function validateVehicles(state: KioskBookingState): string | null {
  if (!state.rental.vehicleId) {
    return "Please select a vehicle.";
  }
  return null;
}

function validateVehicleDetails(
  state: KioskBookingState,
  availableColors: readonly { label: string }[],
): string | null {
  if (availableColors.length > 0 && !state.rental.selectedColor) {
    return "Please select a vehicle colour.";
  }
  if (!state.rental.pricingAcknowledged) {
    return "Please acknowledge the rental price before continuing.";
  }
  return null;
}

function validateOptions(state: KioskBookingState): string | null {
  if (!isInsurancePlanCode(state.addons.cdwPlan)) {
    return "Please select an insurance plan.";
  }

  const apiVehicle = mapVehicleTypeToApiVehicleType(state.rental.vehicleType, state.rental.vehicleSlug);
  if (vehicleTypeNeedsHelmetFlow(apiVehicle)) {
    if (!isBookableHelmetSize(state.addons.helmetSize1)) {
      return "Helmet size 1 is required.";
    }
    if (!isBookableHelmetSize(state.addons.helmetSize2)) {
      return "Helmet size 2 is required.";
    }
  }

  if (state.addons.additionalDriver) {
    if (!hasText(state.additionalDriver.fullName)) return "Additional driver name is required.";
    if (!hasText(state.additionalDriver.phone)) return "Additional driver phone is required.";
    if (!hasText(state.additionalDriver.email)) return "Additional driver email is required.";
    if (!isValidEmail(state.additionalDriver.email)) return "Additional driver email is invalid.";
    if (!hasText(state.additionalDriver.nationality)) return "Additional driver nationality is required.";
    if (!hasText(state.additionalDriver.dateOfBirth)) return "Additional driver date of birth is required.";
    if (!hasText(state.additionalDriver.licenseCategory)) {
      return "Additional driver license category is required.";
    }
    if (
      !isLicenseAllowedForVehicle(
        state.additionalDriver.licenseCategory,
        state.rental.vehicleType,
        state.rental.vehicleId,
        state.rental.engineCc,
      )
    ) {
      return "Additional driver license category is not valid for this vehicle.";
    }
  }

  if (state.hotelCode.code.trim() && !state.hotelCode.appliedCode) {
    return state.hotelCode.error || "Please apply a valid hotel code, or clear the field.";
  }

  if (state.delivery.pickupOption !== "office" || state.delivery.dropoffOption !== "office") {
    return "Kiosk bookings use office pickup and return. Ask staff for delivery.";
  }

  return null;
}

function validateCustomer(state: KioskBookingState): string | null {
  const { customer } = state;
  if (!hasText(customer.fullName)) return "Full name is required.";
  if (!hasText(customer.phone)) return "Phone is required.";
  if (!hasText(customer.email)) return "Email is required.";
  if (!isValidEmail(customer.email)) return "Please enter a valid email address.";
  if (!hasText(customer.nationality)) return "Nationality is required.";
  if (!hasText(customer.dateOfBirth)) return "Date of birth is required.";
  if (!hasText(customer.licenseCategory)) return "License category is required.";

  if (
    !isLicenseAllowedForVehicle(
      customer.licenseCategory,
      state.rental.vehicleType,
      state.rental.vehicleId,
      state.rental.engineCc,
    )
  ) {
    return "Selected license category is not valid for this vehicle.";
  }

  if (!customer.licenseConfirmationCheckbox) {
    return "Please confirm you will present your driving license at pickup.";
  }
  if (!customer.idConfirmationCheckbox) {
    return "Please confirm you will present ID at pickup.";
  }

  if (state.addons.additionalDriver && !state.additionalDriver.officeIdConfirmed) {
    return "Please confirm the additional driver will present ID at pickup.";
  }

  return null;
}

function validateReview(state: KioskBookingState): string | null {
  if (!state.rental.pricingAcknowledged) {
    return "Please acknowledge the rental price before submitting.";
  }
  if (!state.consent.termsAccepted) {
    return "Please accept the terms and conditions.";
  }
  return null;
}

export function validateKioskStep(
  stepId: KioskStepId,
  state: KioskBookingState,
  availableColors: readonly { label: string }[] = [],
): string | null {
  switch (stepId) {
    case "availability":
      return validateAvailability(state);
    case "vehicles":
      return validateVehicles(state);
    case "vehicle_details":
      return validateVehicleDetails(state, availableColors);
    case "options":
      return validateOptions(state);
    case "customer":
      return validateCustomer(state);
    case "review":
      return validateReview(state);
    case "confirm":
      return null;
    default:
      return null;
  }
}

export { validateAvailability };
