"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  CheckCircle2,
  MapPin,
  X,
  Zap,
} from "lucide-react";
import type { Vehicle } from "@/features/vehicles/data/vehicles";
import { formatVehicleTypeLabel } from "@/features/vehicles/data/vehicles";
import { VehicleDetailGallery } from "@/features/vehicles/components/vehicle-detail-gallery";
import { VehicleDetailSections } from "@/features/vehicles/components/vehicle-detail-content-sections";
import { fetchVehicleBySlug } from "@/features/vehicles/lib/vehicles-api";
import {
  buildDurationPricingPreview,
  roundPricingAmount,
} from "@/lib/pricing/duration-pricing";

type KioskVehicleDetailsModalProps = {
  vehicle: Vehicle | null;
  priceLabel: string | null;
  isSelected: boolean;
  onClose: () => void;
  onSelect: (vehicle: Vehicle) => void;
};

function formatTierRateEur(value: number): string {
  return roundPricingAmount(value).toFixed(2).replace(/\.00$/, "");
}

export function KioskVehicleDetailsModal({
  vehicle,
  priceLabel,
  isSelected,
  onClose,
  onSelect,
}: KioskVehicleDetailsModalProps) {
  const [mounted, setMounted] = useState(false);
  const [detailVehicle, setDetailVehicle] = useState<Vehicle | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!vehicle) {
      setDetailVehicle(null);
      setDetailError(null);
      setLoadingDetail(false);
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [vehicle, onClose]);

  useEffect(() => {
    if (!vehicle) return;

    const controller = new AbortController();
    setLoadingDetail(true);
    setDetailError(null);
    setDetailVehicle(vehicle);

    void fetchVehicleBySlug(vehicle.slug, controller.signal)
      .then((full) => {
        if (controller.signal.aborted) return;
        setDetailVehicle(full ?? vehicle);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setDetailVehicle(vehicle);
        setDetailError(error instanceof Error ? error.message : "Unable to load full details.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingDetail(false);
      });

    return () => controller.abort();
  }, [vehicle]);

  const displayVehicle = detailVehicle ?? vehicle;

  const durationPreview = useMemo(
    () => (displayVehicle ? buildDurationPricingPreview(displayVehicle.baseDailyRate) : []),
    [displayVehicle],
  );

  if (!vehicle || !mounted || !displayVehicle) {
    return null;
  }

  const typeLabel = formatVehicleTypeLabel(displayVehicle.apiVehicleType);
  const brandModel = [displayVehicle.brand, displayVehicle.model].filter(Boolean).join(" ");
  const galleryImages =
    displayVehicle.images.length > 0
      ? displayVehicle.images
      : displayVehicle.mainImageUrl
        ? [displayVehicle.mainImageUrl]
        : [];

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-[#0a1420]/60 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kiosk-vehicle-details-title"
        className="flex max-h-[min(94dvh,960px)] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white text-[#0c2340] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#f9900f]">
              {typeLabel}
            </p>
            <h3
              id="kiosk-vehicle-details-title"
              className="mt-1 text-xl font-bold sm:text-2xl"
            >
              {displayVehicle.name}
            </h3>
            {brandModel ? (
              <p className="mt-1 text-sm text-slate-600">{brandModel}</p>
            ) : (
              <p className="mt-1 text-sm text-slate-600">
                {typeLabel}
                {displayVehicle.engineCc ? ` · ${displayVehicle.engineCc}cc` : ""}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-sm text-slate-600">
                <MapPin className="h-3.5 w-3.5 text-[#f9900f]" aria-hidden />
                {displayVehicle.location}, Malta
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-orange-800 ring-1 ring-inset ring-orange-200">
                <Zap className="h-3 w-3" aria-hidden />
                Popular
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-800 ring-1 ring-inset ring-emerald-200">
                <CheckCircle2 className="h-3 w-3" aria-hidden />
                Verified vehicle
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-slate-200 text-slate-600"
            aria-label="Close vehicle details"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6">
          {loadingDetail ? (
            <p className="mb-4 text-sm text-slate-500">Loading full vehicle details…</p>
          ) : null}
          {detailError ? (
            <p className="mb-4 text-sm text-amber-700">{detailError}</p>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7">
              <VehicleDetailGallery
                name={displayVehicle.name}
                images={galleryImages}
                lightboxZClassName="z-[11000]"
              />
            </div>
            <div className="space-y-4 lg:col-span-5">
              {priceLabel ? (
                <p className="text-2xl font-bold tabular-nums text-[#f9900f]">
                  {priceLabel}{" "}
                  <span className="text-sm font-normal text-slate-500">rental subtotal</span>
                </p>
              ) : null}
              {displayVehicle.baseDailyRate > 0 ? (
                <p className="text-lg font-bold text-[#0c2340]">
                  From €{displayVehicle.baseDailyRate}
                  <span className="ml-1 text-sm font-medium text-slate-500">/ day</span>
                </p>
              ) : null}
              {durationPreview.length > 0 ? (
                <ul className="divide-y divide-slate-100 border-y border-slate-100">
                  {durationPreview.map((row) => (
                    <li
                      key={`${row.minDays}-${row.maxDays ?? "plus"}`}
                      className="py-1.5 text-xs leading-relaxed text-slate-600"
                    >
                      {row.label}: {row.discountPercent}% off → €
                      {formatTierRateEur(row.appliedDailyRate)}/day
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs leading-relaxed text-slate-500">
                Cancellations more than 48 hours before the scheduled rental start receive a 50%
                refund of the booking amount. Within 48 hours, the booking is non-refundable.
              </p>
            </div>
          </div>

          <div className="mt-8">
            <VehicleDetailSections vehicle={displayVehicle} />
          </div>
        </div>

        <footer className="border-t border-slate-200 bg-slate-50 px-5 py-4 sm:px-6">
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex min-h-12 items-center justify-center rounded-xl border-2 border-[#0c2340] px-6 text-base font-semibold text-[#0c2340]"
            >
              Close
            </button>
            <button
              type="button"
              onClick={() => onSelect(displayVehicle)}
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-[#f9900f] px-8 text-base font-bold text-white"
            >
              {isSelected ? "Selected" : "Select vehicle"}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
