"use client";

import { useEffect, useState } from "react";
import type { Vehicle } from "@/features/vehicles/data/vehicles";
import { readReservationHoldSessionKeyFromStorage } from "@/features/booking-flow/lib/reservation-hold-storage";
import {
  fetchVehicleBySlug,
  fetchVehicles,
  type FetchVehiclesRentalWindow,
} from "@/features/vehicles/lib/vehicles-api";

// ---------------------------------------------------------------------------
// Retry helper — transparent back-off for Neon serverless cold-starts.
// Neon can take 2–8 s to wake from sleep; the first request often fails while
// subsequent ones succeed immediately. We retry up to MAX_RETRIES times with
// an exponential delay so the user never sees a flash of the error banner.
// ---------------------------------------------------------------------------
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 1_500; // 1.5 s → 3 s

function isAbortError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const name = "name" in error ? String(error.name) : "";
  if (name === "AbortError") return true;
  const message = "message" in error ? String(error.message) : "";
  // undici / newer fetch: abort() with no reason → "signal is aborted without reason"
  return /aborted/i.test(message);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const id = window.setTimeout(resolve, ms);
    const onAbort = () => {
      window.clearTimeout(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal,
  retries = MAX_RETRIES,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        throw err instanceof Error ? err : new DOMException("Aborted", "AbortError");
      }
      lastError = err;
      if (attempt < retries) {
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt), signal);
      }
    }
  }
  throw lastError;
}

type UseVehiclesResult = {
  vehicles: Vehicle[];
  isLoading: boolean;
  error: string | null;
};

type UseVehicleResult = {
  vehicle: Vehicle | null;
  isLoading: boolean;
  error: string | null;
};

type UseVehiclesOptions = {
  enabled?: boolean;
  /** When all four strings are set, listing includes hold-aware `rentalWindowStatus`. */
  rentalWindow?: FetchVehiclesRentalWindow | null;
};

export function useVehicles(options: UseVehiclesOptions = {}): UseVehiclesResult {
  const { enabled = true, rentalWindow = null } = options;
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickupDate = rentalWindow?.pickupDate?.trim() ?? "";
  const pickupTime = rentalWindow?.pickupTime?.trim() ?? "";
  const returnDate = rentalWindow?.returnDate?.trim() ?? "";
  const returnTime = rentalWindow?.returnTime?.trim() ?? "";
  const sessionKey = rentalWindow?.sessionKey?.trim() ?? "";

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const loadVehicles = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const windowPayload =
          pickupDate && pickupTime && returnDate && returnTime
            ? ({
                pickupDate,
                pickupTime,
                returnDate,
                returnTime,
                sessionKey: sessionKey || readReservationHoldSessionKeyFromStorage(),
              } satisfies FetchVehiclesRentalWindow)
            : null;

        const data = await withRetry(
          () => fetchVehicles(controller.signal, windowPayload),
          controller.signal,
        );
        if (cancelled) return;
        setVehicles(data);
      } catch (caught) {
        if (cancelled || isAbortError(caught)) return;
        if (process.env.NODE_ENV !== "production") {
          console.error("[useVehicles] Failed to fetch vehicles", caught);
        }
        setError("Unable to load vehicles right now. Please try again.");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    // Swallow abort rejections from StrictMode remounts / fast navigation so they
    // never surface in the Next.js runtime error overlay.
    void loadVehicles().catch((e: unknown) => {
      if (cancelled || isAbortError(e)) return;
      if (process.env.NODE_ENV !== "production") {
        console.error("[useVehicles] Unhandled error outside async body", e);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [enabled, pickupDate, pickupTime, returnDate, returnTime, sessionKey]);

  if (!enabled) {
    return { vehicles: [], isLoading: false, error: null };
  }

  return { vehicles, isLoading, error };
}

export function useVehicle(slug: string): UseVehicleResult {
  const normalizedSlug = slug.trim();
  const shouldFetch = normalizedSlug.length > 0;
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldFetch) {
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const loadVehicle = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const data = await withRetry(
          () => fetchVehicleBySlug(normalizedSlug, controller.signal),
          controller.signal,
        );
        if (cancelled) return;
        setVehicle(data);
      } catch (caught) {
        if (cancelled || isAbortError(caught)) return;
        if (process.env.NODE_ENV !== "production") {
          console.error("[useVehicle] Failed to fetch vehicle", { slug: normalizedSlug, error: caught });
        }
        setError("Unable to load this vehicle right now. Please try again.");
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };
    void loadVehicle().catch((e: unknown) => {
      if (cancelled || isAbortError(e)) return;
      if (process.env.NODE_ENV !== "production") {
        console.error("[useVehicle] Unhandled error outside async body", e);
      }
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [normalizedSlug, shouldFetch]);

  if (!shouldFetch) {
    return { vehicle: null, isLoading: false, error: "Vehicle not found." };
  }

  return { vehicle, isLoading, error };
}
