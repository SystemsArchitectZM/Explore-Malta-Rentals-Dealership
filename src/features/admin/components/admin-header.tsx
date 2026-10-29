"use client";

import { ChevronDown, ChevronLeft, LogOut } from "lucide-react";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { AdminNotificationsBell } from "@/features/admin/components/admin-notifications-bell";
import { LOGO_PATH } from "@/lib/site-brand-copy";
import type { AdminSessionUser } from "@/lib/admin-auth/types";

type AdminHeaderProps = Readonly<{
  locale: string;
  user: AdminSessionUser;
  title?: string;
}>;

function resolveAdminHeaderTitle(pathname: string, t: (key: string) => string): string {
  if (pathname.includes("/admin/vehicles/new")) {
    return t("vehicles.createHeader");
  }
  if (pathname.includes("/admin/vehicles/") && pathname.endsWith("/edit")) {
    return t("vehicles.editHeader");
  }
  if (/\/admin\/vehicles\/[^/]+$/.test(pathname) && !pathname.endsWith("/new")) {
    return t("vehicles.detailsHeader");
  }
  if (pathname.includes("/admin/vehicles")) {
    return t("vehicles.header");
  }
  if (/\/admin\/bookings\/[^/]+$/.test(pathname)) {
    return t("bookings.detailsHeader");
  }
  if (pathname.includes("/admin/bookings")) {
    return t("bookings.header");
  }
  if (pathname.includes("/admin/hotels/new")) {
    return t("hotels.createHeader");
  }
  if (pathname.includes("/admin/hotels/") && pathname.endsWith("/edit")) {
    return t("hotels.editHeader");
  }
  if (pathname.includes("/admin/hotels")) {
    return t("hotels.header");
  }
  if (pathname.includes("/admin/hotel-codes/new")) {
    return t("hotelCodes.createHeader");
  }
  if (pathname.includes("/admin/hotel-codes/") && pathname.endsWith("/edit")) {
    return t("hotelCodes.editHeader");
  }
  if (pathname.includes("/admin/hotel-codes")) {
    return t("hotelCodes.header");
  }
  if (pathname.includes("/admin/hotel-payments")) {
    return t("hotelPayments.header");
  }
  if (pathname.includes("/admin/stripe-payments")) {
    return t("stripePayments.header");
  }
  if (pathname.includes("/admin/reports")) {
    return t("reports.header");
  }
  return t("dashboardOverviewTitle");
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "A";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

export function AdminHeader({ locale, user, title }: AdminHeaderProps) {
  const t = useTranslations("Admin");
  const pathname = usePathname();
  const resolvedTitle = title ?? resolveAdminHeaderTitle(pathname, t);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, []);

  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b border-slate-200/80 bg-[#f4f7fb]/95 px-4 py-4 backdrop-blur-sm sm:px-6 lg:px-8">
      <h1 className="text-xl font-bold tracking-[-0.03em] text-slate-950 sm:text-2xl">{resolvedTitle}</h1>

      <div className="flex items-center gap-2 sm:gap-3">
        <AdminNotificationsBell locale={locale} />

        <div ref={menuRef} className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className={[
              "group flex cursor-pointer items-center gap-2 rounded-full border bg-white py-1 pl-1 pr-2.5 shadow-sm transition duration-200 hover:bg-slate-50 hover:shadow-md active:scale-[0.98]",
              menuOpen
                ? "border-[#3a7ca5]/40 bg-slate-50 shadow-md"
                : "border-slate-200 hover:border-[#3a7ca5]/30",
            ].join(" ")}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <span className="inline-flex size-9 items-center justify-center rounded-full bg-[#3a7ca5] text-sm font-bold text-white transition duration-200 group-hover:bg-[#2f6688]">
              {initialsFromName(user.name)}
            </span>
            <ChevronDown
              className={[
                "size-4 text-slate-500 transition duration-200",
                menuOpen ? "rotate-180 text-[#3a7ca5]" : "group-hover:text-[#3a7ca5]",
              ].join(" ")}
              aria-hidden
            />
          </button>

          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 mt-2 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-lg"
            >
              <div className="border-b border-slate-100 px-4 py-3">
                <p className="truncate text-sm font-semibold text-slate-900">{user.name}</p>
                <p className="truncate text-xs text-slate-500">{user.email}</p>
                <p className="mt-1 text-[11px] font-medium uppercase tracking-wide text-[#3a7ca5]">
                  {user.role}
                </p>
              </div>
              <form action={`/api/admin/auth/logout?locale=${encodeURIComponent(locale)}`} method="post">
                <button
                  type="submit"
                  role="menuitem"
                  className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-sm font-medium text-slate-700 transition duration-200 hover:bg-slate-50 hover:text-[#3a7ca5]"
                >
                  <LogOut className="size-4" aria-hidden />
                  {t("signOut")}
                </button>
              </form>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

type AdminSidebarBrandProps = Readonly<{
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}>;

export function AdminSidebarBrand({ collapsed = false, onToggleCollapsed }: AdminSidebarBrandProps) {
  const t = useTranslations("Admin");

  return (
    <div
      className={[
        "flex items-center py-5",
        collapsed ? "justify-center px-2 lg:px-2" : "justify-between gap-2 px-5",
      ].join(" ")}
    >
      <div className={["flex min-w-0 items-center", collapsed ? "justify-center" : "gap-3"].join(" ")}>
        <Image
          src={LOGO_PATH}
          alt={t("loginLogoAlt")}
          width={36}
          height={36}
          className="size-9 shrink-0 object-contain"
        />
        <div className={["min-w-0", collapsed ? "sr-only lg:sr-only" : ""].join(" ")}>
          <p className="truncate text-sm font-bold text-slate-900">{t("brandShort")}</p>
          <p className="truncate text-xs text-slate-500">{t("panelLabel")}</p>
        </div>
      </div>

      {onToggleCollapsed && !collapsed ? (
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded
          title={t("sidebarCollapse")}
          className="hidden size-8 shrink-0 cursor-pointer items-center justify-center rounded-full border border-slate-200/80 bg-white text-slate-500 shadow-sm transition duration-200 hover:border-[#3a7ca5]/25 hover:bg-slate-50 hover:text-[#3a7ca5] hover:shadow-md active:scale-95 lg:inline-flex"
        >
          <ChevronLeft className="size-4" aria-hidden />
          <span className="sr-only">{t("sidebarCollapse")}</span>
        </button>
      ) : null}
    </div>
  );
}
