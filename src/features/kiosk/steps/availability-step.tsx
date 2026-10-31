"use client";

import { addDays, format, parse } from "date-fns";
import { CalendarDays, Clock3, Info, MapPin } from "lucide-react";
import { useState } from "react";
import { Link } from "@/i18n/navigation";
import { KioskDatePicker } from "@/features/kiosk/components/kiosk-date-picker";
import { KioskTimeSelect } from "@/features/kiosk/components/kiosk-time-select";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { validateAvailability } from "@/features/kiosk/lib/validation";
import { fetchVehicles } from "@/features/vehicles/lib/vehicles-api";
import {
  calculateRentalDuration,
  MAX_BILLABLE_RENTAL_DAYS,
} from "@/lib/pricing/rental-duration";

function formatActualHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function formatDisplayDate(isoDate: string): string {
  if (!isoDate) return "—";
  const parsed = parse(isoDate, "yyyy-MM-dd", new Date());
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return format(parsed, "dd MMM yyyy");
}

export function AvailabilityStep() {
  const { state, updateSection, setAvailableVehicles, setStepError, goNext, reservationHold } =
    useKioskBooking();
  const { pickupDate, pickupTime, returnDate, returnTime } = state.rental;
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const today = new Date();
  const pickupMinDate = format(today, "yyyy-MM-dd");
  const parsedPickupDate = pickupDate ? parse(pickupDate, "yyyy-MM-dd", new Date()) : null;
  const pickupBaseDate =
    parsedPickupDate && !Number.isNaN(parsedPickupDate.getTime()) ? parsedPickupDate : today;
  const returnMinDate = format(pickupBaseDate, "yyyy-MM-dd");
  const returnMaxDate = format(addDays(pickupBaseDate, MAX_BILLABLE_RENTAL_DAYS - 1), "yyyy-MM-dd");

  const duration =
    pickupDate && pickupTime && returnDate && returnTime
      ? calculateRentalDuration(pickupDate, pickupTime, returnDate, returnTime)
      : null;

  const checkVehicles = async () => {
    const validationError = validateAvailability(state);
    if (validationError) {
      setStepError(validationError);
      setFetchError(validationError);
      return;
    }
    setStepError(null);
    setFetchError(null);
    setLoading(true);
    try {
      const vehicles = await fetchVehicles(undefined, {
        pickupDate: pickupDate.trim(),
        pickupTime: pickupTime.trim(),
        returnDate: returnDate.trim(),
        returnTime: returnTime.trim(),
        sessionKey: reservationHold.sessionKey?.trim() || undefined,
      });
      const bookable = vehicles.filter(
        (v) => v.rentalWindowStatus === "available" || v.rentalWindowStatus === "reserved_you",
      );
      setAvailableVehicles(bookable);
      if (bookable.length === 0) {
        setFetchError("No vehicles are available for these dates. Try different dates or times.");
        return;
      }
      await goNext();
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : "Unable to load vehicles.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KioskPanel
      title="Check Availability"
      subtitle="Enter rental dates and times to see available vehicles."
      icon={<CalendarDays className="h-6 w-6" aria-hidden />}
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <KioskDatePicker
          id="kiosk-pickup-date"
          label="Pickup Date"
          value={pickupDate}
          min={pickupMinDate}
          onChange={(next) =>
            updateSection("rental", { pickupDate: next, pricingAcknowledged: false })
          }
        />
        <KioskTimeSelect
          id="kiosk-pickup-time"
          label="Pickup Time"
          value={pickupTime}
          onChange={(next) =>
            updateSection("rental", { pickupTime: next, pricingAcknowledged: false })
          }
        />
        <KioskDatePicker
          id="kiosk-return-date"
          label="Return Date"
          value={returnDate}
          min={returnMinDate}
          max={returnMaxDate}
          onChange={(next) =>
            updateSection("rental", { returnDate: next, pricingAcknowledged: false })
          }
        />
        <KioskTimeSelect
          id="kiosk-return-time"
          label="Return Time"
          value={returnTime}
          onChange={(next) =>
            updateSection("rental", { returnTime: next, pricingAcknowledged: false })
          }
        />
      </div>

      <div className="mt-5 flex gap-3 rounded-xl border border-[#3a7ca5]/25 bg-[#eef6fb] px-4 py-4 text-[#0c2340]">
        <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-[#3a7ca5]" aria-hidden />
        <div>
          <p className="font-semibold">
            Estimated duration:{" "}
            {duration
              ? `${duration.billableDays} day(s) (${formatActualHours(duration.actualDurationHours)}h)`
              : "—"}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {duration
              ? `${formatDisplayDate(pickupDate)} ${pickupTime} → ${formatDisplayDate(returnDate)} ${returnTime} · ${duration.billableDays} billable day(s), ${formatActualHours(duration.actualDurationHours)} elapsed hours`
              : "Enter dates and times above"}
          </p>
        </div>
      </div>

      <div className="mt-4 flex gap-3 rounded-xl border border-[#f9900f]/30 bg-[#fff8ed] px-4 py-4">
        <Info className="mt-0.5 h-5 w-5 shrink-0 text-[#f9900f]" aria-hidden />
        <ul className="space-y-1 text-sm text-slate-700">
          <li>Minimum rental is 24 hours.</li>
          <li>If less than 24 hours, a full day is charged.</li>
          <li>Maximum rental is 4 weeks.</li>
          <li>Renewable option is available at the office.</li>
        </ul>
      </div>

      <div className="mt-4 flex gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4">
        <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-[#3a7ca5]" aria-hidden />
        <p className="text-sm text-slate-700">
          <strong className="text-[#0c2340]">Kiosk booking</strong> — Office pickup and return by
          default. Delivery can be arranged with staff at the counter if needed.
        </p>
      </div>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Link
          href="/kiosk"
          className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border-2 border-[#0c2340] bg-white px-6 text-base font-semibold text-[#0c2340]"
        >
          Back to Home
        </Link>
        <button
          type="button"
          disabled={loading}
          onClick={() => void checkVehicles()}
          className="inline-flex min-h-14 items-center justify-center rounded-xl bg-[#f9900f] px-8 text-base font-bold text-white disabled:opacity-60"
        >
          {loading ? "Checking availability…" : "Check Available Vehicles →"}
        </button>
      </div>

      {fetchError ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {fetchError}
        </p>
      ) : null}
    </KioskPanel>
  );
}
