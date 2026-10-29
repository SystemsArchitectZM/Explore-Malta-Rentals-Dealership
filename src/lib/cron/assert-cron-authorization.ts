/**
 * Server-only authorization for Vercel Cron route handlers.
 *
 * Vercel invokes cron paths with GET and, when `CRON_SECRET` is configured in the
 * project environment, sends `Authorization: Bearer <CRON_SECRET>`. This helper
 * fails closed if the secret is missing/empty or the header does not match.
 *
 * Never logs the secret or Authorization header. Does not use ADMIN sessions.
 */

import { timingSafeEqual } from "node:crypto";

export class CronUnauthorizedError extends Error {
  readonly code = "UNAUTHORIZED" as const;

  constructor(message = "Unauthorized") {
    super(message);
    this.name = "CronUnauthorizedError";
  }
}

function readCronSecret(env: NodeJS.ProcessEnv): string | null {
  const raw = env.CRON_SECRET;
  if (raw == null) return null;
  // Reject blank / whitespace-only: fail closed rather than accepting an empty secret.
  if (typeof raw !== "string" || raw.trim() === "") return null;
  // Malformed: embedded newlines or NULs are not valid secret material for Bearer compare.
  if (/[\r\n\0]/.test(raw)) return null;
  return raw;
}

function bearerTokenEquals(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, providedBuf);
}

/**
 * Throws CronUnauthorizedError unless `Authorization` is exactly
 * `Bearer ${CRON_SECRET}` with a configured, non-empty secret.
 */
export function assertCronAuthorization(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const secret = readCronSecret(env);
  if (secret == null) {
    throw new CronUnauthorizedError();
  }

  const header = request.headers.get("authorization");
  if (header == null || !header.startsWith("Bearer ")) {
    throw new CronUnauthorizedError();
  }

  const token = header.slice("Bearer ".length);
  if (!bearerTokenEquals(secret, token)) {
    throw new CronUnauthorizedError();
  }
}
