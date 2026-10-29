export const ADMIN_BOOKINGS_LIST_QUERY_KEYS = [
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
  "page",
  "pageSize",
] as const;

export type AdminBookingsListQueryKey = (typeof ADMIN_BOOKINGS_LIST_QUERY_KEYS)[number];

function appendListParams(
  params: URLSearchParams,
  searchParams: Record<string, string | undefined>,
  overrides?: { page?: number; pageSize?: number },
): void {
  for (const key of ADMIN_BOOKINGS_LIST_QUERY_KEYS) {
    if (key === "page" || key === "pageSize") continue;
    const value = searchParams[key];
    if (value) params.set(key, value);
  }

  const pageSize =
    overrides?.pageSize ?? (searchParams.pageSize ? Number(searchParams.pageSize) : undefined);
  if (pageSize && Number.isFinite(pageSize) && pageSize !== 25) {
    params.set("pageSize", String(pageSize));
  }

  const page = overrides?.page ?? (searchParams.page ? Number(searchParams.page) : 1);
  if (page > 1 && Number.isFinite(page)) {
    params.set("page", String(page));
  }
}

export function buildAdminBookingsListUrl(
  locale: string,
  searchParams: Record<string, string | undefined> = {},
  overrides?: { page?: number; pageSize?: number },
): string {
  const params = new URLSearchParams();
  appendListParams(params, searchParams, overrides);
  const query = params.toString();
  return `/${locale}/admin/bookings${query ? `?${query}` : ""}`;
}

export function buildAdminBookingDetailUrl(
  locale: string,
  bookingId: string,
  searchParams: Record<string, string | undefined> = {},
): string {
  const params = new URLSearchParams();
  appendListParams(params, searchParams);
  const query = params.toString();
  return `/${locale}/admin/bookings/${bookingId}${query ? `?${query}` : ""}`;
}

export function pickAdminBookingsListSearchParams(
  searchParams: Record<string, string | string[] | undefined>,
): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of ADMIN_BOOKINGS_LIST_QUERY_KEYS) {
    const value = searchParams[key];
    if (typeof value === "string" && value) {
      picked[key] = value;
    }
  }
  return picked;
}
