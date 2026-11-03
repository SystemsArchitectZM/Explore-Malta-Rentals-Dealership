"use client";

import Image from "next/image";
import { Check, CarFront } from "lucide-react";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { colorsMatch } from "@/features/vehicles/lib/vehicle-color";
import { formatVehicleTypeLabel, isApiVehicleType } from "@/features/vehicles/data/vehicles";
import { getBookingPricingBreakdown } from "@/features/booking-flow/lib/pricing";
import { formatEur } from "@/lib/pricing/calculate-booking-price";

export function VehicleDetailsStep() {
  const { state, availableVehicles, selectedVehicleAvailableColors, updateSection, reservationHoldError } =
    useKioskBooking();

  const listedVehicle = availableVehicles.find((v) => v.id === state.rental.vehicleId);
  const rental = state.rental;
  const hasSelectedVehicle = Boolean(rental.vehicleId);

  const displayName = listedVehicle?.name ?? rental.vehicleName;
  const displayImage = listedVehicle?.mainImageUrl ?? rental.mainImageUrl;
  const displayEngineCc = listedVehicle?.engineCc ?? rental.engineCc;
  const displayType = listedVehicle?.apiVehicleType
    ?? (isApiVehicleType(rental.vehicleType) ? rental.vehicleType : null);
  const displayDescription = listedVehicle?.description ?? null;
  const displayShortDescription =
    listedVehicle?.shortDescription ?? rental.shortDescription ?? null;
  const baseDailyRate = listedVehicle?.baseDailyRate ?? rental.baseDailyRate;

  const pricing =
    hasSelectedVehicle && baseDailyRate > 0
      ? getBookingPricingBreakdown(
          baseDailyRate,
          rental.pickupDate,
          rental.pickupTime,
          rental.returnDate,
          rental.returnTime,
        )
      : null;

  if (!hasSelectedVehicle) {
    return (
      <KioskPanel title="Vehicle details" subtitle="Select a vehicle first.">
        <p className="text-slate-600">No vehicle selected.</p>
      </KioskPanel>
    );
  }

  return (
    <KioskPanel
      title="Confirm your vehicle"
      subtitle="Choose a colour if available, acknowledge the price, then continue to reserve this unit."
      icon={<CarFront className="h-6 w-6" aria-hidden />}
    >
      {!listedVehicle ? (
        <p className="mb-4 text-sm text-slate-500">Restoring vehicle details…</p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-slate-100">
          {displayImage ? (
            <Image src={displayImage} alt={displayName || "Vehicle"} fill className="object-cover" sizes="50vw" />
          ) : null}
        </div>
        <div>
          <h3 className="text-2xl font-bold text-[#0c2340]">{displayName || "Selected vehicle"}</h3>
          <p className="text-slate-600">
            {displayType ? formatVehicleTypeLabel(displayType) : rental.vehicleType}
            {displayEngineCc ? ` · ${displayEngineCc}cc` : ""}
          </p>
          {displayDescription ? (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">
              {displayDescription}
            </p>
          ) : displayShortDescription ? (
            <p className="mt-2 text-sm text-slate-600">{displayShortDescription}</p>
          ) : null}
          <p className="mt-4 text-2xl font-bold tabular-nums text-[#f9900f]">
            {pricing ? formatEur(pricing.totalEur) : "—"}{" "}
            <span className="text-sm font-normal text-slate-500">rental subtotal</span>
          </p>
          {pricing ? (
            <p className="mt-1 text-xs text-slate-500">
              {pricing.billableDays} billable day(s) · {pricing.tierRange} ·{" "}
              {formatEur(pricing.appliedDailyRateEur)}/day after duration discount
            </p>
          ) : null}
        </div>
      </div>

      {selectedVehicleAvailableColors.length > 0 ? (
        <fieldset className="mt-6">
          <legend className="text-sm font-semibold text-slate-700">Colour</legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {selectedVehicleAvailableColors.map((option) => {
              const selected = colorsMatch(state.rental.selectedColor, option.label);
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => updateSection("rental", { selectedColor: option.label })}
                  className={`inline-flex min-h-12 items-center gap-2 rounded-full border-2 px-5 text-sm font-semibold ${
                    selected
                      ? "border-[#f9900f] bg-orange-50 text-[#0c2340]"
                      : "border-slate-300 text-slate-700"
                  }`}
                >
                  {selected ? <Check className="h-4 w-4" aria-hidden /> : null}
                  {option.label}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <label className="mt-6 flex min-h-12 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5 accent-[#f9900f]"
          checked={state.rental.pricingAcknowledged}
          onChange={(e) => updateSection("rental", { pricingAcknowledged: e.target.checked })}
        />
        <span className="text-sm text-slate-700">
          I understand this rental price for the selected dates
          {pricing ? ` (${formatEur(pricing.totalEur)})` : ""}. Final total may include insurance,
          extras, hotel discount, and the security deposit shown later.
        </span>
      </label>

      {reservationHoldError ? (
        <p className="mt-4 text-sm font-medium text-red-600">{reservationHoldError}</p>
      ) : null}
    </KioskPanel>
  );
}
