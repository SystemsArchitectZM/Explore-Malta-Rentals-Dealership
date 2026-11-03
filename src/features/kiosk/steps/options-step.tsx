"use client";

import { useMemo } from "react";
import { format, subYears } from "date-fns";
import { Settings2 } from "lucide-react";
import { KioskDatePicker } from "@/features/kiosk/components/kiosk-date-picker";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { KioskSelect } from "@/features/kiosk/components/kiosk-select";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import { vehicleTypeNeedsHelmetFlow } from "@/features/booking-flow/lib/helmet-rental";
import {
  getAllowedLicenseCategories,
  getLicenseCategoryHint,
} from "@/features/booking-flow/lib/license-categories";
import { BOOKABLE_HELMET_SIZES } from "@/lib/booking/helmet-sizes";
import {
  INSURANCE_PLAN_CODES,
  INSURANCE_PLANS,
  type InsurancePlanCode,
} from "@/lib/pricing/insurance-plans";
import { KioskHotelCodeField } from "@/features/kiosk/components/kiosk-hotel-code-field";
import { formatEur } from "@/lib/pricing/calculate-booking-price";
import { getBillableRentalDays } from "@/lib/pricing/rental-duration";

const fieldClass =
  "mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base text-[#0c2340] focus:border-[#f9900f] focus:outline-none focus:ring-2 focus:ring-[#f9900f]/30";

const labelCaptionClass = "text-sm font-medium text-slate-700";
const optionBase =
  "mt-2 flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border-2 p-4 text-sm text-[#0c2340] transition";
const optionSelected = "border-[#f9900f] bg-orange-50 font-semibold";
const optionIdle = "border-slate-200 bg-white";
const checkboxRowClass =
  "flex min-h-12 items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 text-[#0c2340]";

const HELMET_SIZE_OPTIONS = BOOKABLE_HELMET_SIZES.map((size) => ({
  value: size,
  label: size,
}));

const todayIso = () => format(new Date(), "yyyy-MM-dd");
const dobMinIso = () => format(subYears(new Date(), 100), "yyyy-MM-dd");

export function OptionsStep() {
  const { state, updateSection } = useKioskBooking();
  const needsHelmet = vehicleTypeNeedsHelmetFlow(state.rental.vehicleType);
  const rentalDays = getBillableRentalDays(
    state.rental.pickupDate,
    state.rental.pickupTime,
    state.rental.returnDate,
    state.rental.returnTime,
  );

  const licenseOptions = useMemo(
    () =>
      getAllowedLicenseCategories(
        state.rental.vehicleType,
        state.rental.vehicleId,
        state.rental.engineCc,
      ).map((cat) => ({ value: cat, label: cat })),
    [state.rental.engineCc, state.rental.vehicleId, state.rental.vehicleType],
  );

  return (
    <KioskPanel
      title="Options & delivery"
      subtitle="Insurance is required. Office pickup is selected by default."
      icon={<Settings2 className="h-6 w-6" aria-hidden />}
    >
      <div className="space-y-8">
        <section>
          <h3 className="text-lg font-bold text-[#0c2340]">Insurance plan</h3>
          <div className="mt-3 grid gap-3" role="radiogroup" aria-label="Insurance plan">
            {INSURANCE_PLAN_CODES.map((code) => {
              const plan = INSURANCE_PLANS[code];
              const selected = state.addons.cdwPlan === code;
              const total = rentalDays > 0 ? plan.dailyRate * rentalDays : null;
              return (
                <label
                  key={code}
                  className={`${optionBase} ${selected ? optionSelected : optionIdle}`}
                >
                  <input
                    type="radio"
                    name="kioskInsurance"
                    checked={selected}
                    onChange={() => updateSection("addons", { cdwPlan: code as InsurancePlanCode })}
                    className="h-5 w-5 accent-[#f9900f]"
                  />
                  <span className="flex-1">
                    <span className="block font-semibold">{plan.label}</span>
                    <span className="block text-xs text-slate-600">{plan.coverageDescription}</span>
                    <span className="mt-1 block text-sm tabular-nums">
                      {plan.dailyRate === 0
                        ? "Free"
                        : `${formatEur(plan.dailyRate)}/day`}
                      {total !== null && plan.dailyRate > 0 ? ` · ${formatEur(total)} total` : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        {needsHelmet ? (
          <section className="grid gap-4 sm:grid-cols-2">
            <h3 className="sm:col-span-2 text-lg font-bold text-[#0c2340]">Helmet sizes</h3>
            <KioskSelect
              id="kiosk-helmet-1"
              label="Helmet 1"
              value={state.addons.helmetSize1}
              options={HELMET_SIZE_OPTIONS}
              placeholder="Select size"
              onChange={(next) => updateSection("addons", { helmetSize1: next })}
            />
            <KioskSelect
              id="kiosk-helmet-2"
              label="Helmet 2"
              value={state.addons.helmetSize2}
              options={HELMET_SIZE_OPTIONS}
              placeholder="Select size"
              onChange={(next) => updateSection("addons", { helmetSize2: next })}
            />
          </section>
        ) : null}

        {state.rental.supportsStorageBox ? (
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={state.addons.storageBox}
              onChange={(e) => updateSection("addons", { storageBox: e.target.checked })}
              className="h-5 w-5 shrink-0 accent-[#f9900f]"
            />
            <span className="font-medium text-[#0c2340]">Add storage box</span>
          </label>
        ) : null}

        <section>
          <label className={checkboxRowClass}>
            <input
              type="checkbox"
              checked={state.addons.additionalDriver}
              onChange={(e) => updateSection("addons", { additionalDriver: e.target.checked })}
              className="h-5 w-5 shrink-0 accent-[#f9900f]"
            />
            <span className="font-medium text-[#0c2340]">Additional driver</span>
          </label>
          {state.addons.additionalDriver ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className={labelCaptionClass}>Full name</span>
                <input
                  className={fieldClass}
                  value={state.additionalDriver.fullName}
                  onChange={(e) => updateSection("additionalDriver", { fullName: e.target.value })}
                />
              </label>
              <label className="block">
                <span className={labelCaptionClass}>Phone</span>
                <input
                  className={fieldClass}
                  value={state.additionalDriver.phone}
                  onChange={(e) => updateSection("additionalDriver", { phone: e.target.value })}
                />
              </label>
              <label className="block">
                <span className={labelCaptionClass}>Email</span>
                <input
                  type="email"
                  className={fieldClass}
                  value={state.additionalDriver.email}
                  onChange={(e) => updateSection("additionalDriver", { email: e.target.value })}
                />
              </label>
              <label className="block">
                <span className={labelCaptionClass}>Nationality</span>
                <input
                  className={fieldClass}
                  value={state.additionalDriver.nationality}
                  onChange={(e) => updateSection("additionalDriver", { nationality: e.target.value })}
                />
              </label>
              <KioskDatePicker
                id="kiosk-additional-dob"
                label="Date of birth"
                value={state.additionalDriver.dateOfBirth}
                min={dobMinIso()}
                max={todayIso()}
                placeholder="Select date of birth"
                yearDropdown
                size="default"
                onChange={(next) => updateSection("additionalDriver", { dateOfBirth: next })}
              />
              <div className="sm:col-span-2">
                <KioskSelect
                  id="kiosk-additional-license"
                  label="License category"
                  value={state.additionalDriver.licenseCategory}
                  options={licenseOptions}
                  placeholder="Select"
                  hint={getLicenseCategoryHint(state.rental.vehicleType, state.rental.engineCc)}
                  onChange={(next) =>
                    updateSection("additionalDriver", {
                      licenseCategory: next as typeof state.additionalDriver.licenseCategory,
                    })
                  }
                />
              </div>
            </div>
          ) : null}
        </section>

        <KioskHotelCodeField />

        <section className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-lg font-bold text-[#0c2340]">Pickup & return</h3>
          <p className="mt-2 text-sm text-slate-600">
            Kiosk bookings use <strong>office pickup and return</strong>. Delivery needs document
            uploads that are completed at the counter with staff — ask if you need door-to-door
            service.
          </p>
          <p className="mt-3 text-sm font-medium text-[#0c2340]">
            Location: Explore Malta Rentals office, Pietà
          </p>
        </section>
      </div>
    </KioskPanel>
  );
}
