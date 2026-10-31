"use client";

import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { normalizeHotelCode } from "@/lib/hotel-codes/normalize-hotel-code";

type ValidateResponse =
  | {
      success: true;
      valid: true;
      code: string;
      discountPercent: number;
      partnerName: string;
    }
  | {
      success: false;
      valid: false;
      message: string;
    };

export function KioskHotelCodeField() {
  const { state, updateSection } = useKioskBooking();
  const [isValidating, setIsValidating] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validateCode = useCallback(
    async (rawCode: string) => {
      const normalized = normalizeHotelCode(rawCode);
      if (!normalized) {
        updateSection("hotelCode", {
          code: rawCode,
          appliedCode: null,
          discountPercent: null,
          partnerName: null,
          error: null,
        });
        return;
      }

      setIsValidating(true);
      try {
        const response = await fetch("/api/hotel-codes/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: normalized }),
        });
        const payload = (await response.json()) as ValidateResponse;

        if (!response.ok || !payload.success || !payload.valid) {
          updateSection("hotelCode", {
            code: normalized,
            appliedCode: null,
            discountPercent: null,
            partnerName: null,
            error:
              payload.success === false
                ? payload.message
                : "This hotel code is invalid or inactive.",
          });
          return;
        }

        updateSection("hotelCode", {
          code: normalized,
          appliedCode: payload.code,
          discountPercent: payload.discountPercent,
          partnerName: payload.partnerName,
          error: null,
        });
      } catch {
        updateSection("hotelCode", {
          code: normalized,
          appliedCode: null,
          discountPercent: null,
          partnerName: null,
          error: "Unable to validate hotel code. Try again.",
        });
      } finally {
        setIsValidating(false);
      }
    },
    [updateSection],
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  function handleChange(value: string) {
    updateSection("hotelCode", {
      code: value,
      appliedCode: null,
      discountPercent: null,
      partnerName: null,
      error: null,
    });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void validateCode(value);
    }, 450);
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <h3 className="text-lg font-bold text-[#0c2340]">Hotel partner code</h3>
      <p className="mt-1 text-sm text-slate-600">
        Optional. Same validation as the website booking flow.
      </p>
      <div className="relative mt-3 max-w-md">
        <input
          type="text"
          value={state.hotelCode.code}
          onChange={(e) => handleChange(e.target.value)}
          onBlur={() => void validateCode(state.hotelCode.code)}
          autoComplete="off"
          spellCheck={false}
          placeholder="Enter code"
          className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 pr-10 text-base font-semibold uppercase tracking-[0.06em] text-[#0c2340] focus:border-[#f9900f] focus:outline-none focus:ring-2 focus:ring-[#f9900f]/30"
        />
        {isValidating ? (
          <Loader2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" />
        ) : null}
      </div>
      {state.hotelCode.error ? (
        <p className="mt-2 text-sm font-medium text-red-600" role="alert">
          {state.hotelCode.error}
        </p>
      ) : null}
      {state.hotelCode.appliedCode && state.hotelCode.discountPercent != null ? (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 ring-1 ring-emerald-200">
          <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
          {state.hotelCode.discountPercent}% off — {state.hotelCode.partnerName ?? state.hotelCode.appliedCode}
        </p>
      ) : null}
    </section>
  );
}
