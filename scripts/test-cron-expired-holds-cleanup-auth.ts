/**
 * Authorization + failure-shape tests for GET /api/cron/expired-holds-cleanup.
 * Handler-level with injected deps: no DB, no Neon, no live Vercel.
 *
 *   npm run test:cron-expired-holds-cleanup-auth
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CRON_EXPIRED_HOLDS_ACTOR,
  handleCronExpiredHoldsCleanup,
  type CronExpiredHoldsCleanupDeps,
} from "../src/app/api/cron/expired-holds-cleanup/handle-cron-expired-holds-cleanup";
import type { CleanupUnpaidPendingPaymentBookingsResult } from "../src/lib/booking/cleanupUnpaidPendingPaymentBookings";
import { CronUnauthorizedError } from "../src/lib/cron/assert-cron-authorization";
import type { CleanupExpiredHoldsResult } from "../src/lib/reservation-holds/cleanupExpiredHolds";

const emptyHolds: CleanupExpiredHoldsResult = {
  expiredHoldsFound: 0,
  holdsExpired: 0,
  occupancyRowsReleased: 0,
  orphanOccupancyReleased: 0,
  errors: [],
};

const emptyUnpaid: CleanupUnpaidPendingPaymentBookingsResult = {
  candidatesFound: 0,
  bookingsReleased: 0,
  errors: [],
};

function get() {
  return new Request("http://localhost/api/cron/expired-holds-cleanup", { method: "GET" });
}

function makeDeps(authorize: CronExpiredHoldsCleanupDeps["authorize"]) {
  const state = { holdCalls: 0, unpaidCalls: 0 };
  const deps: CronExpiredHoldsCleanupDeps = {
    authorize,
    cleanupExpiredHolds: async () => {
      state.holdCalls += 1;
      return emptyHolds;
    },
    cleanupUnpaidPendingPaymentBookings: async () => {
      state.unpaidCalls += 1;
      return emptyUnpaid;
    },
  };
  return { deps, state };
}

async function testUnauthorizedDoesNotRunCleanup() {
  const { deps, state } = makeDeps(() => {
    throw new CronUnauthorizedError();
  });
  const response = await handleCronExpiredHoldsCleanup(get(), deps);
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { code: string }).code, "UNAUTHORIZED");
  assert.equal(state.holdCalls, 0);
  assert.equal(state.unpaidCalls, 0);
}

async function testValidAuthRunsBothCleanups() {
  const { deps, state } = makeDeps(() => undefined);
  const response = await handleCronExpiredHoldsCleanup(get(), deps);
  assert.equal(response.status, 200);
  const json = (await response.json()) as { success: boolean; actor: string };
  assert.equal(json.success, true);
  assert.equal(json.actor, CRON_EXPIRED_HOLDS_ACTOR);
  assert.equal(state.holdCalls, 1);
  assert.equal(state.unpaidCalls, 1);
}

async function testCleanupItemErrorsAreNonSuccess() {
  const { deps, state } = makeDeps(() => undefined);
  deps.cleanupExpiredHolds = async () => {
    state.holdCalls += 1;
    return {
      ...emptyHolds,
      expiredHoldsFound: 1,
      errors: [{ holdId: "h1", message: "boom" }],
    };
  };
  const response = await handleCronExpiredHoldsCleanup(get(), deps);
  assert.equal(response.status, 500);
  const json = (await response.json()) as { success: boolean; code: string };
  assert.equal(json.success, false);
  assert.equal(json.code, "CLEANUP_ERRORS");
  assert.equal(state.holdCalls, 1);
  assert.equal(state.unpaidCalls, 1, "unpaid still runs after hold errors; both reported");
}

async function testThrownCleanupIsNotSuccess() {
  const { deps, state } = makeDeps(() => undefined);
  deps.cleanupExpiredHolds = async () => {
    state.holdCalls += 1;
    throw new Error("connection refused secret=xyz");
  };
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const response = await handleCronExpiredHoldsCleanup(get(), deps);
    assert.equal(response.status, 500);
    const text = JSON.stringify(await response.json());
    assert.equal(JSON.parse(text).success, false);
    assert.equal(JSON.parse(text).code, "INTERNAL_ERROR");
    assert.doesNotMatch(text, /connection refused|secret=xyz/);
    assert.equal(state.unpaidCalls, 0, "unpaid not reached after hold throw");
  } finally {
    console.error = quiet;
  }
}

function testRouteWiringAndHobbySchedule() {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/cron/expired-holds-cleanup/route.ts"),
    "utf8",
  );
  assert.match(route, /export async function GET/);
  assert.doesNotMatch(route, /export async function POST/);
  assert.match(route, /assertCronAuthorization/);
  assert.match(route, /cleanupExpiredHolds/);
  assert.match(route, /cleanupUnpaidPendingPaymentBookings/);
  assert.doesNotMatch(route, /requireAdminApiRole|runProductionWebhookRecovery/);
  assert.doesNotMatch(route, /export const maxDuration/);

  const vercel = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"),
  ) as { crons: Array<{ path: string; schedule: string }> };
  assert.equal(vercel.crons.length, 3, "recovery + cleanup + review-requests");
  const cleanup = vercel.crons.find((c) => c.path === "/api/cron/expired-holds-cleanup");
  assert.ok(cleanup);
  assert.equal(cleanup!.schedule, "0 4 * * *", "Hobby: once daily UTC");
  const review = vercel.crons.find((c) => c.path === "/api/cron/review-requests");
  assert.ok(review);
  assert.equal(review!.schedule, "0 5 * * *", "Hobby: daily (not every-minute)");
  for (const c of vercel.crons) {
    // Hobby forbids more-than-daily expressions; these must be pure daily forms.
    assert.match(c.schedule, /^0 \d{1,2} \* \* \*$/);
  }
}

async function main() {
  const tests: Array<[string, () => void | Promise<void>]> = [
    ["MOCK unauthorized does not run cleanup", testUnauthorizedDoesNotRunCleanup],
    ["MOCK valid auth runs both cleanup services", testValidAuthRunsBothCleanups],
    ["MOCK item errors are non-success", testCleanupItemErrorsAreNonSuccess],
    ["MOCK thrown cleanup is not false success", testThrownCleanupIsNotSuccess],
    ["STATIC route wiring + Hobby daily schedules", testRouteWiringAndHobbySchedule],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} cron expired-holds-cleanup auth tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
