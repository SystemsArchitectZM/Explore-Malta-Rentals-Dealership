import type { InsurancePlanSelection } from "@/lib/pricing/insurance-plans";

export type LicenseCategory = "" | "B" | "AM" | "A" | "A1" | "A2";
export type ReservationHoldStatus = "ACTIVE" | "EXPIRED" | "RELEASED" | "CONVERTED";

export type ReservationHoldState = {
  holdReference: string | null;
  sessionKey: string | null;
  expiresAt: string | null;
  status: ReservationHoldStatus | null;
  vehicleId: string | null;
  vehicleSlug: string | null;
  vehicleType: string | null;
  selectedColor: string | null;
  pickupDate: string | null;
  pickupTime: string | null;
  returnDate: string | null;
  returnTime: string | null;
};

export type BookingFlowState = {
  rental: {
    vehicleId: string | null;
    vehicleSlug: string;
    vehicleName: string;
    vehicleLicensePlate: string;
    vehicleType: string;
    engineCc: number | null;
    selectedColor: string | null;
    pickupDate: string;
    pickupTime: string;
    returnDate: string;
    returnTime: string;
    pricingAcknowledged: boolean;
  };
  delivery: {
    pickupOption: "office" | "delivery";
    dropoffOption: "office" | "dropoff";
    pickupAddress: string;
    dropoffAddress: string;
  };
  addons: {
    helmet: boolean;
    helmetSize1: string;
    helmetSize2: string;
    additionalDriver: boolean;
    storageBox: boolean;
    cdw: boolean;
    /**
     * Explicit insurance selection.
     * `null` = customer has not chosen yet (triggers pre-payment prompt).
     * `NO_INSURANCE` = customer explicitly declined paid insurance.
     */
    cdwPlan: InsurancePlanSelection;
  };
  customer: {
    fullName: string;
    phone: string;
    email: string;
    nationality: string;
    dateOfBirth: string;
    licenseCategory: LicenseCategory;
    driverLicenseUpload: string;
    passportUpload: string;
    licenseConfirmationCheckbox: boolean;
    idConfirmationCheckbox: boolean;
    specialNotes: string;
  };
  additionalDriver: {
    fullName: string;
    phone: string;
    email: string;
    nationality: string;
    dateOfBirth: string;
    licenseCategory: LicenseCategory;
    passportIdUpload: string;
    officeIdConfirmed: boolean;
  };
  deposit: {
    depositMethod: "online" | "in_person" | "";
  };
  payment: {
    mode: "stripe" | "already_paid";
    proofPath: string;
  };
  consent: {
    summaryReviewed: boolean;
    termsAccepted: boolean;
    termsAcceptedAt: string;
  };
  hotelCode: {
    code: string;
    appliedCode: string | null;
    discountPercent: number | null;
    partnerName: string | null;
    error: string | null;
  };
};

export const INITIAL_BOOKING_FLOW_STATE: BookingFlowState = {
  rental: {
    vehicleId: null,
    vehicleSlug: "",
    vehicleName: "",
    vehicleLicensePlate: "",
    vehicleType: "",
    engineCc: null,
    selectedColor: null,
    pickupDate: "",
    pickupTime: "",
    returnDate: "",
    returnTime: "",
    pricingAcknowledged: false,
  },
  delivery: {
    pickupOption: "office",
    dropoffOption: "office",
    pickupAddress: "",
    dropoffAddress: "",
  },
  addons: {
    helmet: false,
    helmetSize1: "",
    helmetSize2: "",
    additionalDriver: false,
    storageBox: false,
    cdw: false,
    cdwPlan: null,
  },
  customer: {
    fullName: "",
    phone: "",
    email: "",
    nationality: "",
    dateOfBirth: "",
    licenseCategory: "",
    driverLicenseUpload: "",
    passportUpload: "",
    licenseConfirmationCheckbox: false,
    idConfirmationCheckbox: false,
    specialNotes: "",
  },
  additionalDriver: {
    fullName: "",
    phone: "",
    email: "",
    nationality: "",
    dateOfBirth: "",
    licenseCategory: "",
    passportIdUpload: "",
    officeIdConfirmed: false,
  },
  deposit: {
    depositMethod: "online",
  },
  payment: {
    mode: "stripe",
    proofPath: "",
  },
  consent: {
    summaryReviewed: false,
    termsAccepted: false,
    termsAcceptedAt: "",
  },
  hotelCode: {
    code: "",
    appliedCode: null,
    discountPercent: null,
    partnerName: null,
    error: null,
  },
};

export const INITIAL_RESERVATION_HOLD_STATE: ReservationHoldState = {
  holdReference: null,
  sessionKey: null,
  expiresAt: null,
  status: null,
  vehicleId: null,
  vehicleSlug: null,
  vehicleType: null,
  selectedColor: null,
  pickupDate: null,
  pickupTime: null,
  returnDate: null,
  returnTime: null,
};
