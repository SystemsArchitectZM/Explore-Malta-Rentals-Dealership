import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";

import {
  ADMIN_SESSION_COOKIE,
  buildAdminSessionClearCookie,
  extractLocaleFromPathname,
  isAdminProtectedPath,
} from "@/lib/admin-auth";
import { getAdminSessionByToken } from "@/lib/admin-auth/session-service";
import { routing } from "./i18n/routing";

const intlMiddleware = createMiddleware(routing);

function isPublicAdminApiPath(pathname: string): boolean {
  return pathname === "/api/admin/auth/login" || pathname === "/api/admin/auth/logout";
}

function isProtectedAdminApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/admin/") && !isPublicAdminApiPath(pathname);
}

function clearAdminSessionCookie(response: NextResponse): NextResponse {
  const clearCookie = buildAdminSessionClearCookie();
  response.cookies.set(clearCookie.name, clearCookie.value, {
    httpOnly: clearCookie.httpOnly,
    secure: clearCookie.secure,
    sameSite: clearCookie.sameSite,
    path: clearCookie.path,
    maxAge: clearCookie.maxAge,
  });
  return response;
}

type AdminSessionGate = "valid" | "missing" | "invalid" | "unavailable";

async function readAdminSessionGate(request: NextRequest): Promise<AdminSessionGate> {
  const sessionToken = request.cookies.get(ADMIN_SESSION_COOKIE)?.value?.trim();
  if (!sessionToken) return "missing";

  try {
    const session = await getAdminSessionByToken(sessionToken);
    return session ? "valid" : "invalid";
  } catch (error) {
    console.error("[admin-auth] Could not verify admin session", error);
    return "unavailable";
  }
}

function loginRedirect(request: NextRequest, pathname: string): NextResponse {
  const locale = extractLocaleFromPathname(pathname) ?? routing.defaultLocale;
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = `/${locale}/admin/login`;
  loginUrl.searchParams.set("redirect", pathname);
  return NextResponse.redirect(loginUrl);
}

export default async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // Static shareable HTML (public/design-renewal) — skip locale prefixing
  if (pathname === "/design-renewal" || pathname.startsWith("/design-renewal/")) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/admin/")) {
    if (isProtectedAdminApiPath(pathname)) {
      const gate = await readAdminSessionGate(request);
      if (gate !== "valid") {
        const response = NextResponse.json(
          { success: false, message: "Unauthorized" },
          { status: 401 },
        );
        return gate === "invalid" ? clearAdminSessionCookie(response) : response;
      }
    }
    return NextResponse.next();
  }

  if (isAdminProtectedPath(pathname)) {
    const gate = await readAdminSessionGate(request);
    if (gate !== "valid") {
      const response = loginRedirect(request, pathname);
      return gate === "invalid" ? clearAdminSessionCookie(response) : response;
    }
  }

  return intlMiddleware(request);
}

export const config = {
  matcher: [
    "/((?!api|_next|_vercel|design-renewal|.*\\..*).*)",
    "/api/admin/:path*",
  ],
};
