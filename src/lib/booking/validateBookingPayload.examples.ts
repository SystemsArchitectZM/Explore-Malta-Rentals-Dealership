import { validateBookingPayload } from "@/lib/booking/validateBookingPayload";
import type { BookingSubmissionInput, BookingValidationResult } from "@/lib/booking/types";

const BASE_VALID_50CC_PAYLOAD: BookingSubmissionInput = {
  rental: {
    vehicleType: "Scooter",
    pickupDate: "2026-05-10",
    returnDate: "2026-05-12",
    pickupTime: "10:00",
    returnTime: "10:00",
  },
  delivery: {
    pickupOption: "OFFICE",
    pickupAddress: "",
    pickupLatitude: null,
    pickupLongitude: null,
    dropoffOption: "OFFICE",
    dropoffAddress: "",
    dropoffLatitude: null,
    dropoffLongitude: null,
  },
  addons: {
    cdwOption: "NO_CDW",
    additionalDriverEnabled: false,
    helmetSize1: "M",
    helmetSize2: "L",
    storageBoxSelected: false,
  },
  customer: {
    fullName: "Alex Rider",
    phone: "+35677770000",
    email: "alex@example.com",
    nationality: "Maltese",
    dateOfBirth: "1995-06-15",
    licenseCategory: "B",
    specialNotes: "",
    licenseUploadPath: "",
    passportUploadPath: "",
    willPresentLicenseAtPickup: true,
    willPresentIdAtPickup: true,
  },
  additionalDriver: {
    fullName: "",
    phone: "",
    email: "",
    nationality: "",
    dateOfBirth: null,
    licenseCategory: null,
    licenseUploadPath: "",
    passportUploadPath: "",
    willPresentLicenseAtPickup: false,
    willPresentIdAtPickup: false,
  },
  deposit: {
    depositMethod: "ONLINE",
  },
  consent: {
    termsAccepted: true,
    termsAcceptedAt: "2026-04-22T12:30:00.000Z",
  },
};

type ExampleCase = {
  name: string;
  payload: BookingSubmissionInput;
  expectedSuccess: boolean;
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const withOverrides = (
  payload: BookingSubmissionInput,
  overrides: DeepPartial<BookingSubmissionInput>,
): BookingSubmissionInput => ({
  ...payload,
  ...overrides,
  rental: { ...payload.rental, ...(overrides.rental ?? {}) },
  delivery: { ...payload.delivery, ...(overrides.delivery ?? {}) },
  addons: { ...payload.addons, ...(overrides.addons ?? {}) },
  customer: { ...payload.customer, ...(overrides.customer ?? {}) },
  additionalDriver: { ...payload.additionalDriver, ...(overrides.additionalDriver ?? {}) },
  deposit: { ...payload.deposit, ...(overrides.deposit ?? {}) },
  consent: { ...payload.consent, ...(overrides.consent ?? {}) },
});

export const BOOKING_VALIDATION_EXAMPLES: ExampleCase[] = [
  {
    name: "valid 50cc booking",
    payload: BASE_VALID_50CC_PAYLOAD,
    expectedSuccess: true,
  },
  {
    name: "invalid 50cc booking with wrong license",
    payload: withOverrides(BASE_VALID_50CC_PAYLOAD, {
      customer: { licenseCategory: "A" },
    }),
    expectedSuccess: false,
  },
  {
    name: "valid delivery booking with uploads",
    payload: withOverrides(BASE_VALID_50CC_PAYLOAD, {
      delivery: {
        pickupOption: "DELIVERY",
        pickupAddress: "10 Main Street, Pieta",
      },
      customer: {
        licenseUploadPath: "uploads/license-main-customer.jpg",
        passportUploadPath: "uploads/passport-main-customer.jpg",
        willPresentLicenseAtPickup: false,
        willPresentIdAtPickup: false,
      },
    }),
    expectedSuccess: true,
  },
  {
    name: "invalid delivery booking missing address",
    payload: withOverrides(BASE_VALID_50CC_PAYLOAD, {
      delivery: {
        pickupOption: "DELIVERY",
        pickupAddress: "",
      },
      customer: {
        licenseUploadPath: "uploads/license-main-customer.jpg",
        passportUploadPath: "uploads/passport-main-customer.jpg",
        willPresentLicenseAtPickup: false,
        willPresentIdAtPickup: false,
      },
    }),
    expectedSuccess: false,
  },
  {
    name: "valid additional driver booking",
    payload: withOverrides(BASE_VALID_50CC_PAYLOAD, {
      addons: {
        additionalDriverEnabled: true,
      },
      additionalDriver: {
        fullName: "Jamie Driver",
        phone: "+35679990000",
        email: "jamie@example.com",
        nationality: "Italian",
        dateOfBirth: "1998-02-20",
        licenseCategory: "AM",
        licenseUploadPath: "",
        passportUploadPath: "",
        willPresentLicenseAtPickup: true,
        willPresentIdAtPickup: true,
      },
    }),
    expectedSuccess: true,
  },
  {
    name: "invalid missing helmet sizes for ATV",
    payload: withOverrides(BASE_VALID_50CC_PAYLOAD, {
      rental: {
        vehicleType: "ATV",
      },
      addons: {
        cdwOption: "NO_CDW",
        helmetSize1: null,
        helmetSize2: null,
      },
    }),
    expectedSuccess: false,
  },
  {
    name: "invalid terms not accepted",
    payload: withOverrides(BASE_VALID_50CC_PAYLOAD, {
      consent: {
        termsAccepted: false,
      },
    }),
    expectedSuccess: false,
  },
];

export function runBookingValidationExamples(): Array<{
  name: string;
  expectedSuccess: boolean;
  passed: boolean;
  result: BookingValidationResult;
}> {
  return BOOKING_VALIDATION_EXAMPLES.map((example) => {
    const result = validateBookingPayload(example.payload);
    return {
      name: example.name,
      expectedSuccess: example.expectedSuccess,
      passed: result.success === example.expectedSuccess,
      result,
    };
  });
}
