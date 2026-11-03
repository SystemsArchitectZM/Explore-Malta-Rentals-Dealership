"use client";

import { AvailabilityStep } from "@/features/kiosk/steps/availability-step";
import { VehiclesStep } from "@/features/kiosk/steps/vehicles-step";
import { VehicleDetailsStep } from "@/features/kiosk/steps/vehicle-details-step";
import { OptionsStep } from "@/features/kiosk/steps/options-step";
import { CustomerStep } from "@/features/kiosk/steps/customer-step";
import { ReviewStep } from "@/features/kiosk/steps/review-step";
import { ConfirmStep } from "@/features/kiosk/steps/confirm-step";
import { KioskFooterNav } from "@/features/kiosk/components/kiosk-footer-nav";
import { KioskHeader } from "@/features/kiosk/components/kiosk-header";
import { KioskStepper } from "@/features/kiosk/components/kiosk-stepper";
import { InactivityGuard } from "@/features/kiosk/components/inactivity-guard";
import { KioskBookingProvider, useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";

function KioskBookingFlowInner() {
  const {
    state,
    stepId,
    stepIndex,
    stepError,
    setStepError,
    goBack,
    goNext,
    submitKioskBooking,
    isCreatingHold,
    isSubmitting,
  } = useKioskBooking();

  const handlePrimary = async () => {
    if (stepId === "review") {
      setStepError(null);
      const result = await submitKioskBooking();
      if (!result.ok && result.message) {
        setStepError(result.message);
      }
      return;
    }
    if (stepId === "availability") {
      return;
    }
    await goNext();
  };

  const primaryLabel =
    stepId === "review"
      ? state.payment.mode === "stripe"
        ? "Pay & submit"
        : "Submit booking"
      : stepId === "vehicles" || stepId === "vehicle_details"
        ? "Continue"
        : "Continue";

  const showFooter = stepId !== "confirm" && stepId !== "availability";

  return (
    <div className="flex min-h-dvh flex-col bg-[#e8edf2] text-[#0c2340]">
      <KioskHeader />
      <KioskStepper />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 pb-32 sm:px-8">
        {stepError && stepId !== "review" ? (
          <p
            className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700"
            role="alert"
          >
            {stepError}
          </p>
        ) : null}
        {stepId === "availability" ? <AvailabilityStep /> : null}
        {stepId === "vehicles" ? <VehiclesStep /> : null}
        {stepId === "vehicle_details" ? <VehicleDetailsStep /> : null}
        {stepId === "options" ? <OptionsStep /> : null}
        {stepId === "customer" ? <CustomerStep /> : null}
        {stepId === "review" ? <ReviewStep /> : null}
        {stepId === "confirm" ? <ConfirmStep /> : null}
      </main>
      {showFooter ? (
        <KioskFooterNav
          onBack={goBack}
          backDisabled={stepIndex === 0 || isSubmitting}
          onPrimary={() => void handlePrimary()}
          primaryLabel={primaryLabel}
          primaryLoading={isCreatingHold || isSubmitting}
        />
      ) : null}
      <InactivityGuard />
    </div>
  );
}

export function KioskBookingFlow() {
  return (
    <KioskBookingProvider>
      <KioskBookingFlowInner />
    </KioskBookingProvider>
  );
}
