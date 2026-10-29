import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";

import { AdminBookingFilters } from "@/features/admin/components/admin-booking-filters";
import { AdminBookingTable } from "@/features/admin/components/admin-booking-table";
import { listAdminBookings, listAdminBookingVehicleOptions } from "@/lib/admin/bookings";
import { listAdminHotelPartnerOptions } from "@/lib/admin/hotel-partners";
import type { BookingStatus } from "@/generated/prisma/index";

export const dynamic = "force-dynamic";

type AdminBookingsPageProps = Readonly<{
  params: Promise<{ locale: string }>;
  searchParams: Promise<{
    search?: string;
    status?: string;
    vehicleId?: string;
    hotelPartnerId?: string;
    hotelCode?: string;
    month?: string;
    year?: string;
    pickupFrom?: string;
    pickupTo?: string;
    returnDate?: string;
    page?: string;
    pageSize?: string;
  }>;
}>;

function FiltersFallback() {
  return <div className="h-28 animate-pulse rounded-2xl bg-white/70" aria-hidden />;
}

const ALLOWED_PAGE_SIZES = new Set([10, 25, 50, 100]);

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parsePageSize(value: string | undefined): number | undefined {
  const parsed = parseOptionalInt(value);
  if (parsed === undefined || !ALLOWED_PAGE_SIZES.has(parsed)) return undefined;
  return parsed;
}

function parseBookingStatus(value: string | undefined): BookingStatus | undefined {
  if (
    value === "PENDING_PAYMENT" ||
    value === "CONFIRMED" ||
    value === "VEHICLE_HANDED_OVER" ||
    value === "RETURNED" ||
    value === "COMPLETED" ||
    value === "CANCELLED"
  ) {
    return value;
  }
  return undefined;
}

export default async function AdminBookingsPage({ params, searchParams }: AdminBookingsPageProps) {
  const { locale } = await params;
  const query = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "Admin.bookings" });

  const pageSize = parsePageSize(query.pageSize);

  const filters = {
    search: query.search,
    status: parseBookingStatus(query.status),
    vehicleId: query.vehicleId,
    hotelPartnerId: query.hotelPartnerId,
    hotelCode: query.hotelCode,
    month: parseOptionalInt(query.month),
    year: parseOptionalInt(query.year),
    pickupFrom: query.pickupFrom,
    pickupTo: query.pickupTo,
    returnDate: query.returnDate,
    page: parseOptionalInt(query.page) ?? 1,
    pageSize,
  };

  const [result, vehicles, partners] = await Promise.all([
    listAdminBookings(filters),
    listAdminBookingVehicleOptions(),
    listAdminHotelPartnerOptions(),
  ]);

  const searchParamsRecord: Record<string, string | undefined> = {
    search: query.search,
    status: query.status,
    vehicleId: query.vehicleId,
    hotelPartnerId: query.hotelPartnerId,
    hotelCode: query.hotelCode,
    month: query.month,
    year: query.year,
    pickupFrom: query.pickupFrom,
    pickupTo: query.pickupTo,
    returnDate: query.returnDate,
    page: query.page,
    pageSize: pageSize ? String(pageSize) : undefined,
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-slate-200/80 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-950">{t("pageTitle")}</h2>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-slate-600">{t("pageDescription")}</p>
      </section>

      <Suspense fallback={<FiltersFallback />}>
        <AdminBookingFilters locale={locale} vehicles={vehicles} partners={partners} />
      </Suspense>

      <p className="text-sm font-medium text-slate-600">{t("resultsCount", { count: result.total })}</p>
      <AdminBookingTable locale={locale} result={result} searchParams={searchParamsRecord} />
    </div>
  );
}
