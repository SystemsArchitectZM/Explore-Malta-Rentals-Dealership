import type { KioskBookingState } from "@/features/kiosk/lib/types";
import { isInsurancePlanCode } from "@/lib/pricing/insurance-plans";
import type { BookingPricingInput } from "@/lib/pricing/calculate-booking-price";
import type { VehicleType } from "@/features/vehicles/data/vehicles";
import { mapVehicleTypeToApiVehicleType } from "@/features/booking-flow/lib/map-booking-flow-to-submission";

export function buildKioskPricingInput(state: KioskBookingState): BookingPricingInput | null {
  if (!state.rental.vehicleType || state.rental.baseDailyRate <= 0) {
    return null;
  }
  const apiType = mapVehicleTypeToApiVehicleType(state.rental.vehicleType, state.rental.vehicleSlug);
  const cdwOption = isInsurancePlanCode(state.addons.cdwPlan) ? state.addons.cdwPlan : "NO_INSURANCE";

  return {
    rental: {
      vehicle: {
        id: state.rental.vehicleId ?? undefined,
        slug: state.rental.vehicleSlug,
        name: state.rental.vehicleName,
        type: apiType,
      },
      pickupDate: state.rental.pickupDate,
      returnDate: state.rental.returnDate,
      pickupTime: state.rental.pickupTime,
      returnTime: state.rental.returnTime,
    },
    delivery: {
      // Kiosk is office-only; keep calculator inputs identical to submission.
      pickupOption: "office",
      pickupAddress: "",
      dropoffOption: "office",
      dropoffAddress: "",
    },
    addons: {
      cdwOption,
      additionalDriver: state.addons.additionalDriver,
      storageBox: state.addons.storageBox,
      helmetSize1: state.addons.helmetSize1,
      helmetSize2: state.addons.helmetSize2,
    },
    additionalDriver: { enabled: state.addons.additionalDriver },
    deposit: { method: "in_person" },
    vehiclePricing: {
      baseDailyRate: state.rental.baseDailyRate,
      vehicleType: apiType as VehicleType,
      supportsStorageBox: state.rental.supportsStorageBox,
    },
    hotelDiscount:
      state.hotelCode.appliedCode && state.hotelCode.discountPercent != null
        ? { discountPercent: state.hotelCode.discountPercent }
        : undefined,
  };
}
