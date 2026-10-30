import { routing } from "@/i18n/routing";

const localePattern = routing.locales.join("|");

const ADMIN_ROOT_PATTERN = new RegExp(`^/(?:${localePattern})/admin/?$`);
const ADMIN_NESTED_PATTERN = new RegExp(`^/(?:${localePattern})/admin/(.+)$`);
const ADMIN_LOGIN_PATTERN = new RegExp(`^/(?:${localePattern})/admin/login/?$`);

export function isAdminRoutePath(pathname: string): boolean {
  return ADMIN_ROOT_PATTERN.test(pathname) || ADMIN_NESTED_PATTERN.test(pathname);
}

export function isAdminLoginPath(pathname: string): boolean {
  return ADMIN_LOGIN_PATTERN.test(pathname);
}

export function isAdminProtectedPath(pathname: string): boolean {
  return isAdminRoutePath(pathname) && !isAdminLoginPath(pathname);
}

/** Post-login navigation may only stay inside this locale's admin area. */
export function safeAdminRedirectPath(
  locale: string,
  candidate: string | null | undefined,
): string {
  const fallback = `/${locale}/admin`;
  if (!candidate) return fallback;

  const trimmed = candidate.trim();
  if (
    !trimmed.startsWith("/") ||
    trimmed.startsWith("//") ||
    trimmed.includes("\\") ||
    trimmed.includes("://")
  ) {
    return fallback;
  }

  const withoutHash = trimmed.split("#", 1)[0] ?? trimmed;
  const queryIndex = withoutHash.indexOf("?");
  const pathname = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const search = queryIndex === -1 ? "" : withoutHash.slice(queryIndex);

  if (!isAdminProtectedPath(pathname) || !pathname.startsWith(`/${locale}/`)) {
    return fallback;
  }
  if (/[\r\n]/.test(search)) return fallback;

  return `${pathname}${search}`;
}

export function extractLocaleFromPathname(pathname: string): string | null {
  const match = pathname.match(new RegExp(`^/(?:${localePattern})(?:/|$)`));
  if (!match) {
    return null;
  }
  const segment = pathname.split("/").filter(Boolean)[0];
  return segment && routing.locales.includes(segment as (typeof routing.locales)[number])
    ? segment
    : null;
}
