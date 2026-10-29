/**
 * Authorization + input validation tests for /api/admin/webhooks/recovery (GET report,
 * POST run). Handler-level tests with injected deps: no DB, no Stripe, no HTTP server.
 *
 *   npm run test:admin-webhook-recovery-auth
 *
 * Labels: MOCK = injected fake deps; STATIC = source-text assertion.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { AdminForbiddenError, AdminUnauthorizedError } from "../src/lib/admin-auth/errors";
import type { AdminSessionRecord } from "../src/lib/admin-auth/types";
import {
  handleAdminWebhookRecoveryReport,
  handleAdminWebhookRecoveryRun,
  type AdminWebhookRecoveryDeps,
} from "../src/app/api/admin/webhooks/recovery/handle-admin-webhook-recovery";
import {
  WebhookRecoveryLookupError,
  type WebhookRecoveryResult,
} from "../src/lib/stripe/webhook-recovery";
import type { WebhookRecoveryReport } from "../src/lib/stripe/webhook-recovery-report-types";

function session(role: "ADMIN" | "STAFF", id = "user-1"): AdminSessionRecord {
  return {
    id,
    name: "Test User",
    email: `${role.toLowerCase()}@test.local`,
    role,
    sessionId: "sess-1",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

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

const emptyReport: WebhookRecoveryReport = {
  maxAttempts: 8,
  minRetryAgeSeconds: 300,
  claimProtocolCutover: { status: "unset", value: null },
  counts: {
    activeClaims: 0,
    expiredClaims: 0,
    retryableFailed: 0,
    retryableFailedEligibleNow: 0,
    nearRetryLimit: 0,
    atRetryLimit: 0,
    legacyRetryable: 0,
    legacyUnclaimed: 0,
    receivedClaimEraEligible: 0,
    excludedEventTypePending: 0,
    deadLetterRetryLimit: 0,
    deadLetterPermanent: 0,
  },
  samples: [],
};

function makeDeps(authorize: AdminWebhookRecoveryDeps["authorize"]) {
  const state = {
    runCalls: [] as Array<{ input: unknown; actor: string }>,
    reportCalls: [] as unknown[],
  };
  const deps: AdminWebhookRecoveryDeps = {
    authorize,
    runRecovery: async (input, actor) => {
      state.runCalls.push({ input, actor });
      return emptyResult;
    },
    loadReport: async (input) => {
      state.reportCalls.push(input);
      return emptyReport;
    },
  };
  return { deps, state };
}

const post = (body?: unknown, raw?: string) =>
  new Request("http://localhost/api/admin/webhooks/recovery", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });

const get = (query = "") => new Request(`http://localhost/api/admin/webhooks/recovery${query}`);

/** MOCK — unauthenticated and non-ADMIN callers are rejected before any work. */
async function testAuthEnforcedOnBothMethods() {
  for (const [error, status] of [
    [new AdminUnauthorizedError(), 401],
    [new AdminForbiddenError(), 403],
  ] as const) {
    const { deps, state } = makeDeps(async () => {
      throw error;
    });
    const run = await handleAdminWebhookRecoveryRun(post({}), deps);
    assert.equal(run.status, status);
    const report = await handleAdminWebhookRecoveryReport(get(), deps);
    assert.equal(report.status, status);
    assert.equal(state.runCalls.length, 0, "no recovery work before authorization");
    assert.equal(state.reportCalls.length, 0, "no report query before authorization");
  }
}

/** MOCK — authorization happens before the request body is even read. */
async function testAuthBeforeBodyParsing() {
  const { deps, state } = makeDeps(async () => {
    throw new AdminForbiddenError();
  });
  const response = await handleAdminWebhookRecoveryRun(post(undefined, "{not json"), deps);
  assert.equal(response.status, 403, "403, not 400: auth precedes body validation");
  assert.equal(state.runCalls.length, 0);
}

/** MOCK — ADMIN succeeds; actor identity is passed for auditing. */
async function testAdminRunSucceedsWithActor() {
  const { deps, state } = makeDeps(async () => session("ADMIN", "admin-7"));
  const response = await handleAdminWebhookRecoveryRun(post({ batchSize: 5, minRetryAgeSeconds: 120 }), deps);
  assert.equal(response.status, 200);
  const json = (await response.json()) as { success: boolean; result: WebhookRecoveryResult };
  assert.equal(json.success, true);
  assert.deepEqual(json.result, emptyResult);
  assert.deepEqual(state.runCalls, [
    { input: { batchSize: 5, minRetryAgeSeconds: 120 }, actor: "admin:admin-7" },
  ]);

  // Empty body is allowed and uses defaults.
  const empty = await handleAdminWebhookRecoveryRun(post(undefined), deps);
  assert.equal(empty.status, 200);
  assert.deepEqual(state.runCalls[1]?.input, {});
}

/** MOCK — input is validated and bounded; unknown/override keys are rejected. */
async function testInputValidation() {
  const { deps, state } = makeDeps(async () => session("ADMIN"));
  const bad: unknown[] = [
    { batchSize: 0 },
    { batchSize: 26 },
    { batchSize: 1000 },
    { batchSize: 2.5 },
    { batchSize: "5" },
    { minRetryAgeSeconds: 59 },
    { minRetryAgeSeconds: 86_401 },
    // Attempts to widen scope or bypass the claim contract are not accepted:
    { includeDeadLetter: true },
    { force: true },
    { status: "RECEIVED" },
    { maxAttempts: 1 },
    { purpose: "RENTAL" },
    { eventIds: ["evt_1"] },
  ];
  for (const body of bad) {
    const response = await handleAdminWebhookRecoveryRun(post(body), deps);
    assert.equal(response.status, 400, JSON.stringify(body));
    const json = (await response.json()) as { code: string };
    assert.equal(json.code, "INVALID_PARAMETERS");
  }
  const invalidJson = await handleAdminWebhookRecoveryRun(post(undefined, "{not json"), deps);
  assert.equal(invalidJson.status, 400);
  assert.equal(((await invalidJson.json()) as { code: string }).code, "INVALID_JSON");
  assert.equal(state.runCalls.length, 0, "nothing ran for any invalid input");

  const boundary = await handleAdminWebhookRecoveryRun(post({ batchSize: 25, minRetryAgeSeconds: 60 }), deps);
  assert.equal(boundary.status, 200);
}

/** MOCK — report query is validated; category must be a known value. */
async function testReportValidation() {
  const { deps, state } = makeDeps(async () => session("ADMIN"));
  const ok = await handleAdminWebhookRecoveryReport(get("?sampleLimit=10&category=DEAD_LETTER_RETRY_LIMIT"), deps);
  assert.equal(ok.status, 200);
  assert.deepEqual(state.reportCalls[0], {
    minRetryAgeSeconds: 300,
    sampleLimit: 10,
    category: "DEAD_LETTER_RETRY_LIMIT",
  });
  for (const query of ["?sampleLimit=0", "?sampleLimit=101", "?category=NOPE", "?minRetryAgeSeconds=5"]) {
    const response = await handleAdminWebhookRecoveryReport(get(query), deps);
    assert.equal(response.status, 400, query);
  }
  assert.equal(state.reportCalls.length, 1);
}

/** MOCK — failures surface stable codes only (no internals). */
async function testStableErrorCodes() {
  const lookup = makeDeps(async () => session("ADMIN"));
  lookup.deps.runRecovery = async () => {
    throw new WebhookRecoveryLookupError();
  };
  const r1 = await handleAdminWebhookRecoveryRun(post({}), lookup.deps);
  assert.equal(r1.status, 503);
  assert.equal(((await r1.json()) as { code: string }).code, "RECOVERY_LOOKUP_FAILED");

  const boom = makeDeps(async () => session("ADMIN"));
  boom.deps.runRecovery = async () => {
    throw new Error("SELECT * FROM secrets password=hunter2");
  };
  const quiet = console.error;
  console.error = () => undefined;
  try {
    const r2 = await handleAdminWebhookRecoveryRun(post({}), boom.deps);
    assert.equal(r2.status, 500);
    const text = JSON.stringify(await r2.json());
    assert.equal(JSON.parse(text).code, "INTERNAL_ERROR");
    assert.doesNotMatch(text, /SELECT|password|hunter2/);
  } finally {
    console.error = quiet;
  }
}

/** STATIC — the route authorizes with ADMIN only and exposes only GET/POST. */
function testRouteAdminOnly() {
  const route = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/admin/webhooks/recovery/route.ts"),
    "utf8",
  );
  assert.match(route, /requireAdminApiRole\(\["ADMIN"\]\)/);
  assert.doesNotMatch(route, /requireAdminApiRole\(\[[^\]]*STAFF/);
  assert.doesNotMatch(route, /export async function (PUT|PATCH|DELETE)/);
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function POST/);
}

async function main() {
  const tests: Array<[string, () => void | Promise<void>]> = [
    ["MOCK auth enforced on GET and POST", testAuthEnforcedOnBothMethods],
    ["MOCK auth precedes body parsing", testAuthBeforeBodyParsing],
    ["MOCK ADMIN run succeeds with actor", testAdminRunSucceedsWithActor],
    ["MOCK input validation + no override keys", testInputValidation],
    ["MOCK report validation", testReportValidation],
    ["MOCK stable error codes", testStableErrorCodes],
    ["STATIC route is ADMIN-only GET/POST", testRouteAdminOnly],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} admin webhook recovery authorization tests defined.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
