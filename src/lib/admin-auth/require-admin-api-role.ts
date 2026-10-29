import type { AdminAllowedRole } from "@/lib/admin-auth/constants";
import { AdminForbiddenError, AdminUnauthorizedError } from "@/lib/admin-auth/errors";
import type { AdminSessionRecord } from "@/lib/admin-auth/types";

type SessionLoader = () => Promise<AdminSessionRecord | null>;

/**
 * Requires an authenticated admin session whose role is in `allowedRoles`.
 * - No session → AdminUnauthorizedError (401)
 * - Session present but role not allowed → AdminForbiddenError (403)
 *
 * Does not change `requireAdminApi()` (ADMIN + STAFF). Use this only for
 * privileged endpoints such as Stripe refunds.
 *
 * `loadSession` is injectable for unit tests so Prisma need not load.
 */
export async function requireAdminApiRole(
  allowedRoles: readonly AdminAllowedRole[],
  loadSession?: SessionLoader,
): Promise<AdminSessionRecord> {
  const resolveSession =
    loadSession ?? (await import("@/lib/admin-auth/get-admin-session")).getAdminSession;
  const session = await resolveSession();
  if (!session) {
    throw new AdminUnauthorizedError();
  }

  if (!allowedRoles.includes(session.role as AdminAllowedRole)) {
    throw new AdminForbiddenError();
  }

  return session;
}
