"use client";

import { useEffect, useRef, useState } from "react";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";

const WARN_MS = 4 * 60 * 1000;
const RESET_MS = 5 * 60 * 1000;

export function InactivityGuard() {
  const { resetSession, stepId } = useKioskBooking();
  const [showWarning, setShowWarning] = useState(false);
  const warnTimerRef = useRef<number | null>(null);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (stepId === "confirm") {
      return;
    }

    const clearTimers = () => {
      if (warnTimerRef.current) {
        window.clearTimeout(warnTimerRef.current);
        warnTimerRef.current = null;
      }
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };

    const schedule = () => {
      clearTimers();
      setShowWarning(false);
      warnTimerRef.current = window.setTimeout(() => {
        setShowWarning(true);
      }, WARN_MS);
      resetTimerRef.current = window.setTimeout(() => {
        void resetSession();
        setShowWarning(false);
      }, RESET_MS);
    };

    const onActivity = () => {
      schedule();
    };

    schedule();
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("touchstart", onActivity);

    return () => {
      clearTimers();
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("touchstart", onActivity);
    };
  }, [resetSession, stepId]);

  if (!showWarning) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0c2340]/70 p-6">
      <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
        <h3 className="text-xl font-bold text-[#0c2340]">Still there?</h3>
        <p className="mt-3 text-slate-600">
          This session will reset in about one minute to protect your privacy. Touch the screen to
          continue booking.
        </p>
        <button
          type="button"
          className="mt-6 min-h-12 w-full rounded-xl bg-[#f9900f] px-6 text-base font-bold text-white"
          onClick={() => setShowWarning(false)}
        >
          Continue booking
        </button>
      </div>
    </div>
  );
}
