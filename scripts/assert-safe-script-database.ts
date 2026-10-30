/**
 * Database-writing scripts must not hit the shared/live database by accident.
 * A killed test used to leave bookings and vehicles visible in admin.
 *
 * Local hosts run as usual. Anything else stops unless ALLOW_REMOTE_TEST_DB=1.
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function assertSafeScriptDatabase(scriptName: string): void {
  if (process.env.ALLOW_REMOTE_TEST_DB === "1") return;

  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(`${scriptName}: DATABASE_URL is not set`);
  }

  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    throw new Error(`${scriptName}: DATABASE_URL is not a valid URL`);
  }

  if (LOCAL_HOSTS.has(host)) return;

  throw new Error(
    `${scriptName} refused to run against non-local database host "${host}". ` +
      "These scripts insert and delete real bookings, vehicles, and users. " +
      "Point DATABASE_URL at a local database, or set ALLOW_REMOTE_TEST_DB=1 to override.",
  );
}
