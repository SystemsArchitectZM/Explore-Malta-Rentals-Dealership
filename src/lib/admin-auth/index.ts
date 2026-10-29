export {
  ADMIN_ALLOWED_ROLES,
  ADMIN_LOGIN_FAILURE_MAX_ATTEMPTS,
  ADMIN_LOGIN_GENERIC_ERROR,
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
} from "@/lib/admin-auth/constants";
export { getClientIpFromRequest } from "@/lib/admin-auth/client-ip";
export {
  cleanupStaleAdminLoginLockouts,
  clearAdminLoginAttempts,
  hashClientIpForRateLimit,
  isAdminLoginLocked,
  normalizeAdminLoginEmail,
  recordAdminLoginFailure,
  resolveAdminLoginIdentity,
} from "@/lib/admin-auth/login-rate-limit";
export { AdminForbiddenError, AdminUnauthorizedError } from "@/lib/admin-auth/errors";
export { getAdminSession } from "@/lib/admin-auth/get-admin-session";
export { hashAdminPassword, verifyAdminPassword } from "@/lib/admin-auth/password";
export { requireAdminApi } from "@/lib/admin-auth/require-admin-api";
export { requireAdminApiRole } from "@/lib/admin-auth/require-admin-api-role";
export { redirectIfAdminAuthenticated, requireAdminPage } from "@/lib/admin-auth/require-admin-page";
export {
  authenticateAdminCredentials,
  createAdminSession,
  getAdminSessionByToken,
  revokeAdminSessionByToken,
  revokeAllAdminSessions,
} from "@/lib/admin-auth/session-service";
export {
  buildAdminSessionClearCookie,
  buildAdminSessionCookie,
  readAdminSessionTokenFromCookies,
} from "@/lib/admin-auth/session-cookie";
export {
  extractLocaleFromPathname,
  isAdminLoginPath,
  isAdminProtectedPath,
  isAdminRoutePath,
} from "@/lib/admin-auth/path-utils";
export type { AdminSessionRecord, AdminSessionUser } from "@/lib/admin-auth/types";
