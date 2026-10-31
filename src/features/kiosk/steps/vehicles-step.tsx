"use client";

import Image from "next/image";
import { Bike } from "lucide-react";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { getBookingPricingBreakdown } from "@/features/booking-flow/lib/pricing";
import { formatVehicleTypeLabel } from "@/features/vehicles/data/vehicles";
import { formatEur } from "@/lib/pricing/calculate-booking-price";

export function VehiclesStep() {
  const { state, availableVehicles, updateSection } = useKioskBooking();

  const selectVehicle = (vehicle: (typeof availableVehicles)[number]) => {
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

  return (
    <KioskPanel
      title="Choose your vehicle"
      subtitle="Prices shown are rental subtotal for your selected dates."
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
            return (
              <li
                key={vehicle.id}
                className={`flex flex-col overflow-hidden rounded-xl border-2 bg-white shadow-sm transition ${
                  selected ? "border-[#f9900f] ring-2 ring-[#f9900f]/30" : "border-slate-200"
                }`}
              >
                <div className="relative aspect-[4/3] bg-slate-100">
                  {vehicle.mainImageUrl ? (
                    <Image
                      src={vehicle.mainImageUrl}
                      alt={vehicle.name}
                      fill
                      className="object-cover"
                      sizes="(max-width: 768px) 100vw, 33vw"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-slate-400">No image</div>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <h3 className="text-lg font-bold text-[#0c2340]">{vehicle.name}</h3>
                  <p className="text-sm text-slate-600">
                    {formatVehicleTypeLabel(vehicle.apiVehicleType)}
                    {vehicle.engineCc ? ` · ${vehicle.engineCc}cc` : ""}
                  </p>
                  <p className="mt-2 text-lg font-bold tabular-nums text-[#f9900f]">
                    {pricing ? formatEur(pricing.totalEur) : "—"}
                  </p>
                  <button
                    type="button"
                    onClick={() => selectVehicle(vehicle)}
                    className="mt-auto min-h-12 rounded-lg border-2 border-[#0c2340] px-4 text-sm font-semibold text-[#0c2340] hover:bg-[#0c2340]/5"
                  >
                    {selected ? "Selected" : "Select vehicle"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </KioskPanel>
  );
}
