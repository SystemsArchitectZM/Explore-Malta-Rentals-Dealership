import "dotenv/config";
import assert from "node:assert/strict";

import {
  ADMIN_LOGIN_FAILURE_MAX_ATTEMPTS,
  ADMIN_LOGIN_GENERIC_ERROR,
  hashAdminPassword,
  hashClientIpForRateLimit,
  isAdminLoginLocked,
  normalizeAdminLoginEmail,
  recordAdminLoginFailure,
  clearAdminLoginAttempts,
  verifyAdminPassword,
} from "../src/lib/admin-auth";
import {
  extractLocaleFromPathname,
  isAdminLoginPath,
  isAdminProtectedPath,
  isAdminRoutePath,
} from "../src/lib/admin-auth/path-utils";
import { prisma } from "../src/lib/prisma";
import { assertSafeScriptDatabase } from "./assert-safe-script-database";

const testSuffix = String(Date.now()).slice(-8);
const testEmail = `rate-limit-${testSuffix}@test.local`;
const testIpHash = hashClientIpForRateLimit("127.0.0.1");

async function cleanupRateLimitRows() {
  await prisma.adminLoginLockout
    .deleteMany({
      where: {
        emailNormalized: normalizeAdminLoginEmail(testEmail),
        ipAddressHash: testIpHash,
      },
    })
    .catch(() => undefined);
}

async function runPasswordAndPathChecks() {
  const hash = await hashAdminPassword("test-password-123");
  assert.equal(await verifyAdminPassword("test-password-123", hash), true);
  assert.equal(await verifyAdminPassword("wrong-password", hash), false);

  assert.equal(isAdminRoutePath("/en/admin"), true);
  assert.equal(isAdminLoginPath("/en/admin/login"), true);
  assert.equal(isAdminProtectedPath("/en/admin/login"), false);
  assert.equal(isAdminProtectedPath("/en/admin"), true);
  assert.equal(isAdminProtectedPath("/en/admin/bookings"), true);
  assert.equal(isAdminRoutePath("/booking"), false);
  assert.equal(extractLocaleFromPathname("/mt/admin"), "mt");
}

async function runRateLimitChecks() {
  assertSafeScriptDatabase("test-admin-auth");
  const emailNormalized = normalizeAdminLoginEmail(testEmail);

  await cleanupRateLimitRows();

  assert.equal(ADMIN_LOGIN_GENERIC_ERROR.includes("Invalid credentials"), true);
  assert.equal(ADMIN_LOGIN_GENERIC_ERROR.includes("email"), false);
  assert.equal(ADMIN_LOGIN_GENERIC_ERROR.includes("password"), false);

  for (let attempt = 1; attempt < ADMIN_LOGIN_FAILURE_MAX_ATTEMPTS; attempt += 1) {
    await recordAdminLoginFailure(emailNormalized, testIpHash);
    assert.equal(await isAdminLoginLocked(emailNormalized, testIpHash), false);
  }

  await recordAdminLoginFailure(emailNormalized, testIpHash);
  assert.equal(await isAdminLoginLocked(emailNormalized, testIpHash), true);

  await recordAdminLoginFailure(emailNormalized, testIpHash);
  assert.equal(await isAdminLoginLocked(emailNormalized, testIpHash), true);

  await prisma.adminLoginLockout.updateMany({
    where: {
      emailNormalized,
      ipAddressHash: testIpHash,
    },
    data: {
      lockedUntil: new Date(Date.now() - 60_000),
    },
  });
  assert.equal(await isAdminLoginLocked(emailNormalized, testIpHash), false);

  await clearAdminLoginAttempts(emailNormalized, testIpHash);
  const remaining = await prisma.adminLoginLockout.count({
    where: {
      emailNormalized,
      ipAddressHash: testIpHash,
    },
  });
  assert.equal(remaining, 0);
}

async function run() {
  await runPasswordAndPathChecks();
  await runRateLimitChecks();
  await cleanupRateLimitRows();

  console.log("Admin auth verification checks passed.");
}

run().catch(async (error) => {
  await cleanupRateLimitRows().catch(() => undefined);
  console.error(error);
  process.exit(1);
});
