"use client";

import { Eye } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import {
  buildAdminBookingDetailUrl,
  buildAdminBookingsListUrl,
} from "@/features/admin/lib/admin-bookings-list-url";
import { buildBookingPaymentSummary } from "@/lib/booking/build-booking-payment-summary";
import type { AdminBookingListItem, AdminBookingListResult } from "@/lib/admin/bookings/types";
import { formatMaltaDateTime } from "@/lib/format-malta-datetime";

type AdminBookingTableProps = Readonly<{
  locale: string;
  result: AdminBookingListResult;
  searchParams: Record<string, string | undefined>;
}>;

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

function formatEur(amount: number): string {
  return new Intl.NumberFormat("en-MT", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function statusBadgeClass(status: string): string {
  if (status === "PENDING_PAYMENT") return "bg-amber-50 text-amber-700";
  if (status === "CONFIRMED") return "bg-emerald-50 text-emerald-700";
  if (status === "VEHICLE_HANDED_OVER") return "bg-sky-50 text-sky-700";
  if (status === "RETURNED") return "bg-indigo-50 text-indigo-700";
  if (status === "COMPLETED") return "bg-slate-100 text-slate-700";
  if (status === "CANCELLED") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

function paymentStatusBadgeClass(status: string): string {
  if (status === "PAID") return "bg-emerald-50 text-emerald-700";
  if (status === "REFUNDED") return "bg-blue-50 text-blue-700";
  if (status === "FAILED") return "bg-red-50 text-red-700";
  return "bg-amber-50 text-amber-800";
}

/** Returns page numbers and ellipsis markers for compact navigation. */
function getVisiblePages(current: number, total: number): Array<number | "ellipsis"> {
  if (total <= 7) {
    return Array.from({ length: total }, (_, index) => index + 1);
  }

  const pages = new Set<number>([1, total, current]);
  if (current - 1 > 1) pages.add(current - 1);
  if (current + 1 < total) pages.add(current + 1);
  if (current <= 3) {
    pages.add(2);
    pages.add(3);
    pages.add(4);
  }
  if (current >= total - 2) {
    pages.add(total - 1);
    pages.add(total - 2);
    pages.add(total - 3);
  }

  const sorted = Array.from(pages).sort((a, b) => a - b);
  const result: Array<number | "ellipsis"> = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index]!;
    if (index > 0 && page - sorted[index - 1]! > 1) {
      result.push("ellipsis");
    }
    result.push(page);
  }
  return result;
}

export function AdminBookingTable({ locale, result, searchParams }: AdminBookingTableProps) {
  const t = useTranslations("Admin.bookings");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { items, total, page, totalPages, pageSize } = result;
  const visiblePages = getVisiblePages(page, totalPages);

  function formatPaymentSummaryAmount(booking: AdminBookingListItem): string {
    const summary = buildBookingPaymentSummary({
      subtotal: booking.subtotal,
      depositAmount: booking.depositAmount,
      depositMethod: booking.depositMethod,
      totalDueOnline: booking.totalDueOnline,
      totalDueLater: booking.totalDueLater,
    });

    return formatEur(summary.amountDueAtPickupLater);
  }

  function handlePageSizeChange(nextPageSize: number) {
    startTransition(() => {
      router.push(
        buildAdminBookingsListUrl(locale, searchParams, { page: 1, pageSize: nextPageSize }),
      );
    });
  }

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-2.5 py-2 font-semibold">{t("table.no")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.reference")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.customer")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.vehicle")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.pickup")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.return")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.status")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.paymentStatus")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.amountDueAtPickupLater")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.hotelCode")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.created")}</th>
              <th className="px-2.5 py-2 font-semibold">{t("table.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-2.5 py-8 text-center text-slate-500">
                  {t("table.empty")}
                </td>
              </tr>
            ) : (
              items.map((booking: AdminBookingListItem, index: number) => (
                <tr key={booking.id} className="border-t border-slate-100">
                  <td className="px-2.5 py-2 tabular-nums text-slate-500">
                    {(page - 1) * pageSize + index + 1}
                  </td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-slate-700">
                    {booking.bookingReference}
                  </td>
                  <td className="px-2.5 py-2">
                    <div className="font-medium text-slate-800">{booking.customerFullName}</div>
                    <div className="text-[10px] text-slate-500">{booking.customerEmail}</div>
                    <div className="text-[10px] text-slate-500">{booking.customerPhone}</div>
                  </td>
                  <td className="px-2.5 py-2 text-slate-700">
                    <div>{booking.vehicleName}</div>
                    {booking.vehicleLicensePlate ? (
                      <div className="text-[10px] text-slate-500">{booking.vehicleLicensePlate}</div>
                    ) : null}
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-slate-700">
                    {formatMaltaDateTime(booking.pickupDateTime)}
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-slate-700">
                    {formatMaltaDateTime(booking.returnDateTime)}
                  </td>
                  <td className="px-2.5 py-2">
                    <span
                      className={[
                        "inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                        statusBadgeClass(booking.status),
                      ].join(" ")}
                    >
                      {t(`status.${booking.status}` as "status.CONFIRMED")}
                    </span>
                  </td>
                  <td className="px-2.5 py-2">
                    <span
                      className={[
                        "inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                        paymentStatusBadgeClass(booking.paymentStatus),
                      ].join(" ")}
                    >
                      {t(`paymentStatus.${booking.paymentStatus}` as "paymentStatus.PENDING")}
                    </span>
                  </td>
                  <td className="px-2.5 py-2 font-medium text-slate-800">
                    {formatPaymentSummaryAmount(booking)}
                  </td>
                  <td className="px-2.5 py-2 font-mono text-[11px] text-slate-600">
                    {booking.hotelCode ?? "—"}
                  </td>
                  <td className="px-2.5 py-2 whitespace-nowrap text-slate-700">
                    {formatMaltaDateTime(booking.createdAt)}
                  </td>
                  <td className="px-2.5 py-2">
                    <a
                      href={buildAdminBookingDetailUrl(locale, booking.id, searchParams)}
                      className="inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-[#3a7ca5] hover:bg-[#3a7ca5]/10"
                    >
                      <Eye className="size-3" aria-hidden />
                      {t("table.view")}
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {total > 0 ? (
        <nav
          aria-label={t("pagination.label")}
          className="flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-slate-600">
              {t("pagination.showing", {
                from: (page - 1) * pageSize + 1,
                to: Math.min(page * pageSize, total),
                total,
              })}
            </p>
            <label className="inline-flex items-center gap-2 text-slate-600">
              <span>{t("pagination.rowsPerPage")}</span>
              <select
                value={pageSize}
                disabled={isPending}
                onChange={(event) => handlePageSizeChange(Number(event.target.value))}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-semibold text-slate-700 outline-none focus:border-[#3a7ca5]/40 focus:ring-2 focus:ring-[#3a7ca5]/15 disabled:opacity-60"
              >
                {PAGE_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {page > 1 ? (
              <a
                href={buildAdminBookingsListUrl(locale, searchParams, { page: page - 1, pageSize })}
                className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
              >
                {t("pagination.previous")}
              </a>
            ) : (
              <span className="rounded-lg border border-slate-100 px-3 py-1.5 text-slate-400">
                {t("pagination.previous")}
              </span>
            )}

            {visiblePages.map((item, index) =>
              item === "ellipsis" ? (
                <span
                  key={`ellipsis-${index}`}
                  className="px-1.5 text-slate-400"
                  aria-hidden
                >
                  …
                </span>
              ) : item === page ? (
                <span
                  key={item}
                  aria-current="page"
                  className="min-w-9 rounded-lg border border-[#3a7ca5] bg-[#3a7ca5] px-2.5 py-1.5 text-center font-semibold text-white"
                >
                  {item}
                </span>
              ) : (
                <a
                  key={item}
                  href={buildAdminBookingsListUrl(locale, searchParams, { page: item, pageSize })}
                  aria-label={t("pagination.goToPage", { page: item })}
                  className="min-w-9 rounded-lg border border-slate-200 px-2.5 py-1.5 text-center font-semibold text-slate-700 hover:bg-slate-50"
                >
                  {item}
                </a>
              ),
            )}

            {page < totalPages ? (
              <a
                href={buildAdminBookingsListUrl(locale, searchParams, { page: page + 1, pageSize })}
                className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
              >
                {t("pagination.next")}
              </a>
            ) : (
              <span className="rounded-lg border border-slate-100 px-3 py-1.5 text-slate-400">
                {t("pagination.next")}
              </span>
            )}
          </div>
        </nav>
      ) : null}
    </div>
  );
}
