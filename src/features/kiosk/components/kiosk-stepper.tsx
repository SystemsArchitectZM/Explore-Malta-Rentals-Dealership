"use client";

import { Check } from "lucide-react";
import { KIOSK_STEPS } from "@/features/kiosk/lib/steps";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";

export function KioskStepper() {
  const { stepIndex } = useKioskBooking();

  return (
    <nav aria-label="Booking progress" className="shrink-0 bg-[#0c2340] px-4 pb-3 pt-1 sm:px-8">
      <ol className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {KIOSK_STEPS.map((step, index) => {
          const isActive = index === stepIndex;
          const isComplete = index < stepIndex;
          const markerClass = isActive
            ? "border-[#f9900f] bg-[#f9900f] text-white"
            : isComplete
              ? "border-[#0c2340] bg-white text-[#0c2340]"
              : "border-white/30 bg-transparent text-white/50";

          return (
            <li key={step.id} className="flex items-center gap-2">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold tabular-nums ${markerClass}`}
                aria-current={isActive ? "step" : undefined}
              >
                {isComplete ? <Check className="h-4 w-4" strokeWidth={3} aria-hidden /> : index + 1}
              </span>
              <span
                className={`hidden text-sm font-medium sm:inline ${
                  isActive ? "text-[#ffa939]" : isComplete ? "text-white" : "text-white/45"
                }`}
              >
                {step.label}
              </span>
              {index < KIOSK_STEPS.length - 1 ? (
                <span aria-hidden className="mx-1 hidden h-px w-4 bg-white/20 sm:block" />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
