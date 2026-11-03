import type { ReservationHoldState } from "@/features/booking-flow/lib/types";
import { INITIAL_RESERVATION_HOLD_STATE } from "@/features/booking-flow/lib/types";
import {
  INITIAL_KIOSK_BOOKING_STATE,
  type KioskBookingState,
} from "@/features/kiosk/lib/types";

const STORAGE_KEY = "emr-kiosk-booking-v1";

export type KioskPersistedSession = {
  state: KioskBookingState;
  stepIndex: number;
  reservationHold: ReservationHoldState;
};

function mergeKioskState(partial: Partial<KioskBookingState> | undefined): KioskBookingState {
  const source = partial ?? {};
  return {
    ...INITIAL_KIOSK_BOOKING_STATE,
    ...source,
    rental: { ...INITIAL_KIOSK_BOOKING_STATE.rental, ...source.rental },
    delivery: { ...INITIAL_KIOSK_BOOKING_STATE.delivery, ...source.delivery },
    addons: { ...INITIAL_KIOSK_BOOKING_STATE.addons, ...source.addons },
    additionalDriver: {
      ...INITIAL_KIOSK_BOOKING_STATE.additionalDriver,
      ...source.additionalDriver,
    },
    customer: { ...INITIAL_KIOSK_BOOKING_STATE.customer, ...source.customer },
    hotelCode: { ...INITIAL_KIOSK_BOOKING_STATE.hotelCode, ...source.hotelCode },
    deposit: { ...INITIAL_KIOSK_BOOKING_STATE.deposit, ...source.deposit },
    payment: { ...INITIAL_KIOSK_BOOKING_STATE.payment, ...source.payment },
    consent: { ...INITIAL_KIOSK_BOOKING_STATE.consent, ...source.consent },
    meta: { ...INITIAL_KIOSK_BOOKING_STATE.meta, ...source.meta },
  };
}

export function saveKioskSession(session: KioskPersistedSession): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // ignore quota / private mode
  }
}

export function loadKioskSession(): KioskPersistedSession | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<KioskPersistedSession>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.stepIndex !== "number") {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return {
      state: mergeKioskState(parsed.state),
      stepIndex: parsed.stepIndex,
      reservationHold: parsed.reservationHold
        ? { ...INITIAL_RESERVATION_HOLD_STATE, ...parsed.reservationHold }
        : INITIAL_RESERVATION_HOLD_STATE,
    };
  } catch {
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

export function clearKioskSession(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.removeItem(STORAGE_KEY);
}
