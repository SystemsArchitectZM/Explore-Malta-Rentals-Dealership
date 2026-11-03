"use client";

import { useMemo } from "react";
import { format, subYears } from "date-fns";
import { UserRound } from "lucide-react";
import { KioskDatePicker } from "@/features/kiosk/components/kiosk-date-picker";
import { KioskPanel } from "@/features/kiosk/components/kiosk-panel";
import { KioskSelect } from "@/features/kiosk/components/kiosk-select";
import { useKioskBooking } from "@/features/kiosk/context/kiosk-booking-context";
import {
  getAllowedLicenseCategories,
  getLicenseCategoryHint,
} from "@/features/booking-flow/lib/license-categories";

const fieldClass =
  "mt-2 min-h-12 w-full rounded-xl border border-slate-300 bg-white px-4 text-base focus:border-[#f9900f] focus:outline-none focus:ring-2 focus:ring-[#f9900f]/30";

const todayIso = () => format(new Date(), "yyyy-MM-dd");
const dobMinIso = () => format(subYears(new Date(), 100), "yyyy-MM-dd");

export function CustomerStep() {
  const { state, updateSection } = useKioskBooking();
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
      title="Your details"
      subtitle="We will verify documents at the counter for office pickup."
      icon={<UserRound className="h-6 w-6" aria-hidden />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="text-sm font-medium text-slate-700">Full name</span>
          <input
            className={fieldClass}
            value={state.customer.fullName}
            onChange={(e) => updateSection("customer", { fullName: e.target.value })}
          />
        </label>
        <label>
          <span className="text-sm font-medium text-slate-700">Phone</span>
          <input
            className={fieldClass}
            value={state.customer.phone}
            onChange={(e) => updateSection("customer", { phone: e.target.value })}
          />
        </label>
        <label>
          <span className="text-sm font-medium text-slate-700">Email</span>
          <input
            type="email"
            className={fieldClass}
            value={state.customer.email}
            onChange={(e) => updateSection("customer", { email: e.target.value })}
          />
        </label>
        <label>
          <span className="text-sm font-medium text-slate-700">Nationality</span>
          <input
            className={fieldClass}
            value={state.customer.nationality}
            onChange={(e) => updateSection("customer", { nationality: e.target.value })}
          />
        </label>
        <KioskDatePicker
          id="kiosk-customer-dob"
          label="Date of birth"
          value={state.customer.dateOfBirth}
          min={dobMinIso()}
          max={todayIso()}
          placeholder="Select date of birth"
          yearDropdown
          size="default"
          onChange={(next) => updateSection("customer", { dateOfBirth: next })}
        />
        <div className="sm:col-span-2">
          <KioskSelect
            id="kiosk-customer-license"
            label="Driving license category"
            value={state.customer.licenseCategory}
            options={licenseOptions}
            placeholder="Select category"
            hint={getLicenseCategoryHint(state.rental.vehicleType, state.rental.engineCc)}
            onChange={(next) =>
              updateSection("customer", {
                licenseCategory: next as typeof state.customer.licenseCategory,
              })
            }
          />
        </div>
      </div>

      <div className="mt-6 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-semibold text-[#0c2340]">At pickup you will present:</p>
        <label className="flex min-h-12 items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 accent-[#f9900f]"
            checked={state.customer.licenseConfirmationCheckbox}
            onChange={(e) =>
              updateSection("customer", { licenseConfirmationCheckbox: e.target.checked })
            }
          />
          <span className="text-sm">Valid driving license (physical document)</span>
        </label>
        <label className="flex min-h-12 items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 h-5 w-5 accent-[#f9900f]"
            checked={state.customer.idConfirmationCheckbox}
            onChange={(e) => updateSection("customer", { idConfirmationCheckbox: e.target.checked })}
          />
          <span className="text-sm">Passport or national ID</span>
        </label>
        {state.addons.additionalDriver ? (
          <label className="flex min-h-12 items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-5 w-5 accent-[#f9900f]"
              checked={state.additionalDriver.officeIdConfirmed}
              onChange={(e) =>
                updateSection("additionalDriver", { officeIdConfirmed: e.target.checked })
              }
            />
            <span className="text-sm">Additional driver will present ID at pickup</span>
          </label>
        ) : null}
      </div>

      <label className="mt-6 block">
        <span className="text-sm font-medium text-slate-700">Special notes (optional)</span>
        <textarea
          className={`${fieldClass} min-h-24`}
          value={state.customer.specialNotes}
          onChange={(e) => updateSection("customer", { specialNotes: e.target.value })}
        />
      </label>
    </KioskPanel>
  );
}
