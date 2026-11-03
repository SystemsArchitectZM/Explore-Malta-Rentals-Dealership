import type { InsurancePlanSelection } from "@/lib/pricing/insurance-plans";
import type { LicenseCategory } from "@/features/booking-flow/lib/types";

export type KioskBookingState = {
  rental: {
    pickupDate: string;
    pickupTime: string;
    returnDate: string;
    returnTime: string;
    vehicleId: string | null;
    vehicleSlug: string;
    vehicleName: string;
    vehicleType: string;
    engineCc: number | null;
    selectedColor: string | null;
    baseDailyRate: number;
    supportsStorageBox: boolean;
    mainImageUrl: string | null;
    shortDescription: string;
    /** Same gate as public booking-flow `pricingAcknowledged`. */
    pricingAcknowledged: boolean;
  };
  delivery: {
    pickupOption: "office" | "delivery";
    dropoffOption: "office" | "dropoff";
    pickupAddress: string;
    dropoffAddress: string;
  };
  addons: {
    cdwPlan: InsurancePlanSelection;
    helmetSize1: string;
    helmetSize2: string;
    additionalDriver: boolean;
    storageBox: boolean;
  };
  additionalDriver: {
    fullName: string;
    phone: string;
    email: string;
    nationality: string;
    dateOfBirth: string;
    licenseCategory: LicenseCategory;
    officeIdConfirmed: boolean;
  };
  customer: {
    fullName: string;
    phone: string;
    email: string;
    nationality: string;
    dateOfBirth: string;
    licenseCategory: LicenseCategory;
    licenseConfirmationCheckbox: boolean;
    idConfirmationCheckbox: boolean;
    specialNotes: string;
  };
  hotelCode: {
    code: string;
    appliedCode: string | null;
    discountPercent: number | null;
    partnerName: string | null;
    error: string | null;
  };
  /** Deposit settlement chosen on the review step. */
  deposit: {
    depositMethod: "online" | "in_person";
  };
  /**
   * Kiosk payment channel.
   * - stripe: pay booking charges + security deposit online (same as web).
   * - pay_at_counter: settle everything at the shop (no Stripe).
   */
  payment: {
    mode: "stripe" | "pay_at_counter";
  };
  consent: {
    termsAccepted: boolean;
    termsAcceptedAt: string;
  };
  meta: {
    bookingReference: string;
    submittedAt: string;
    /** Snapshot of amounts shown at submit for confirm screen (matches pricing engine). */
    subtotal: number | null;
    depositAmount: number | null;
    loyaltyCreditAmount: number | null;
    dueAtCounter: number | null;
    /** Amount redirected to Stripe when payment.mode is stripe; otherwise 0. */
    amountPaidOnline: number | null;
    paymentMode: "stripe" | "pay_at_counter" | null;
  };
};

export const INITIAL_KIOSK_BOOKING_STATE: KioskBookingState = {
  rental: {
    pickupDate: "",
    pickupTime: "",
    returnDate: "",
    returnTime: "",
    vehicleId: null,
    vehicleSlug: "",
    vehicleName: "",
    vehicleType: "",
    engineCc: null,
    selectedColor: null,
    baseDailyRate: 0,
    supportsStorageBox: false,
    mainImageUrl: null,
    shortDescription: "",
    pricingAcknowledged: false,
  },
  delivery: {
    pickupOption: "office",
    dropoffOption: "office",
    pickupAddress: "",
    dropoffAddress: "",
  },
  addons: {
    cdwPlan: null,
    helmetSize1: "",
    helmetSize2: "",
    additionalDriver: false,
    storageBox: false,
  },
  additionalDriver: {
    fullName: "",
    phone: "",
    email: "",
    nationality: "",
    dateOfBirth: "",
    licenseCategory: "",
    officeIdConfirmed: false,
  },
  customer: {
    fullName: "",
    phone: "",
    email: "",
    nationality: "",
    dateOfBirth: "",
    licenseCategory: "",
    licenseConfirmationCheckbox: false,
    idConfirmationCheckbox: false,
    specialNotes: "",
  },
  hotelCode: {
    code: "",
    appliedCode: null,
    discountPercent: null,
    partnerName: null,
    error: null,
  },
  deposit: {
    depositMethod: "in_person",
  },
  payment: {
    mode: "pay_at_counter",
  },
  consent: {
    termsAccepted: false,
    termsAcceptedAt: "",
  },
  meta: {
    bookingReference: "",
    submittedAt: "",
    subtotal: null,
    depositAmount: null,
    loyaltyCreditAmount: null,
    dueAtCounter: null,
    amountPaidOnline: null,
    paymentMode: null,
  },
};
