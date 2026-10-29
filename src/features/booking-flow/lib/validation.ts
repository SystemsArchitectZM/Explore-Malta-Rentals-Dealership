import type { FieldPath } from "react-hook-form";
import { z } from "zod";
import { BOOKING_FLOW_STEPS, type BookingFlowStepId } from "@/features/booking-flow/lib/steps";
import { vehicleTypeNeedsHelmetFlow } from "@/features/booking-flow/lib/helmet-rental";
import { isLicenseAllowedForVehicle } from "@/features/booking-flow/lib/license-categories";
import type { BookingFlowState } from "@/features/booking-flow/lib/types";
import { isPickupDeliveryAllowedForDate } from "@/lib/booking/delivery-availability";
import { isBookableHelmetSize } from "@/lib/booking/helmet-sizes";
import {
  calculateRentalDuration,
  MAX_BILLABLE_RENTAL_DAYS,
  MINIMUM_BILLABLE_RENTAL_DAYS,
} from "@/lib/pricing/rental-duration";

export type BookingValidationMessages = Readonly<{
  vehicleTypeRequired: string;
  pickupOptionRequired: string;
  dropoffOptionRequired: string;
  fullNameRequired: string;
  phoneRequired: string;
  emailRequired: string;
  emailInvalid: string;
  nationalityRequired: string;
  dobRequired: string;
  pickupDateRequired: string;
  pickupTimeRequired: string;
  returnDateRequired: string;
  returnTimeRequired: string;
  minRental: string;
  maxRental: string;
  pickupAddressDelivery: string;
  deliveryUnavailableSunday: string;
  dropoffAddressRequired: string;
  helmetSizesRequired: string;
  additionalDriverName: string;
  additionalDriverPhone: string;
  additionalDriverEmail: string;
  additionalDriverNationality: string;
  additionalDriverDob: string;
  additionalDriverLicense: string;
  additionalPassportDelivery: string;
  additionalOfficeConfirm: string;
  colorRequired: string;
  pricingAcknowledgedRequired: string;
  licenseCategoryRequired: string;
  licenseInvalidForVehicle: string;
  licenseUploadDelivery: string;
  passportUploadDelivery: string;
  confirmDocumentsPickup: string;
  depositMethodRequired: string;
  paymentProofRequired: string;
  reviewFields: string;
}>;

function hasText(value: string) {
  return value.trim().length > 0;
}

const requiredText = (message: string) => z.string().trim().min(1, message);

export function createBookingFlowSchema(m: BookingValidationMessages): z.ZodType<BookingFlowState> {
  const bookingBaseSchema: z.ZodType<BookingFlowState> = z.object({
    rental: z.object({
      vehicleId: z.string().nullable(),
      vehicleSlug: z.string(),
      vehicleName: z.string(),
      vehicleLicensePlate: z.string(),
      vehicleType: requiredText(m.vehicleTypeRequired),
      engineCc: z.union([z.literal(50), z.literal(125), z.null()]),
      selectedColor: z.string().nullable(),
      pickupDate: requiredText(m.pickupDateRequired),
      pickupTime: requiredText(m.pickupTimeRequired),
      returnDate: requiredText(m.returnDateRequired),
      returnTime: requiredText(m.returnTimeRequired),
      pricingAcknowledged: z.boolean(),
    }),
    delivery: z.object({
      pickupOption: z.enum(["office", "delivery"], {
        required_error: m.pickupOptionRequired,
      }),
      dropoffOption: z.enum(["office", "dropoff"], {
        required_error: m.dropoffOptionRequired,
      }),
      pickupAddress: z.string(),
      dropoffAddress: z.string(),
    }),
    addons: z.object({
      helmet: z.boolean(),
      helmetSize1: z.string(),
      helmetSize2: z.string(),
      additionalDriver: z.boolean(),
      storageBox: z.boolean(),
      cdw: z.boolean(),
      cdwPlan: z.enum(["NO_INSURANCE", "BASIC", "FULL_COVERAGE"]).nullable(),
    }),
    customer: z.object({
      fullName: requiredText(m.fullNameRequired),
      phone: requiredText(m.phoneRequired),
      email: z.string().trim().min(1, m.emailRequired).email(m.emailInvalid),
      nationality: requiredText(m.nationalityRequired),
      dateOfBirth: requiredText(m.dobRequired),
      licenseCategory: z.enum(["", "B", "AM", "A", "A1", "A2"]),
      driverLicenseUpload: z.string(),
      passportUpload: z.string(),
      licenseConfirmationCheckbox: z.boolean(),
      idConfirmationCheckbox: z.boolean(),
      specialNotes: z.string(),
    }),
    additionalDriver: z.object({
      fullName: z.string(),
      phone: z.string(),
      email: z.string(),
      nationality: z.string(),
      dateOfBirth: z.string(),
      licenseCategory: z.enum(["", "B", "AM", "A", "A1", "A2"]),
      passportIdUpload: z.string(),
      officeIdConfirmed: z.boolean(),
    }),
    deposit: z.object({
      depositMethod: z.enum(["", "online", "in_person"]),
    }),
    payment: z.object({
      mode: z.enum(["stripe", "already_paid"]),
      proofPath: z.string(),
    }),
    consent: z.object({
      summaryReviewed: z.boolean(),
      termsAccepted: z.boolean(),
      termsAcceptedAt: z.string(),
    }),
    hotelCode: z.object({
      code: z.string(),
      appliedCode: z.string().nullable(),
      discountPercent: z.number().nullable(),
      partnerName: z.string().nullable(),
      error: z.string().nullable(),
    }),
  });

  return bookingBaseSchema.superRefine((state, context) => {
    if (!state.rental.pricingAcknowledged) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.pricingAcknowledgedRequired,
        path: ["rental", "pricingAcknowledged"],
      });
    }

    if (
      state.rental.pickupDate &&
      state.rental.pickupTime &&
      state.rental.returnDate &&
      state.rental.returnTime
    ) {
      const duration = calculateRentalDuration(
        state.rental.pickupDate,
        state.rental.pickupTime,
        state.rental.returnDate,
        state.rental.returnTime,
      );

      if (!duration || duration.billableDays < MINIMUM_BILLABLE_RENTAL_DAYS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.minRental,
          path: ["rental", "returnTime"],
        });
      } else if (duration.billableDays > MAX_BILLABLE_RENTAL_DAYS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.maxRental,
          path: ["rental", "returnDate"],
        });
      }
    }

    if (state.delivery.pickupOption === "delivery" && !isPickupDeliveryAllowedForDate(state.rental.pickupDate)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.deliveryUnavailableSunday,
        path: ["delivery", "pickupOption"],
      });
    }

    if (state.delivery.pickupOption === "delivery" && !hasText(state.delivery.pickupAddress)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.pickupAddressDelivery,
        path: ["delivery", "pickupAddress"],
      });
    }

    if (state.delivery.dropoffOption === "dropoff" && !hasText(state.delivery.dropoffAddress)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.dropoffAddressRequired,
        path: ["delivery", "dropoffAddress"],
      });
    }

    const requiresHelmet = vehicleTypeNeedsHelmetFlow(state.rental.vehicleType);
    const helmetSize1 = state.addons.helmetSize1.trim();
    const helmetSize2 = state.addons.helmetSize2.trim();
    if (
      requiresHelmet &&
      (!isBookableHelmetSize(helmetSize1) || !isBookableHelmetSize(helmetSize2))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.helmetSizesRequired,
        path: ["addons", "helmetSize1"],
      });
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.helmetSizesRequired,
        path: ["addons", "helmetSize2"],
      });
    }

    if (state.addons.additionalDriver) {
      if (!hasText(state.additionalDriver.fullName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.additionalDriverName,
          path: ["additionalDriver", "fullName"],
        });
      }
      if (!hasText(state.additionalDriver.phone)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.additionalDriverPhone,
          path: ["additionalDriver", "phone"],
        });
      }
      if (!hasText(state.additionalDriver.email)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.additionalDriverEmail,
          path: ["additionalDriver", "email"],
        });
      } else if (!z.string().email().safeParse(state.additionalDriver.email.trim()).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.emailInvalid,
          path: ["additionalDriver", "email"],
        });
      }
      if (!hasText(state.additionalDriver.nationality)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.additionalDriverNationality,
          path: ["additionalDriver", "nationality"],
        });
      }
      if (!hasText(state.additionalDriver.dateOfBirth)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.additionalDriverDob,
          path: ["additionalDriver", "dateOfBirth"],
        });
      }
      if (!hasText(state.additionalDriver.licenseCategory)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.additionalDriverLicense,
          path: ["additionalDriver", "licenseCategory"],
        });
      }
    }

    if (state.addons.additionalDriver && state.delivery.pickupOption === "delivery") {
      if (!hasText(state.additionalDriver.passportIdUpload)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.additionalPassportDelivery,
          path: ["additionalDriver", "passportIdUpload"],
        });
      }
    }

    if (state.addons.additionalDriver && state.delivery.pickupOption === "office" && !state.additionalDriver.officeIdConfirmed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.additionalOfficeConfirm,
        path: ["additionalDriver", "officeIdConfirmed"],
      });
    }

    if (!hasText(state.customer.licenseCategory)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.licenseCategoryRequired,
        path: ["customer", "licenseCategory"],
      });
    } else if (!isLicenseAllowedForVehicle(state.customer.licenseCategory, state.rental.vehicleType, state.rental.vehicleId, state.rental.engineCc)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.licenseInvalidForVehicle,
        path: ["customer", "licenseCategory"],
      });
    }

    if (state.delivery.pickupOption === "delivery") {
      if (!hasText(state.customer.driverLicenseUpload)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.licenseUploadDelivery,
          path: ["customer", "driverLicenseUpload"],
        });
      }
      if (!hasText(state.customer.passportUpload)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.passportUploadDelivery,
          path: ["customer", "passportUpload"],
        });
      }
    } else if (!state.customer.licenseConfirmationCheckbox || !state.customer.idConfirmationCheckbox) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.confirmDocumentsPickup,
        path: ["customer", "licenseConfirmationCheckbox"],
      });
    }

    if (state.payment.mode === "already_paid") {
      if (!hasText(state.payment.proofPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: m.paymentProofRequired,
          path: ["payment", "proofPath"],
        });
      }
    } else if (state.deposit.depositMethod !== "online") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: m.depositMethodRequired,
        path: ["deposit", "depositMethod"],
      });
    }
  });
}

export const STEP_FIELD_PATHS: Record<BookingFlowStepId, FieldPath<BookingFlowState>[]> = {
  rental_details: [
    "rental.vehicleType",
    "rental.selectedColor",
    "rental.pickupDate",
    "rental.pickupTime",
    "rental.returnDate",
    "rental.returnTime",
    "rental.pricingAcknowledged",
  ],
  options_delivery: [
    "delivery.pickupOption",
    "delivery.dropoffOption",
    "delivery.pickupAddress",
    "delivery.dropoffAddress",
    "addons.helmetSize1",
    "addons.helmetSize2",
    "additionalDriver.fullName",
    "additionalDriver.phone",
    "additionalDriver.email",
    "additionalDriver.nationality",
    "additionalDriver.dateOfBirth",
    "additionalDriver.licenseCategory",
    "additionalDriver.passportIdUpload",
    "additionalDriver.officeIdConfirmed",
  ],
  your_information: [
    "customer.fullName",
    "customer.phone",
    "customer.email",
    "customer.nationality",
    "customer.dateOfBirth",
    "customer.licenseCategory",
    "customer.driverLicenseUpload",
    "customer.passportUpload",
    "customer.licenseConfirmationCheckbox",
    "customer.idConfirmationCheckbox",
  ],
  review_confirm: ["deposit.depositMethod", "payment.mode", "payment.proofPath"],
};

function issuePathToString(path: (string | number)[]) {
  return path.map((segment) => `${segment}`).join(".");
}

function includesPathPrefix(path: string, candidatePath: string) {
  return path === candidatePath || path.startsWith(`${candidatePath}.`);
}

export function getStepFirstError(
  schema: z.ZodType<BookingFlowState>,
  stepId: BookingFlowStepId,
  state: BookingFlowState,
): string | null {
  const result = schema.safeParse(state);
  if (result.success) {
    return null;
  }

  const trackedPaths = STEP_FIELD_PATHS[stepId];
  for (const issue of result.error.issues) {
    const issuePath = issuePathToString(issue.path);
    if (trackedPaths.some((path) => includesPathPrefix(issuePath, path))) {
      return issue.message;
    }
  }

  return null;
}

export function canAccessStep(
  schema: z.ZodType<BookingFlowState>,
  targetStepId: BookingFlowStepId,
  state: BookingFlowState,
): boolean {
  const targetIndex = BOOKING_FLOW_STEPS.findIndex((step) => step.id === targetStepId);
  if (targetIndex <= 0) {
    return true;
  }

  for (let index = 0; index < targetIndex; index += 1) {
    const priorStep = BOOKING_FLOW_STEPS[index];
    if (getStepFirstError(schema, priorStep.id, state)) {
      return false;
    }
  }

  return true;
}
