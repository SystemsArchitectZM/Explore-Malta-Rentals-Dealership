"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import type { Vehicle } from "@/features/vehicles/data/vehicles";
import { colorsMatch } from "@/features/vehicles/lib/vehicle-color";
import {
  INITIAL_RESERVATION_HOLD_STATE,
  type ReservationHoldState,
} from "@/features/booking-flow/lib/types";
import {
  createReservationHoldWithRetry,
  extendReservationHoldForCheckout,
  releaseReservationHold,
} from "@/features/booking-flow/lib/reservation-hold-api";
import { useHoldHeartbeat } from "@/features/booking-flow/hooks/use-hold-heartbeat";
import { createBookingIdempotencyKey } from "@/features/booking-flow/lib/booking-idempotency-key";
import { submitBooking } from "@/features/booking-flow/lib/submit-booking-api";
import { KIOSK_STEPS, type KioskStepId } from "@/features/kiosk/lib/steps";
import {
  clearKioskSession,
  loadKioskSession,
  saveKioskSession,
} from "@/features/kiosk/lib/session-storage";
import { mapKioskStateToSubmission } from "@/features/kiosk/lib/map-kiosk-to-submission";
import { buildKioskPricingInput } from "@/features/kiosk/lib/build-pricing-input";
import {
  INITIAL_KIOSK_BOOKING_STATE,
  type KioskBookingState,
} from "@/features/kiosk/lib/types";
import { validateKioskStep } from "@/features/kiosk/lib/validation";
import { calculateBookingPrice } from "@/lib/pricing/calculate-booking-price";
import { fetchVehicles } from "@/features/vehicles/lib/vehicles-api";

function holdMatchesRental(hold: ReservationHoldState, rental: KioskBookingState["rental"]): boolean {
  return (
    hold.holdReference !== null &&
    hold.vehicleId !== null &&
    hold.vehicleId === rental.vehicleId &&
    hold.pickupDate === rental.pickupDate &&
    hold.pickupTime === rental.pickupTime &&
    hold.returnDate === rental.returnDate &&
    hold.returnTime === rental.returnTime &&
    colorsMatch(hold.selectedColor, rental.selectedColor)
  );
}

type KioskBookingContextValue = {
  state: KioskBookingState;
  stepIndex: number;
  stepId: KioskStepId;
  stepError: string | null;
  setStepError: (message: string | null) => void;
  updateSection: <K extends keyof KioskBookingState>(
    section: K,
    value: Partial<KioskBookingState[K]>,
  ) => void;
  setState: (updater: (prev: KioskBookingState) => KioskBookingState) => void;
  goNext: () => Promise<boolean>;
  goBack: () => void;
  goToStep: (index: number) => void;
  availableVehicles: Vehicle[];
  setAvailableVehicles: (vehicles: Vehicle[]) => void;
  selectedVehicleAvailableColors: readonly { label: string; value: string }[];
  reservationHold: ReservationHoldState;
  reservationHoldError: string | null;
  isCreatingHold: boolean;
  isSubmitting: boolean;
  /** Preview loyalty amount from review step (mirrors public summary). */
  loyaltyCreditPreview: number;
  setLoyaltyCreditPreview: (amount: number) => void;
  createOrRefreshHold: () => Promise<{ ok: boolean; message?: string; holdReference?: string | null }>;
  submitKioskBooking: () => Promise<{ ok: boolean; message?: string }>;
  resetSession: () => Promise<void>;
  validateCurrentStep: () => string | null;
};

const KioskBookingContext = createContext<KioskBookingContextValue | null>(null);

export function KioskBookingProvider({ children }: PropsWithChildren) {
  const [state, setStateInternal] = useState<KioskBookingState>(INITIAL_KIOSK_BOOKING_STATE);
  const [stepIndex, setStepIndex] = useState(0);
  const [stepError, setStepError] = useState<string | null>(null);
  const [availableVehicles, setAvailableVehicles] = useState<Vehicle[]>([]);
  const [reservationHold, setReservationHold] = useState<ReservationHoldState>(INITIAL_RESERVATION_HOLD_STATE);
  const [reservationHoldError, setReservationHoldError] = useState<string | null>(null);
  const [isCreatingHold, setIsCreatingHold] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loyaltyCreditPreview, setLoyaltyCreditPreview] = useState(0);
  const [sessionHydrated, setSessionHydrated] = useState(false);
  const idempotencyKeyRef = useRef<string | null>(null);
  const checkoutHoldExtendedForRef = useRef<string | null>(null);

  const stepId = KIOSK_STEPS[stepIndex]?.id ?? "availability";

  useEffect(() => {
    const stored = loadKioskSession();
    if (stored) {
      setStateInternal(stored.state);
      setStepIndex(stored.stepIndex);
      setReservationHold(stored.reservationHold);
    }
    setSessionHydrated(true);
  }, []);

  useEffect(() => {
    if (!sessionHydrated) {
      return;
    }
    saveKioskSession({ state, stepIndex, reservationHold });
  }, [sessionHydrated, state, stepIndex, reservationHold]);

  // availableVehicles is in-memory only — restore it after refresh / remount so later
  // steps (especially vehicle details) still resolve the selected vehicle.
  useEffect(() => {
    if (!sessionHydrated) {
      return;
    }
    if (availableVehicles.length > 0) {
      return;
    }

    const { pickupDate, pickupTime, returnDate, returnTime, vehicleId } = state.rental;
    if (!pickupDate.trim() || !pickupTime.trim() || !returnDate.trim() || !returnTime.trim()) {
      return;
    }

    const controller = new AbortController();
    void fetchVehicles(controller.signal, {
      pickupDate: pickupDate.trim(),
      pickupTime: pickupTime.trim(),
      returnDate: returnDate.trim(),
      returnTime: returnTime.trim(),
      sessionKey: reservationHold.sessionKey?.trim() || undefined,
    })
      .then((vehicles) => {
        if (controller.signal.aborted) return;
        const bookable = vehicles.filter(
          (vehicle) =>
            vehicle.rentalWindowStatus === "available" ||
            vehicle.rentalWindowStatus === "reserved_you",
        );
        const selected =
          vehicleId != null ? vehicles.find((vehicle) => vehicle.id === vehicleId) : null;
        if (selected && !bookable.some((vehicle) => vehicle.id === selected.id)) {
          setAvailableVehicles([...bookable, selected]);
          return;
        }
        setAvailableVehicles(bookable);
      })
      .catch(() => {
        // Keep empty list; steps already handle missing vehicles.
      });

    return () => controller.abort();
  }, [
    sessionHydrated,
    availableVehicles.length,
    reservationHold.sessionKey,
    state.rental.pickupDate,
    state.rental.pickupTime,
    state.rental.returnDate,
    state.rental.returnTime,
    state.rental.vehicleId,
  ]);

  const updateSection = useCallback<KioskBookingContextValue["updateSection"]>((section, value) => {
    setStateInternal((prev) => ({
      ...prev,
      [section]: { ...prev[section], ...value },
    }));
  }, []);

  const setState = useCallback((updater: (prev: KioskBookingState) => KioskBookingState) => {
    setStateInternal(updater);
  }, []);

  const selectedVehicleAvailableColors = useMemo(() => {
    if (!state.rental.vehicleId) {
      return [];
    }
    const vehicle = availableVehicles.find((v) => v.id === state.rental.vehicleId);
    return vehicle?.availableColors ?? [];
  }, [availableVehicles, state.rental.vehicleId]);

  const validateCurrentStep = useCallback((): string | null => {
    return validateKioskStep(stepId, state, selectedVehicleAvailableColors);
  }, [stepId, state, selectedVehicleAvailableColors]);

  const updateHold = useCallback((next: Partial<ReservationHoldState>) => {
    setReservationHold((prev) => ({ ...prev, ...next }));
  }, []);

  const createOrRefreshHold = useCallback(async (): Promise<{
    ok: boolean;
    message?: string;
    holdReference?: string | null;
  }> => {
    const { rental, customer } = state;
    if (!rental.vehicleId) {
      return { ok: false, message: "Please select a vehicle first." };
    }

    const existingActive =
      reservationHold.holdReference &&
      reservationHold.status === "ACTIVE" &&
      reservationHold.expiresAt &&
      new Date(reservationHold.expiresAt).getTime() > Date.now();
    if (existingActive && holdMatchesRental(reservationHold, rental)) {
      setReservationHoldError(null);
      return { ok: true, holdReference: reservationHold.holdReference };
    }

    setIsCreatingHold(true);
    try {
      if (reservationHold.holdReference && reservationHold.status === "ACTIVE") {
        await releaseReservationHold(reservationHold.holdReference);
        updateHold({ holdReference: null, status: null, expiresAt: null });
      }

      const result = await createReservationHoldWithRetry({
        vehicleId: rental.vehicleId,
        vehicleType: rental.vehicleType || undefined,
        ...(rental.selectedColor ? { color: rental.selectedColor } : {}),
        pickupDate: rental.pickupDate,
        pickupTime: rental.pickupTime,
        returnDate: rental.returnDate,
        returnTime: rental.returnTime,
        sessionKey: reservationHold.sessionKey?.trim() || undefined,
        customerEmail: customer.email.trim() || undefined,
        customerName: customer.fullName.trim() || undefined,
      });

      if (!result.ok) {
        setReservationHoldError(result.message);
        return { ok: false, message: result.message };
      }

      updateHold({
        holdReference: result.data.holdReference,
        sessionKey: result.data.sessionKey,
        expiresAt: result.data.expiresAt,
        status: result.data.status,
        vehicleId: rental.vehicleId,
        vehicleSlug: rental.vehicleSlug,
        vehicleType: rental.vehicleType,
        selectedColor: rental.selectedColor,
        pickupDate: rental.pickupDate,
        pickupTime: rental.pickupTime,
        returnDate: rental.returnDate,
        returnTime: rental.returnTime,
      });
      checkoutHoldExtendedForRef.current = null;
      setReservationHoldError(null);
      return { ok: true, holdReference: result.data.holdReference };
    } finally {
      setIsCreatingHold(false);
    }
  }, [reservationHold, state, updateHold]);

  const ensureCheckoutHoldExtension = useCallback(async () => {
    const holdReference = reservationHold.holdReference?.trim();
    const holdIsActive =
      reservationHold.status === "ACTIVE" &&
      !!reservationHold.expiresAt &&
      new Date(reservationHold.expiresAt).getTime() > Date.now();
    if (!holdReference || !holdIsActive) {
      return;
    }
    if (checkoutHoldExtendedForRef.current === holdReference) {
      return;
    }
    checkoutHoldExtendedForRef.current = holdReference;

    const result = await extendReservationHoldForCheckout(holdReference);
    if (!result.ok) {
      checkoutHoldExtendedForRef.current = null;
      return;
    }

    const expiresAt =
      typeof result.data.expiresAt === "string"
        ? result.data.expiresAt
        : new Date(result.data.expiresAt).toISOString();
    updateHold({ expiresAt, status: result.data.status });
  }, [reservationHold.expiresAt, reservationHold.holdReference, reservationHold.status, updateHold]);

  useEffect(() => {
    if (stepId !== "review" && stepId !== "customer") {
      return;
    }
    void ensureCheckoutHoldExtension();
  }, [ensureCheckoutHoldExtension, stepId]);

  useHoldHeartbeat({
    holdReference: reservationHold.holdReference,
    status: reservationHold.status,
    // Match public: keep hold alive until submit finishes (not only until review starts).
    enabled: !isSubmitting && stepIndex >= 2 && stepIndex <= 5,
    onHeartbeatSuccess: (expiresAt, status) => {
      updateHold({ expiresAt, status });
    },
    onHeartbeatExpired: (message) => {
      setReservationHoldError(message);
      updateHold({ status: "EXPIRED", holdReference: null, expiresAt: null });
      checkoutHoldExtendedForRef.current = null;
    },
    onHeartbeatTransientError: (message) => {
      setReservationHoldError(message);
    },
  });

  const goBack = useCallback(() => {
    setStepError(null);
    setStepIndex((i) => Math.max(0, i - 1));
  }, []);

  const goToStep = useCallback((index: number) => {
    setStepError(null);
    setStepIndex(Math.min(KIOSK_STEPS.length - 1, Math.max(0, index)));
  }, []);

  const goNext = useCallback(async (): Promise<boolean> => {
    const error = validateCurrentStep();
    if (error) {
      setStepError(error);
      return false;
    }
    setStepError(null);

    if (stepId === "vehicle_details") {
      const holdResult = await createOrRefreshHold();
      if (!holdResult.ok) {
        setStepError(holdResult.message ?? "Unable to reserve vehicle.");
        return false;
      }
    }

    setStepIndex((i) => Math.min(KIOSK_STEPS.length - 1, i + 1));
    return true;
  }, [createOrRefreshHold, stepId, validateCurrentStep]);

  const submitKioskBooking = useCallback(async (): Promise<{ ok: boolean; message?: string }> => {
    const reviewError = validateKioskStep("review", state, selectedVehicleAvailableColors);
    if (reviewError) {
      setStepError(reviewError);
      return { ok: false, message: reviewError };
    }

    setIsSubmitting(true);
    setStepError(null);
    try {
      await ensureCheckoutHoldExtension();

      const holdResult = await createOrRefreshHold();
      if (!holdResult.ok) {
        return holdResult;
      }

      if (!idempotencyKeyRef.current) {
        idempotencyKeyRef.current = createBookingIdempotencyKey();
      }

      const pricingInput = buildKioskPricingInput(state);
      const pricing = pricingInput ? calculateBookingPrice(pricingInput) : null;
      const loyaltyCreditAmount = Math.max(0, loyaltyCreditPreview);
      const chargesAfterLoyalty = pricing
        ? Math.max(0, Math.round((pricing.subtotal - loyaltyCreditAmount) * 100) / 100)
        : null;
      const dueAtCounter =
        pricing && chargesAfterLoyalty != null
          ? Math.round((chargesAfterLoyalty + pricing.depositAmount) * 100) / 100
          : null;

      const payload = mapKioskStateToSubmission(
        state,
        holdResult.holdReference ?? reservationHold.holdReference,
        idempotencyKeyRef.current,
      );
      const result = await submitBooking(payload);
      if (!result.ok) {
        return { ok: false, message: result.message };
      }

      const acceptedAt = new Date().toISOString();
      setStateInternal((prev) => ({
        ...prev,
        customer: INITIAL_KIOSK_BOOKING_STATE.customer,
        additionalDriver: INITIAL_KIOSK_BOOKING_STATE.additionalDriver,
        hotelCode: INITIAL_KIOSK_BOOKING_STATE.hotelCode,
        meta: {
          bookingReference: result.bookingReference,
          submittedAt: acceptedAt,
          subtotal: pricing?.subtotal ?? null,
          depositAmount: pricing?.depositAmount ?? null,
          loyaltyCreditAmount: loyaltyCreditAmount > 0 ? loyaltyCreditAmount : 0,
          dueAtCounter,
        },
        consent: {
          ...prev.consent,
          termsAcceptedAt: prev.consent.termsAcceptedAt || acceptedAt,
        },
      }));
      setStepIndex(KIOSK_STEPS.findIndex((s) => s.id === "confirm"));
      idempotencyKeyRef.current = null;
      checkoutHoldExtendedForRef.current = null;
      setLoyaltyCreditPreview(0);
      return { ok: true };
    } finally {
      setIsSubmitting(false);
    }
  }, [
    createOrRefreshHold,
    ensureCheckoutHoldExtension,
    loyaltyCreditPreview,
    reservationHold.holdReference,
    selectedVehicleAvailableColors,
    state,
  ]);

  const resetSession = useCallback(async () => {
    if (reservationHold.holdReference && reservationHold.status === "ACTIVE") {
      await releaseReservationHold(reservationHold.holdReference);
    }
    clearKioskSession();
    setStateInternal(INITIAL_KIOSK_BOOKING_STATE);
    setStepIndex(0);
    setAvailableVehicles([]);
    setReservationHold(INITIAL_RESERVATION_HOLD_STATE);
    setReservationHoldError(null);
    setStepError(null);
    setLoyaltyCreditPreview(0);
    idempotencyKeyRef.current = null;
    checkoutHoldExtendedForRef.current = null;
  }, [reservationHold.holdReference, reservationHold.status]);

  const value = useMemo<KioskBookingContextValue>(
    () => ({
      state,
      stepIndex,
      stepId,
      stepError,
      setStepError,
      updateSection,
      setState,
      goNext,
      goBack,
      goToStep,
      availableVehicles,
      setAvailableVehicles,
      selectedVehicleAvailableColors,
      reservationHold,
      reservationHoldError,
      isCreatingHold,
      isSubmitting,
      loyaltyCreditPreview,
      setLoyaltyCreditPreview,
      createOrRefreshHold,
      submitKioskBooking,
      resetSession,
      validateCurrentStep,
    }),
    [
      state,
      stepIndex,
      stepId,
      stepError,
      updateSection,
      setState,
      goNext,
      goBack,
      goToStep,
      availableVehicles,
      selectedVehicleAvailableColors,
      reservationHold,
      reservationHoldError,
      isCreatingHold,
      isSubmitting,
      loyaltyCreditPreview,
      createOrRefreshHold,
      submitKioskBooking,
      resetSession,
      validateCurrentStep,
    ],
  );

  return <KioskBookingContext.Provider value={value}>{children}</KioskBookingContext.Provider>;
}

export function useKioskBooking(): KioskBookingContextValue {
  const ctx = useContext(KioskBookingContext);
  if (!ctx) {
    throw new Error("useKioskBooking must be used within KioskBookingProvider");
  }
  return ctx;
}
