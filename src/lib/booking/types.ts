import type { z } from "zod";
import type {
  bookingSubmissionSchema,
  CDW_OPTIONS,
  DEPOSIT_METHODS,
  DROPOFF_OPTIONS,
  HELMET_SIZES,
  LICENSE_CATEGORIES,
  PAYMENT_MODES,
  PICKUP_OPTIONS,
  VEHICLE_TYPES,
} from "@/lib/booking/bookingSubmissionSchema";

export type VehicleType = (typeof VEHICLE_TYPES)[number];
export type PickupOption = (typeof PICKUP_OPTIONS)[number];
export type DropoffOption = (typeof DROPOFF_OPTIONS)[number];
export type LicenseCategory = (typeof LICENSE_CATEGORIES)[number];
export type CdwOption = (typeof CDW_OPTIONS)[number];
export type HelmetSize = (typeof HELMET_SIZES)[number];
export type DepositMethod = (typeof DEPOSIT_METHODS)[number];
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export type BookingSubmission = z.infer<typeof bookingSubmissionSchema>;
export type BookingSubmissionInput = z.input<typeof bookingSubmissionSchema>;

export type NormalizedBookingPayload = {
  holdReference: string | null;
  idempotencyKey: string | null;
  hotelCode: string | null;
  vehicleId: string | null;
  selectedColor: string | null;
  vehicleType: VehicleType;
  pickupDateTime: Date;
  returnDateTime: Date;
  actualDurationHours: number;
  billableDays: number;
  pickupOption: PickupOption;
  pickupAddress: string | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  dropoffOption: DropoffOption;
  dropoffAddress: string | null;
  dropoffLatitude: number | null;
  dropoffLongitude: number | null;
  customer: {
    fullName: string;
    phone: string;
    email: string;
    nationality: string;
    dateOfBirth: Date;
    licenseCategory: LicenseCategory;
    specialNotes: string | null;
    licenseUploadPath: string | null;
    passportUploadPath: string | null;
    willPresentLicenseAtPickup: boolean;
    willPresentIdAtPickup: boolean;
  };
  additionalDriver: {
    enabled: boolean;
    fullName: string | null;
    phone: string | null;
    email: string | null;
    nationality: string | null;
    dateOfBirth: Date | null;
    licenseCategory: LicenseCategory | null;
    licenseUploadPath: string | null;
    passportUploadPath: string | null;
    willPresentLicenseAtPickup: boolean;
    willPresentIdAtPickup: boolean;
  };
  addons: {
    cdwOption: CdwOption;
    helmetSize1: HelmetSize | null;
    helmetSize2: HelmetSize | null;
    storageBoxSelected: boolean;
  };
  deposit: {
    depositMethod: DepositMethod;
  };
  payment: {
    mode: PaymentMode;
    proofPath: string | null;
  };
  consent: {
    termsAccepted: boolean;
    termsAcceptedAt: Date | null;
    consentSource: string | null;
  };
};

export type ValidationError = {
  path: string;
  message: string;
};

export type BookingValidationSuccess = {
  success: true;
  data: NormalizedBookingPayload;
};

export type BookingValidationFailure = {
  success: false;
  errors: ValidationError[];
};

export type BookingValidationResult = BookingValidationSuccess | BookingValidationFailure;
