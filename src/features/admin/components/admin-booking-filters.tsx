"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { FormEvent, useTransition } from "react";

import type { AdminBookingVehicleOption } from "@/lib/admin/bookings/types";
import type { AdminHotelPartnerOption } from "@/lib/admin/hotel-partners/types";

type AdminBookingFiltersProps = Readonly<{
  locale: string;
  vehicles: AdminBookingVehicleOption[];
  partners: AdminHotelPartnerOption[];
}>;

const MONTH_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"] as const;

export function AdminBookingFilters({ locale, vehicles, partners }: AdminBookingFiltersProps) {
  const t = useTranslations("Admin.bookings.filters");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 6 }, (_, index) => currentYear - index);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const params = new URLSearchParams();

    for (const key of [
      "search",
      "status",
      "vehicleId",
      "hotelPartnerId",
      "hotelCode",
      "month",
      "year",
      "pickupFrom",
      "pickupTo",
      "returnDate",
    ] as const) {
      const value = String(formData.get(key) ?? "").trim();
      if (value) params.set(key, value);
    }

    const pageSize = searchParams.get("pageSize");
    if (pageSize) params.set("pageSize", pageSize);

    startTransition(() => {
      const query = params.toString();
      router.push(`/${locale}/admin/bookings${query ? `?${query}` : ""}`);
    });
  }

  function handleClear() {
    startTransition(() => {
      router.push(`/${locale}/admin/bookings`);
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-3 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm md:grid-cols-4 lg:grid-cols-6"
    >
      <label className="md:col-span-2 lg:col-span-2">
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("search")}
        </span>
        <input
          type="search"
          name="search"
          defaultValue={searchParams.get("search") ?? ""}
          placeholder={t("searchPlaceholder")}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        />
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("status")}
        </span>
        <select
          name="status"
          defaultValue={searchParams.get("status") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        >
          <option value="">{t("allStatuses")}</option>
          <option value="PENDING_PAYMENT">{t("pendingPayment")}</option>
          <option value="CONFIRMED">{t("confirmed")}</option>
          <option value="VEHICLE_HANDED_OVER">{t("vehicleHandedOver")}</option>
          <option value="RETURNED">{t("returned")}</option>
          <option value="COMPLETED">{t("completed")}</option>
          <option value="CANCELLED">{t("cancelled")}</option>
        </select>
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("vehicle")}
        </span>
        <select
          name="vehicleId"
          defaultValue={searchParams.get("vehicleId") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        >
          <option value="">{t("allVehicles")}</option>
          {vehicles.map((vehicle) => (
            <option key={vehicle.id} value={vehicle.id}>
              {vehicle.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("hotel")}
        </span>
        <select
          name="hotelPartnerId"
          defaultValue={searchParams.get("hotelPartnerId") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        >
          <option value="">{t("allHotels")}</option>
          {partners.map((partner) => (
            <option key={partner.id} value={partner.id}>
              {partner.name}
              {!partner.isActive ? ` (${t("inactiveHotel")})` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("hotelCode")}
        </span>
        <input
          type="text"
          name="hotelCode"
          defaultValue={searchParams.get("hotelCode") ?? ""}
          placeholder={t("hotelCodePlaceholder")}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        />
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("month")}
        </span>
        <select
          name="month"
          defaultValue={searchParams.get("month") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        >
          <option value="">{t("allMonths")}</option>
          {MONTH_KEYS.map((month) => (
            <option key={month} value={month}>
              {t(`months.${month}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("year")}
        </span>
        <select
          name="year"
          defaultValue={searchParams.get("year") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        >
          <option value="">{t("allYears")}</option>
          {years.map((year) => (
            <option key={year} value={String(year)}>
              {year}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("pickupFrom")}
        </span>
        <input
          type="date"
          name="pickupFrom"
          defaultValue={searchParams.get("pickupFrom") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        />
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("pickupTo")}
        </span>
        <input
          type="date"
          name="pickupTo"
          defaultValue={searchParams.get("pickupTo") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        />
      </label>
      <label>
        <span className="mb-1 block text-xs font-semibold uppercase tracking-wide text-slate-500">
          {t("returnDate")}
        </span>
        <input
          type="date"
          name="returnDate"
          defaultValue={searchParams.get("returnDate") ?? ""}
          className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15"
        />
      </label>
      <div className="flex items-end gap-2 md:col-span-2">
        <button
          type="submit"
          disabled={isPending}
          className="rounded-xl bg-[#3a7ca5] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2f6688] disabled:opacity-60"
        >
          {isPending ? t("applying") : t("apply")}
        </button>
        <button
          type="button"
          onClick={handleClear}
          className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          {t("clear")}
        </button>
      </div>
    </form>
  );
}
