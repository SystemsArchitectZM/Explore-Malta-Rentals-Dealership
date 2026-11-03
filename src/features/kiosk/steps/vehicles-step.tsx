"use client";

import { useState } from "react";
import Image from "next/image";
import { Bike } from "lucide-react";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { KioskVehicleDetailsModal } from "@/features/kiosk/components/kiosk-vehicle-details-modal";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { getBookingPricingBreakdown } from "@/features/booking-flow/lib/pricing";
import { formatVehicleTypeLabel, type Vehicle } from "@/features/vehicles/data/vehicles";
import { formatEur } from "@/lib/pricing/calculate-booking-price";

function vehicleCardDescription(vehicle: Vehicle): string {
  return (
    vehicle.shortDescription?.trim() ||
    vehicle.tagline?.trim() ||
    vehicle.description?.trim() ||
    ""
  );
}

function helmetsLabel(count: number): string {
  if (count <= 0) return "HELMETS ON REQUEST";
  return `${count} HELMET${count === 1 ? "" : "S"}`;
}

export function VehiclesStep() {
  const { state, availableVehicles, updateSection } = useKioskBooking();
  const [detailsVehicleId, setDetailsVehicleId] = useState<string | null>(null);

  const selectVehicle = (vehicle: Vehicle) => {
    updateSection("rental", {
      vehicleId: vehicle.id,
      vehicleSlug: vehicle.slug,
      vehicleName: vehicle.name,
      vehicleType: vehicle.apiVehicleType,
      engineCc: vehicle.engineCc,
      baseDailyRate: vehicle.baseDailyRate,
      supportsStorageBox: vehicle.supportsStorageBox,
      mainImageUrl: vehicle.mainImageUrl,
      shortDescription: vehicle.shortDescription ?? vehicle.tagline,
      selectedColor: null,
      pricingAcknowledged: false,
    });
  };

  const detailsVehicle =
    detailsVehicleId != null
      ? availableVehicles.find((vehicle) => vehicle.id === detailsVehicleId) ?? null
      : null;

  const detailsPricing = detailsVehicle
    ? getBookingPricingBreakdown(
        detailsVehicle.baseDailyRate,
        state.rental.pickupDate,
        state.rental.pickupTime,
        state.rental.returnDate,
        state.rental.returnTime,
      )
    : null;

  return (
    <KioskPanel
      title="Choose your vehicle"
      subtitle="Daily rates shown below. Trip subtotal for your dates appears under each price."
      icon={<Bike className="h-6 w-6" aria-hidden />}
    >
      {availableVehicles.length === 0 ? (
        <p className="text-slate-600">No vehicles loaded. Go back and check availability.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {availableVehicles.map((vehicle) => {
            const pricing = getBookingPricingBreakdown(
              vehicle.baseDailyRate,
              state.rental.pickupDate,
              state.rental.pickupTime,
              state.rental.returnDate,
              state.rental.returnTime,
            );
            const selected = state.rental.vehicleId === vehicle.id;
            const description = vehicleCardDescription(vehicle);
            return (
              <li
                key={vehicle.id}
                className={`group flex flex-col overflow-hidden rounded-xl border bg-white shadow-sm transition ${
                  selected
                    ? "border-[#f9900f] ring-2 ring-[#f9900f]/30"
                    : "border-slate-200 hover:border-slate-300"
                }`}
              >
                <div className="relative aspect-[4/3] overflow-hidden bg-white">
                  {vehicle.mainImageUrl ? (
                    <Image
                      src={vehicle.mainImageUrl}
                      alt={vehicle.name}
                      fill
                      className="object-contain object-center p-3 transition-transform duration-300 group-hover:scale-[1.03]"
                      sizes="(max-width: 768px) 100vw, 33vw"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-sm text-slate-400">
                      No image
                    </div>
                  )}
                  <span className="absolute left-3 top-3 inline-flex items-center rounded-full border border-white/60 bg-white/85 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-800 shadow-sm backdrop-blur-md">
                    {formatVehicleTypeLabel(vehicle.apiVehicleType)}
                  </span>
                </div>

                <div className="flex flex-1 flex-col p-4 sm:p-5">
                  <div>
                    <h3 className="text-[1.0625rem] font-semibold leading-snug tracking-[-0.025em] text-[#0a1420]">
                      {vehicle.name}
                    </h3>
                    {description ? (
                      <p className="mt-1.5 line-clamp-2 text-[0.8125rem] leading-relaxed text-slate-500">
                        {description}
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs font-medium text-slate-400">
                      {formatVehicleTypeLabel(vehicle.apiVehicleType)}
                      {vehicle.engineCc ? ` · ${vehicle.engineCc}cc` : ""}
                    </p>
                  </div>

                  <ul className="mt-4 grid grid-cols-2 divide-x divide-slate-200 border-y border-slate-200">
                    <li className="flex items-center py-2.5 pr-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {helmetsLabel(vehicle.helmetIncludedCount)}
                    </li>
                    <li className="flex items-center py-2.5 pl-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {vehicle.supportsStorageBox ? "STORAGE BOX" : "NO STORAGE BOX"}
                    </li>
                  </ul>

                  <div className="mt-auto pt-4">
                    {vehicle.baseDailyRate > 0 ? (
                      <p className="text-[1.3125rem] font-bold leading-none tracking-[-0.035em] text-[#0a1420]">
                        From €{vehicle.baseDailyRate}
                        <span className="text-base font-semibold">/day</span>
                      </p>
                    ) : (
                      <p className="text-sm font-semibold text-slate-500">Price on request</p>
                    )}
                    {pricing ? (
                      <p className="mt-1.5 text-xs font-medium tabular-nums text-[#f9900f]">
                        Trip total {formatEur(pricing.totalEur)}
                      </p>
                    ) : null}

                    <div className="mt-4 flex items-stretch gap-2">
                      <button
                        type="button"
                        onClick={() => setDetailsVehicleId(vehicle.id)}
                        className="inline-flex min-h-11 flex-1 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-[#0a1420] transition hover:border-slate-400 hover:bg-slate-50"
                      >
                        View details
                      </button>
                      <button
                        type="button"
                        onClick={() => selectVehicle(vehicle)}
                        className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-lg px-3 text-sm font-semibold transition ${
                          selected
                            ? "bg-[#f9900f] text-white shadow-sm ring-2 ring-[#f9900f]/35"
                            : "bg-[#f9900f] text-[#0a1420] shadow-sm hover:bg-[#ea860c]"
                        }`}
                      >
                        {selected ? "Selected" : "Select"}
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <KioskVehicleDetailsModal
        vehicle={detailsVehicle}
        priceLabel={detailsPricing ? formatEur(detailsPricing.totalEur) : null}
        isSelected={detailsVehicle != null && state.rental.vehicleId === detailsVehicle.id}
        onClose={() => setDetailsVehicleId(null)}
        onSelect={(vehicle) => {
          selectVehicle(vehicle);
          setDetailsVehicleId(null);
        }}
      />
    </KioskPanel>
  );
}
