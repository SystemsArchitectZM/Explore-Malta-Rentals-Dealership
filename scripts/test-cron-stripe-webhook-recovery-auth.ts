/**
 * Authorization + failure-shape tests for GET /api/cron/stripe-webhook-recovery.
 * Handler-level with injected deps: no DB, no Stripe, no live Vercel.
 *
 *   npm run test:cron-stripe-webhook-recovery-auth
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  CRON_WEBHOOK_RECOVERY_ACTOR,
  handleCronStripeWebhookRecovery,
  type CronStripeWebhookRecoveryDeps,
} from "../src/app/api/cron/stripe-webhook-recovery/handle-cron-stripe-webhook-recovery";
import { CronUnauthorizedError } from "../src/lib/cron/assert-cron-authorization";
import {
  WebhookRecoveryLookupError,
  type WebhookRecoveryResult,
} from "../src/lib/stripe/webhook-recovery";

const emptyResult: WebhookRecoveryResult = {
  scanned: 0,
  attempted: 0,
  recovered: 0,
  alreadyProcessed: 0,
  skippedInFlight: 0,
  skippedNotEligible: 0,
  excludedEventType: 0,
  stillRetryable: 0,
  deadLettered: 0,
  alreadyDeadLettered: 0,
  errors: 0,
  hasMore: false,
  stoppedEarly: false,
  events: [],
};

function get() {
  return new Request("http://localhost/api/cron/stripe-webhook-recovery", { method: "GET" });
}

function makeDeps(authorize: CronStripeWebhookRecoveryDeps["authorize"]) {
  const state = { runCalls: [] as Array<{ input: unknown; actor: string }> };
  const deps: CronStripeWebhookRecoveryDeps = {
    authorize,
    runRecovery: async (input, actor) => {
      state.runCalls.push({ input, actor });
      return emptyResult;
    },
  };
  return { deps, state };
}

async function testUnauthorizedDoesNotRunJob() {
  const { deps, state } = makeDeps(() => {
    throw new CronUnauthorizedError();
  });
  const response = await handleCronStripeWebhookRecovery(get(), deps);
  assert.equal(response.status, 401);
  assert.equal(((await response.json()) as { code: string }).code, "UNAUTHORIZED");
  assert.equal(state.runCalls.length, 0, "recovery must not run before auth");
}

async function testValidAuthInvokesProductionDefaults() {
  const { deps, state } = makeDeps(() => undefined);
  const response = await handleCronStripeWebhookRecovery(get(), deps);
  assert.equal(response.status, 200);
  const json = (await response.json()) as { success: boolean; result: WebhookRecoveryResult };
  assert.equal(json.success, true);
  assert.deepEqual(state.runCalls, [{ input: {}, actor: CRON_WEBHOOK_RECOVERY_ACTOR }]);
}

async function testPassErrorsAreNotSuccess() {
  const { deps, state } = makeDeps(() => undefined);
  deps.runRecovery = async (input, actor) => {
    state.runCalls.push({ input, actor });
    return { ...emptyResult, errors: 1, scanned: 1, attempted: 1 };
  };
  const response = await handleCronStripeWebhookRecovery(get(), deps);
  assert.equal(response.status, 500);
  const json = (await response.json()) as { success: boolean; code: string };
  assert.equal(json.success, false);
  assert.equal(json.code, "RECOVERY_PASS_ERRORS");
  assert.equal(state.runCalls.length, 1);
}

async function testLookupAndInternalFailures() {
  const lookup = makeDeps(() => undefined);
  lookup.deps.runRecovery = async () => {
    throw new WebhookRecoveryLookupError();
  };
  const r1 = await handleCronStripeWebhookRecovery(get(), lookup.deps);
  assert.equal(r1.status, 503);
  assert.equal(((await r1.json()) as { code: string }).code, "RECOVERY_LOOKUP_FAILED");

  const boom = makeDeps(() => undefined);
  boom.deps.runRecovery = async () => {
    throw new Error("SELECT password=hunter2");
  };
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const r2 = await handleCronStripeWebhookRecovery(get(), boom.deps);
    assert.equal(r2.status, 500);
    const text = JSON.stringify(await r2.json());
    assert.equal(JSON.parse(text).code, "INTERNAL_ERROR");
    assert.equal(JSON.parse(text).success, false);
    assert.doesNotMatch(text, /SELECT|password|hunter2/);
  } finally {
    console.error = quiet;
  }
}

/** STATIC — cron route uses CRON auth + production recovery; ADMIN route untouched. */
function testRouteWiringAndAdminUnchanged() {
  const cronRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/cron/stripe-webhook-recovery/route.ts"),
    "utf8",
  );
  assert.match(cronRoute, /export async function GET/);
  assert.doesNotMatch(cronRoute, /export async function POST/);
  assert.match(cronRoute, /assertCronAuthorization/);
  assert.match(cronRoute, /runProductionWebhookRecovery/);
  assert.doesNotMatch(cronRoute, /requireAdminApiRole/);
  assert.doesNotMatch(cronRoute, /export const maxDuration/);

  const adminRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/admin/webhooks/recovery/route.ts"),
    "utf8",
  );
  assert.match(adminRoute, /requireAdminApiRole\(\["ADMIN"\]\)/);
  assert.doesNotMatch(adminRoute, /assertCronAuthorization|CRON_SECRET/);

  const vercel = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "vercel.json"), "utf8"),
  ) as { crons: Array<{ path: string; schedule: string }> };
  const recovery = vercel.crons.find((c) => c.path === "/api/cron/stripe-webhook-recovery");
  assert.ok(recovery);
  assert.equal(recovery!.schedule, "0 3 * * *", "Hobby: once daily UTC");
}

async function main() {
  const tests: Array<[string, () => void | Promise<void>]> = [
    ["MOCK unauthorized does not run recovery", testUnauthorizedDoesNotRunJob],
    ["MOCK valid auth invokes defaults + cron actor", testValidAuthInvokesProductionDefaults],
    ["MOCK recovery errors are non-success", testPassErrorsAreNotSuccess],
    ["MOCK lookup/internal failures no false success", testLookupAndInternalFailures],
    ["STATIC cron wiring; ADMIN auth unchanged", testRouteWiringAndAdminUnchanged],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} cron stripe-webhook-recovery auth tests passed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
