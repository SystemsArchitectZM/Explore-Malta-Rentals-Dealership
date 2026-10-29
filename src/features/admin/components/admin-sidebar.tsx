"use client";

import {
  BarChart3,
  Building2,
  CalendarCheck,
  Car,
  ChevronRight,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Percent,
  Settings,
  Wallet,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AdminSidebarBrand } from "@/features/admin/components/admin-header";

type AdminNavItem = {
  href: string;
  labelKey:
    | "overview"
    | "vehicles"
    | "bookings"
    | "hotels"
    | "hotelCodes"
    | "payments"
    | "stripePayments"
    | "reports";
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  disabled?: boolean;
};

const MAIN_NAV: AdminNavItem[] = [
  { href: "", labelKey: "overview", icon: LayoutDashboard },
  { href: "/vehicles", labelKey: "vehicles", icon: Car },
  { href: "/bookings", labelKey: "bookings", icon: CalendarCheck },
];

const MANAGEMENT_NAV: AdminNavItem[] = [
  { href: "/hotels", labelKey: "hotels", icon: Building2 },
  { href: "/hotel-codes", labelKey: "hotelCodes", icon: Percent },
  { href: "/hotel-payments", labelKey: "payments", icon: Wallet },
  { href: "/stripe-payments", labelKey: "stripePayments", icon: CreditCard },
  { href: "/reports", labelKey: "reports", icon: BarChart3 },
];

const SIDEBAR_COLLAPSED_KEY = "admin-sidebar-collapsed";

type AdminSidebarProps = Readonly<{
  locale: string;
}>;

function joinPath(locale: string, suffix: string): string {
  return `/${locale}/admin${suffix}`;
}

function navItemIsActive(pathname: string, target: string): boolean {
  if (target.endsWith("/admin")) {
    return pathname === target || pathname === `${target}/`;
  }
  return pathname === target || pathname.startsWith(`${target}/`);
}

function NavSection({
  title,
  items,
  locale,
  pathname,
  collapsed,
}: Readonly<{
  title?: string;
  items: AdminNavItem[];
  locale: string;
  pathname: string;
  collapsed: boolean;
}>) {
  const t = useTranslations("Admin");

  return (
    <div>
      {title ? (
        <p
          className={[
            "mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400",
            collapsed ? "lg:hidden" : "",
          ].join(" ")}
        >
          {title}
        </p>
      ) : null}
      <ul className="space-y-1">
        {items.map(({ href, labelKey, icon: Icon, disabled }) => {
          const target = joinPath(locale, href);
          const active = navItemIsActive(pathname, target);
          const label = t(`nav.${labelKey}`);
          const itemClass = [
            "flex items-center rounded-xl text-sm font-semibold transition-colors",
            collapsed ? "justify-center px-2 py-2.5 lg:px-2" : "gap-3 px-3 py-2.5",
            active
              ? "bg-[#3a7ca5]/12 text-[#3a7ca5]"
              : "text-slate-600 hover:bg-slate-100 hover:text-slate-900",
          ].join(" ");

          if (disabled) {
            return (
              <li key={labelKey}>
                <span
                  aria-disabled="true"
                  className={[
                    itemClass.replace("font-semibold", "font-medium"),
                    "text-slate-400",
                  ].join(" ")}
                  title={t("comingSoon")}
                >
                  <Icon className="size-[18px] shrink-0" aria-hidden />
                  <span className={collapsed ? "lg:sr-only" : ""}>{label}</span>
                </span>
              </li>
            );
          }

          return (
            <li key={labelKey}>
              <a
                href={target}
                aria-current={active ? "page" : undefined}
                title={collapsed ? label : undefined}
                className={itemClass}
              >
                <Icon className="size-[18px] shrink-0" aria-hidden />
                <span className={collapsed ? "lg:sr-only" : ""}>{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function AdminSidebar({ locale }: AdminSidebarProps) {
  const t = useTranslations("Admin");
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
      if (stored === "true") {
        setCollapsed(true);
      }
    } catch {
      // Ignore storage access errors.
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Ignore storage access errors.
    }
  }, [collapsed, hydrated]);

  const toggleCollapsed = () => setCollapsed((value) => !value);

  return (
    <aside
      className={[
        "relative flex h-full w-full flex-col overflow-hidden border-r border-slate-200/80 bg-white transition-[width] duration-200 ease-out motion-reduce:transition-none lg:shrink-0",
        collapsed ? "lg:w-16" : "lg:w-[250px]",
      ].join(" ")}
    >
      <AdminSidebarBrand collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />

      {collapsed ? (
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded="false"
          title={t("sidebarExpand")}
          className="mx-auto mb-2 hidden size-8 cursor-pointer items-center justify-center rounded-full border border-slate-200/80 bg-white text-slate-500 shadow-sm transition duration-200 hover:border-[#3a7ca5]/25 hover:bg-slate-50 hover:text-[#3a7ca5] hover:shadow-md active:scale-95 lg:inline-flex"
        >
          <ChevronRight className="size-4" aria-hidden />
          <span className="sr-only">{t("sidebarExpand")}</span>
        </button>
      ) : null}

      <nav
        aria-label={t("navLabel")}
        className={[
          "flex-1 space-y-6 overflow-y-auto py-2",
          collapsed ? "px-2 lg:px-2" : "px-3",
        ].join(" ")}
      >
        <NavSection items={MAIN_NAV} locale={locale} pathname={pathname} collapsed={collapsed} />
        <NavSection
          title={t("navSectionManagement")}
          items={MANAGEMENT_NAV}
          locale={locale}
          pathname={pathname}
          collapsed={collapsed}
        />
      </nav>

      <div className={["space-y-1 border-t border-slate-100", collapsed ? "p-2 lg:p-2" : "p-3"].join(" ")}>
        <span
          aria-disabled="true"
          title={collapsed ? t("settings") : undefined}
          className={[
            "flex items-center rounded-xl text-sm font-medium text-slate-400",
            collapsed ? "justify-center px-2 py-2.5 lg:px-2" : "gap-3 px-3 py-2.5",
          ].join(" ")}
        >
          <Settings className="size-[18px]" aria-hidden />
          <span className={collapsed ? "lg:sr-only" : ""}>{t("settings")}</span>
        </span>
        <form action={`/api/admin/auth/logout?locale=${encodeURIComponent(locale)}`} method="post">
          <button
            type="submit"
            title={collapsed ? t("signOut") : undefined}
            className={[
              "flex w-full items-center rounded-xl text-sm font-semibold text-slate-600 transition hover:bg-slate-100 hover:text-slate-900",
              collapsed ? "justify-center px-2 py-2.5 lg:px-2" : "gap-3 px-3 py-2.5",
            ].join(" ")}
          >
            <LogOut className="size-[18px]" aria-hidden />
            <span className={collapsed ? "lg:sr-only" : ""}>{t("signOut")}</span>
          </button>
        </form>
      </div>
    </aside>
  );
}
