import { differenceInMilliseconds, format, parse } from "date-fns";
import { z } from "zod";
import {
  isPickupDeliveryAllowedForDate,
  SUNDAY_PICKUP_DELIVERY_ERROR_MESSAGE,
} from "@/lib/booking/delivery-availability";
import {
  calculateRentalDuration,
  MAX_BILLABLE_RENTAL_DAYS,
  MINIMUM_BILLABLE_RENTAL_DAYS,
} from "@/lib/pricing/rental-duration";

import {
  BOOKABLE_STORED_CDW_OPTIONS,
} from "@/lib/pricing/insurance-plans";
import { BOOKABLE_HELMET_SIZES } from "@/lib/booking/helmet-sizes";
import { isLicenseAllowedForEngine } from "@/lib/vehicles/engine-cc";

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}$/;

export const VEHICLE_TYPES = ["Scooter", "Motorcycle", "Bicycle", "ATV"] as const;
export const PICKUP_OPTIONS = ["OFFICE", "DELIVERY"] as const;
export const DROPOFF_OPTIONS = ["OFFICE", "DROPOFF"] as const;
export const LICENSE_CATEGORIES = ["AM", "A1", "A2", "A", "B"] as const;
export const CDW_OPTIONS = [
  "NO_CDW",
  "REDUCE_350_50CC",
  "REDUCE_500_125CC",
  "FULL_COVERAGE_50CC_125CC",
  "REDUCE_800_ATV",
] as const;
/** Sizes accepted on new booking submissions. Historical Small (`S`) is stored but not bookable. */
export const HELMET_SIZES = BOOKABLE_HELMET_SIZES;
export const DEPOSIT_METHODS = ["ONLINE", "IN_PERSON"] as const;
export const PAYMENT_MODES = ["STRIPE", "ALREADY_PAID"] as const;

const EMPTY_TO_NULL_TEXT = z.preprocess(
  (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  },
  z.string().nullable(),
);

const REQUIRED_TEXT = (message: string) => z.string().trim().min(1, message);
const OPTIONAL_VEHICLE_ID = z.preprocess(
  (value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().min(1, "Vehicle ID is required").optional(),
);

const OPTIONAL_HOLD_REFERENCE = z.preprocess(
  (value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().min(1, "Hold reference must not be empty").max(80).optional(),
);

const OPTIONAL_IDEMPOTENCY_KEY = z.preprocess(
  (value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  },
  z.string().min(8, "Idempotency key must be at least 8 characters").max(128).optional(),
);

const OPTIONAL_HOTEL_CODE = z.preprocess(
  (value) => {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed.toUpperCase() : undefined;
  },
  z.string().min(2, "Hotel code must be at least 2 characters").max(40).optional(),
);

const STRICT_BOOLEAN = z.preprocess((value) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  if (value === 1) {
    return true;
  }
  if (value === 0) {
    return false;
  }
  return value;
}, z.boolean());

const LATITUDE_SCHEMA = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().min(-90).max(90).nullable());

const LONGITUDE_SCHEMA = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : value;
  }
  return value;
}, z.number().min(-180).max(180).nullable());

const DATE_ONLY_SCHEMA = z
  .string()
  .trim()
  .regex(DATE_REGEX, "Date must be in YYYY-MM-DD format")
  .refine((date) => isValidDateString(date), "Invalid date");

const TIME_ONLY_SCHEMA = z
  .string()
  .trim()
  .regex(TIME_REGEX, "Time must be in HH:mm format")
  .refine((time) => isValidTimeString(time), "Invalid time");

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidDateString(value: string): boolean {
  const parsed = parse(value, "yyyy-MM-dd", new Date());
  return !Number.isNaN(parsed.getTime()) && format(parsed, "yyyy-MM-dd") === value;
}

function isValidTimeString(value: string): boolean {
  if (!TIME_REGEX.test(value)) {
    return false;
  }
  const [hoursText, minutesText] = value.split(":");
  const hours = Number(hoursText);
  const minutes = Number(minutesText);
  return (
    Number.isInteger(hours) &&
    Number.isInteger(minutes) &&
    hours >= 0 &&
    hours <= 23 &&
    minutes >= 0 &&
    minutes <= 59
  );
}

export function combineDateAndTime(date: string, time: string): Date | null {
  const parsed = parse(`${date} ${time}`, "yyyy-MM-dd HH:mm", new Date());
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

const ALLOWED_CDW_BY_VEHICLE: Record<(typeof VEHICLE_TYPES)[number], ReadonlySet<string>> = {
  Scooter: BOOKABLE_STORED_CDW_OPTIONS as ReadonlySet<string>,
  Motorcycle: BOOKABLE_STORED_CDW_OPTIONS as ReadonlySet<string>,
  ATV: BOOKABLE_STORED_CDW_OPTIONS as ReadonlySet<string>,
  Bicycle: BOOKABLE_STORED_CDW_OPTIONS as ReadonlySet<string>,
};

function isLicenseAllowed(
  vehicleType: string,
  licenseCategory: string,
  engineCc?: number | null,
): boolean {
  return isLicenseAllowedForEngine(vehicleType, licenseCategory, engineCc);
}

export const bookingSubmissionSchema = z
  .object({
    rental: z
      .object({
        vehicleId: OPTIONAL_VEHICLE_ID,
        vehicleType: z.enum(VEHICLE_TYPES, { required_error: "Vehicle type is required" }),
        engineCc: z.union([z.literal(50), z.literal(125)]).optional(),
        pickupDate: DATE_ONLY_SCHEMA,
        returnDate: DATE_ONLY_SCHEMA,
        pickupTime: TIME_ONLY_SCHEMA,
        returnTime: TIME_ONLY_SCHEMA,
        selectedColor: z
          .string()
          .trim()
          .optional()
          .transform((value) => (value && value.length > 0 ? value : undefined)),
      })
      .strict(),
    vehicleId: OPTIONAL_VEHICLE_ID,
    holdReference: OPTIONAL_HOLD_REFERENCE,
    idempotencyKey: OPTIONAL_IDEMPOTENCY_KEY,
    hotelCode: OPTIONAL_HOTEL_CODE,
    delivery: z
      .object({
        pickupOption: z.enum(PICKUP_OPTIONS, { required_error: "Pickup option is required" }),
        pickupAddress: EMPTY_TO_NULL_TEXT,
        pickupLatitude: LATITUDE_SCHEMA,
        pickupLongitude: LONGITUDE_SCHEMA,
        dropoffOption: z.enum(DROPOFF_OPTIONS, { required_error: "Drop-off option is required" }),
        dropoffAddress: EMPTY_TO_NULL_TEXT,
        dropoffLatitude: LATITUDE_SCHEMA,
        dropoffLongitude: LONGITUDE_SCHEMA,
      })
      .strict(),
    addons: z
      .object({
        cdwOption: z.enum(CDW_OPTIONS),
        additionalDriverEnabled: STRICT_BOOLEAN,
        helmetSize1: z.enum(HELMET_SIZES).nullable(),
        helmetSize2: z.enum(HELMET_SIZES).nullable(),
        storageBoxSelected: STRICT_BOOLEAN,
      })
      .strict(),
    customer: z
      .object({
        fullName: REQUIRED_TEXT("Full name is required"),
        phone: REQUIRED_TEXT("Phone is required"),
        email: z.string().trim().min(1, "Email is required").email("Enter a valid email"),
        nationality: REQUIRED_TEXT("Nationality is required"),
        dateOfBirth: DATE_ONLY_SCHEMA,
        licenseCategory: z.enum(LICENSE_CATEGORIES, {
          required_error: "License category is required",
        }),
        specialNotes: EMPTY_TO_NULL_TEXT,
        licenseUploadPath: EMPTY_TO_NULL_TEXT,
        passportUploadPath: EMPTY_TO_NULL_TEXT,
        willPresentLicenseAtPickup: STRICT_BOOLEAN,
        willPresentIdAtPickup: STRICT_BOOLEAN,
      })
      .strict(),
    additionalDriver: z
      .object({
        fullName: EMPTY_TO_NULL_TEXT,
        phone: EMPTY_TO_NULL_TEXT,
        email: EMPTY_TO_NULL_TEXT,
        nationality: EMPTY_TO_NULL_TEXT,
        dateOfBirth: z
          .union([DATE_ONLY_SCHEMA, z.null()])
          .optional()
          .transform((value) => value ?? null),
        licenseCategory: z
          .union([z.enum(LICENSE_CATEGORIES), z.null()])
          .optional()
          .transform((value) => value ?? null),
        licenseUploadPath: EMPTY_TO_NULL_TEXT,
        passportUploadPath: EMPTY_TO_NULL_TEXT,
        willPresentLicenseAtPickup: STRICT_BOOLEAN,
        willPresentIdAtPickup: STRICT_BOOLEAN,
      })
      .strict(),
    deposit: z
      .object({
        depositMethod: z.enum(DEPOSIT_METHODS, { required_error: "Deposit method is required" }),
      })
      .strict(),
    payment: z
      .object({
        mode: z.enum(PAYMENT_MODES).default("STRIPE"),
        proofPath: EMPTY_TO_NULL_TEXT,
      })
      .strict()
      .optional()
      .default({ mode: "STRIPE", proofPath: null }),
    consent: z
      .object({
        termsAccepted: STRICT_BOOLEAN,
        termsAcceptedAt: z.preprocess((value) => {
          if (value === undefined || value === null || value === "") {
            return null;
          }
          if (typeof value !== "string") {
            return value;
          }
          const parsed = new Date(value);
          if (Number.isNaN(parsed.getTime())) {
            return value;
          }
          return parsed.toISOString();
        }, z.string().datetime().nullable()),
      })
      .strict(),
  })
  .strict()
  .superRefine((payload, context) => {
    if (payload.vehicleId && payload.rental.vehicleId && payload.vehicleId !== payload.rental.vehicleId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vehicleId"],
        message: "Vehicle ID must match rental.vehicleId when both are provided",
      });
    }

    if (payload.payment.mode === "ALREADY_PAID" && !payload.payment.proofPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payment", "proofPath"],
        message: "Payment proof is required when payment mode is Already paid",
      });
    }

    // Standard Stripe bookings must collect the security deposit online.
    // ALREADY_PAID keeps offline / IN_PERSON deposit semantics.
    if (payload.payment.mode === "STRIPE" && payload.deposit.depositMethod !== "ONLINE") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["deposit", "depositMethod"],
        message: "Security deposit must be paid online for standard Stripe bookings",
      });
    }

    const pickupDateTime = combineDateAndTime(payload.rental.pickupDate, payload.rental.pickupTime);
    const returnDateTime = combineDateAndTime(payload.rental.returnDate, payload.rental.returnTime);

    if (!pickupDateTime || !returnDateTime) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rental", "pickupDate"],
        message: "Invalid rental date/time",
      });
      return;
    }

    const diffMs = differenceInMilliseconds(returnDateTime, pickupDateTime);
    const duration =
      diffMs > 0
        ? calculateRentalDuration(
            payload.rental.pickupDate,
            payload.rental.pickupTime,
            payload.rental.returnDate,
            payload.rental.returnTime,
          )
        : null;

    if (!duration || duration.billableDays < MINIMUM_BILLABLE_RENTAL_DAYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rental", "returnTime"],
        message: "The return time must be later than the pickup time.",
      });
    } else if (duration.billableDays > MAX_BILLABLE_RENTAL_DAYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rental", "returnDate"],
        message: "Maximum rental is 4 weeks",
      });
    }

    if (
      payload.delivery.pickupOption === "DELIVERY" &&
      !isPickupDeliveryAllowedForDate(payload.rental.pickupDate)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delivery", "pickupOption"],
        message: SUNDAY_PICKUP_DELIVERY_ERROR_MESSAGE,
      });
    }

    if (payload.delivery.pickupOption === "DELIVERY" && !hasText(payload.delivery.pickupAddress)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delivery", "pickupAddress"],
        message: "Pickup address is required for delivery",
      });
    }

    if (payload.delivery.dropoffOption === "DROPOFF" && !hasText(payload.delivery.dropoffAddress)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delivery", "dropoffAddress"],
        message: "Drop-off address is required for requested drop-off",
      });
    }

    if (!isLicenseAllowed(payload.rental.vehicleType, payload.customer.licenseCategory, payload.rental.engineCc)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["customer", "licenseCategory"],
        message: "Invalid license category for selected vehicle",
      });
    }

    if (payload.delivery.pickupOption === "DELIVERY") {
      if (!hasText(payload.customer.licenseUploadPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customer", "licenseUploadPath"],
          message: "Driver's license upload is required for delivery",
        });
      }
      if (!hasText(payload.customer.passportUploadPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customer", "passportUploadPath"],
          message: "Passport/ID upload is required for delivery",
        });
      }
    }

    if (payload.delivery.pickupOption === "OFFICE") {
      if (!payload.customer.willPresentLicenseAtPickup) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customer", "willPresentLicenseAtPickup"],
          message: "Please confirm you will present your license at pickup",
        });
      }
      if (!payload.customer.willPresentIdAtPickup) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["customer", "willPresentIdAtPickup"],
          message: "Please confirm you will present your ID at pickup",
        });
      }
    }

    if (payload.addons.additionalDriverEnabled) {
      if (!hasText(payload.additionalDriver.fullName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "fullName"],
          message: "Full name is required",
        });
      }
      if (!hasText(payload.additionalDriver.phone)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "phone"],
          message: "Phone is required",
        });
      }
      if (!hasText(payload.additionalDriver.email)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "email"],
          message: "Email is required",
        });
      } else if (!z.string().email().safeParse(payload.additionalDriver.email).success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "email"],
          message: "Enter a valid email",
        });
      }
      if (!hasText(payload.additionalDriver.nationality)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "nationality"],
          message: "Nationality is required",
        });
      }
      if (!hasText(payload.additionalDriver.dateOfBirth ?? null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "dateOfBirth"],
          message: "Date of birth is required",
        });
      }
      const additionalDriverLicenseCategory = payload.additionalDriver.licenseCategory;
      if (!hasText(additionalDriverLicenseCategory ?? null)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "licenseCategory"],
          message: "License category is required",
        });
      } else if (
        additionalDriverLicenseCategory !== null &&
        !isLicenseAllowed(payload.rental.vehicleType, additionalDriverLicenseCategory, payload.rental.engineCc)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "licenseCategory"],
          message: "Invalid license category for selected vehicle",
        });
      }

      if (payload.delivery.pickupOption === "DELIVERY" && !hasText(payload.additionalDriver.passportUploadPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["additionalDriver", "passportUploadPath"],
          message: "Passport/ID upload is required for additional driver delivery",
        });
      }

      if (payload.delivery.pickupOption === "OFFICE") {
        if (!payload.additionalDriver.willPresentIdAtPickup) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["additionalDriver", "willPresentIdAtPickup"],
            message: "Please confirm additional driver ID will be presented at pickup",
          });
        }
        if (!payload.additionalDriver.willPresentLicenseAtPickup) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["additionalDriver", "willPresentLicenseAtPickup"],
            message: "Please confirm additional driver license will be presented at pickup",
          });
        }
      }
    }

    const helmetRequired =
      payload.rental.vehicleType === "Scooter" ||
      payload.rental.vehicleType === "Motorcycle" ||
      payload.rental.vehicleType === "ATV";

    if (helmetRequired && (!payload.addons.helmetSize1 || !payload.addons.helmetSize2)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["addons", "helmetSize1"],
        message: "Both helmet sizes are required for this vehicle type",
      });
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["addons", "helmetSize2"],
        message: "Both helmet sizes are required for this vehicle type",
      });
    }

    const allowedCdwOptions = ALLOWED_CDW_BY_VEHICLE[payload.rental.vehicleType];
    if (!allowedCdwOptions.has(payload.addons.cdwOption)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["addons", "cdwOption"],
        message: "Invalid insurance plan for selected vehicle",
      });
    }

    if (!payload.consent.termsAccepted) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["consent", "termsAccepted"],
        message: "You must accept the terms and conditions before proceeding",
      });
    }
  });
