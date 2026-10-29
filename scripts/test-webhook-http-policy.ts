/**
 * Webhook HTTP policy + typed failure classification tests (no DB, no Stripe).
 *
 *   npm run test:webhook-http-policy
 *
 * Labels: PURE = pure function test; STATIC = source-text assertion (no execution of
 * the route or any database). None requires PostgreSQL.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  classifyWebhookFailure,
  isTransientInfrastructureError,
  summarizeErrorForStorage,
  WebhookPermanentError,
} from "../src/lib/stripe/webhook-errors";
import {
  mapWebhookResultToHttp,
  WEBHOOK_IN_FLIGHT_HTTP_STATUS,
  WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS,
} from "../src/lib/stripe/webhook-http-policy";
import {
  sanitizeWebhookOpsContext,
  webhookOpsEventLevel,
} from "../src/lib/stripe/webhook-ops-log";
import type { ProcessWebhookResult, WebhookFailureCode } from "../src/lib/stripe/types";

const root = process.cwd();

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

/** PURE — 12. HTTP mapping is derived from the typed outcome. */
function testOutcomeToHttpMapping() {
  const cases: Array<[ProcessWebhookResult, number]> = [
    [{ outcome: "processed", action: "payment_confirmed", attemptCount: 1 }, 200],
    [{ outcome: "ignored", action: "unhandled", attemptCount: 1 }, 200],
    [{ outcome: "already_processed" }, 200],
    [{ outcome: "in_flight" }, WEBHOOK_IN_FLIGHT_HTTP_STATUS],
    [{ outcome: "permanent_failure", code: "EVENT_METADATA_MISSING", deadLettered: true }, 200],
    [{ outcome: "permanent_failure", code: "EVENT_DEAD_LETTERED", deadLettered: true }, 200],
    [{ outcome: "retryable_failure", code: "HANDLER_ERROR", handlerCompleted: false }, 500],
    [{ outcome: "retryable_failure", code: "DB_TRANSIENT", handlerCompleted: false }, 500],
    [{ outcome: "retryable_failure", code: "FINALIZE_FAILED", handlerCompleted: true }, 500],
  ];
  for (const [result, status] of cases) {
    assert.equal(mapWebhookResultToHttp(result).status, status, JSON.stringify(result));
  }
  assert.equal(
    WEBHOOK_IN_FLIGHT_HTTP_STATUS,
    503,
    "Stage 3.21 policy: in_flight is a retryable 503 (never a 2xx acknowledgement)",
  );
}

/** PURE — Stage 3.21: in_flight is retryable, carries Retry-After, and exposes no internals. */
function testInFlightIsRetryable() {
  const response = mapWebhookResultToHttp({ outcome: "in_flight" });
  assert.equal(response.status, 503);
  assert.ok(response.status >= 500, "Stripe must treat an in-flight duplicate as not acknowledged");
  assert.equal(response.body.received, false);
  assert.equal(response.body.outcome, "in_flight");
  assert.equal(response.body.error, "EVENT_IN_FLIGHT");
  assert.deepEqual(Object.keys(response.body).sort(), ["error", "outcome", "received"]);
  assert.equal(response.headers?.["Retry-After"], String(WEBHOOK_IN_FLIGHT_RETRY_AFTER_SECONDS));
  assert.doesNotMatch(JSON.stringify(response), /stack|SELECT|postgres|password|sk_|claimToken|lease/i);
}

/** PURE — Stage 3.21: terminal outcomes keep their previous 2xx behaviour. */
function testTerminalOutcomesStayAcknowledged() {
  assert.equal(mapWebhookResultToHttp({ outcome: "already_processed" }).status, 200);
  const dead = mapWebhookResultToHttp({
    outcome: "permanent_failure",
    code: "RETRY_LIMIT_EXCEEDED",
    deadLettered: true,
  });
  assert.equal(dead.status, 200);
  assert.equal(dead.body.deadLettered, true);
  const alreadyDead = mapWebhookResultToHttp({
    outcome: "permanent_failure",
    code: "EVENT_DEAD_LETTERED",
    deadLettered: true,
  });
  assert.equal(alreadyDead.status, 200);
  // No outcome other than in_flight adds headers.
  assert.equal(mapWebhookResultToHttp({ outcome: "already_processed" }).headers, undefined);
}

/** STATIC — in_flight is derived from the typed outcome and never changes lease state. */
function testInFlightPathIsReadOnlyInOrchestrator() {
  const processing = read("src/lib/stripe/webhook-processing.ts");
  const inFlightCase = processing.match(/case "in_flight":[\s\S]*?return \{ outcome: "in_flight" \};/);
  assert.ok(inFlightCase, "in_flight branch present");
  assert.doesNotMatch(
    inFlightCase![0],
    /markProcessed|releaseForRetry|markDeadLetter|tryClaim|dispatch\(/,
    "an in-flight duplicate must not mutate the owner's claim or run a handler",
  );
  const route = read("src/app/api/stripe/webhook/route.ts");
  assert.match(route, /headers/, "route forwards policy headers (Retry-After)");
  assert.doesNotMatch(route, /in_flight[\s\S]{0,80}status: 200/);
}

/** PURE — every retryable code is 5xx regardless of any message text. */
function testEveryRetryableCodeIs5xx() {
  const codes: WebhookFailureCode[] = [
    "DB_TRANSIENT",
    "HANDLER_ERROR",
    "EVENT_RECORD_FAILED",
    "CLAIM_FAILED",
    "CLAIM_STATE_CHANGED",
    "CLAIM_SUPERSEDED",
    "FINALIZE_FAILED",
    "DEAD_LETTER_PERSIST_FAILED",
  ];
  for (const code of codes) {
    const response = mapWebhookResultToHttp({
      outcome: "retryable_failure",
      code,
      handlerCompleted: false,
    });
    assert.equal(response.status, 500, code);
    assert.equal(response.body.received, false);
    assert.equal(response.body.error, code);
  }
}

/** PURE — response bodies carry only stable codes (no stack traces / SQL / secrets). */
function testBodiesContainOnlyStableCodes() {
  const response = mapWebhookResultToHttp({
    outcome: "retryable_failure",
    code: "HANDLER_ERROR",
    handlerCompleted: false,
  });
  assert.deepEqual(Object.keys(response.body).sort(), ["error", "outcome", "received"]);
  const serialized = JSON.stringify(response.body);
  assert.doesNotMatch(serialized, /stack|SELECT|postgres|password|sk_/i);
}

/** PURE — classification relies on structured codes, never on message substrings. */
function testClassificationIgnoresMessageText() {
  // Messages that the OLD substring matcher treated as transient must NOT change anything
  // by themselves; they are still retryable (fail closed) but only labelled HANDLER_ERROR.
  const looksTransient = classifyWebhookFailure(new Error("database timeout ECONNREFUSED"));
  assert.deepEqual(looksTransient, { retryable: true, code: "HANDLER_ERROR" });
  assert.equal(isTransientInfrastructureError(new Error("timeout")), false);

  // An unrecognised message without those words is ALSO retryable (old code returned 200).
  const opaque = classifyWebhookFailure(new Error("Something went sideways"));
  assert.deepEqual(opaque, { retryable: true, code: "HANDLER_ERROR" });
}

/** PURE — structured infrastructure codes are recognised, including nested causes. */
function testStructuredTransientCodes() {
  assert.equal(
    classifyWebhookFailure(Object.assign(new Error("x"), { code: "P1001" })).code,
    "DB_TRANSIENT",
  );
  assert.equal(
    classifyWebhookFailure(Object.assign(new Error("x"), { code: "P2034" })).code,
    "DB_TRANSIENT",
  );
  assert.equal(
    classifyWebhookFailure(
      Object.assign(new Error("wrapper"), {
        cause: Object.assign(new Error("inner"), { code: "ECONNREFUSED" }),
      }),
    ).code,
    "DB_TRANSIENT",
  );
  assert.equal(
    classifyWebhookFailure(Object.assign(new Error("deadlock"), { code: "40P01" })).code,
    "DB_TRANSIENT",
  );
  assert.equal(
    classifyWebhookFailure(Object.assign(new Error("conn"), { originalCode: "08006" })).code,
    "DB_TRANSIENT",
  );
  const initErr = new Error("init");
  initErr.name = "PrismaClientInitializationError";
  assert.equal(classifyWebhookFailure(initErr).code, "DB_TRANSIENT");

  // Non-transient Prisma/SQL codes (e.g. unique violation) are NOT labelled transient,
  // but remain retryable because only documented permanent errors are terminal.
  const unique = classifyWebhookFailure(Object.assign(new Error("dup"), { code: "P2002" }));
  assert.deepEqual(unique, { retryable: true, code: "HANDLER_ERROR" });
}

/** PURE — only documented typed permanent errors are terminal. */
function testOnlyTypedPermanentErrorsAreTerminal() {
  const permanent = classifyWebhookFailure(
    new WebhookPermanentError("BOOKING_CANCELLED_PAYMENT_RECEIVED", "cancelled"),
  );
  assert.deepEqual(permanent, { retryable: false, code: "BOOKING_CANCELLED_PAYMENT_RECEIVED" });

  const integrity = classifyWebhookFailure(
    new WebhookPermanentError("PAYMENT_INTEGRITY_MISMATCH", "amount"),
  );
  assert.deepEqual(integrity, { retryable: false, code: "PAYMENT_INTEGRITY_MISMATCH" });
  // Same message text on a plain Error is NOT permanent.
  assert.equal(classifyWebhookFailure(new Error("cancelled booking")).retryable, true);
}

/** PURE — stored error summaries are bounded and single-line (no stack). */
function testErrorSummaryBounded() {
  const long = new Error(`line1\nline2 ${"x".repeat(2000)}`);
  const summary = summarizeErrorForStorage(long);
  assert.ok(summary.length <= 500);
  assert.doesNotMatch(summary, /\n/);
  assert.doesNotMatch(summary, /\bat \S+ \(/);
}

/** PURE — ops log sanitization drops payload-like and unknown keys. */
function testOpsLogSanitization() {
  const out = sanitizeWebhookOpsContext({
    stripeEventId: "evt_1",
    eventType: "refund.updated",
    attemptCount: 2,
    payload: { card: "4242" },
    customerEmail: "a@b.com",
    stack: "trace",
    errorCode: "HANDLER_ERROR",
  });
  assert.deepEqual(out, {
    stripeEventId: "evt_1",
    eventType: "refund.updated",
    attemptCount: 2,
    errorCode: "HANDLER_ERROR",
  });
  assert.equal(webhookOpsEventLevel("webhook.retryable_failure"), "error");
  assert.equal(webhookOpsEventLevel("webhook.duplicate_already_processed"), "info");
  assert.equal(webhookOpsEventLevel("webhook.event_processed"), "info");
}

/** STATIC — the route must use the typed policy and no message-substring classification. */
function testRouteUsesTypedPolicyOnly() {
  const route = read("src/app/api/stripe/webhook/route.ts");
  assert.match(route, /mapWebhookResultToHttp/);
  assert.doesNotMatch(route, /\.includes\(/, "no message-substring matching in route");
  assert.doesNotMatch(route, /ECONNREFUSED|"timeout"|"database"/);
  assert.doesNotMatch(route, /result\.error/);
  // Signature/body problems remain 400 before processing.
  assert.match(route, /Missing stripe-signature header[\s\S]*status: 400/);
  assert.match(route, /Invalid webhook signature[\s\S]*status: 400/);
  // Misconfiguration is a server fault, not a 400.
  assert.match(route, /WebhookConfigurationError[\s\S]*status: 500/);
  // processWebhookEvent is only reached after constructWebhookEvent succeeds.
  assert.ok(route.indexOf("constructWebhookEvent(") < route.indexOf("processWebhookEvent(event)"));
}

/** STATIC — webhook-service no longer uses check-then-act on `processed`. */
function testServiceNoLongerCheckThenAct() {
  const service = read("src/lib/stripe/webhook-service.ts");
  assert.doesNotMatch(service, /webhookEvent\.findUnique/);
  assert.doesNotMatch(service, /webhookEvent\.upsert/);
  assert.doesNotMatch(service, /webhookEvent\.update/);
  assert.match(service, /processWebhookEventWithDeps/);
  assert.match(service, /WebhookPermanentError/);
}

/** STATIC — SQL fencing predicates are present on every finalize/release/dead-letter update. */
function testStoreSqlIsFenced() {
  const store = read("src/lib/stripe/webhook-event-store.ts");
  const tokenChecks = store.match(/"claimToken" = \$\{claim\.claimToken\}/g) ?? [];
  const generationChecks = store.match(/"claimGeneration" = \$\{claim\.claimGeneration\}/g) ?? [];
  const statusChecks = store.match(/AND "status" = 'PROCESSING'::"WebhookEventStatus"/g) ?? [];
  assert.equal(tokenChecks.length, 3, "markProcessed, releaseForRetry, markDeadLetter");
  assert.equal(generationChecks.length, 3);
  assert.equal(statusChecks.length, 3);
  // Claim is a single conditional statement that increments fencing values.
  assert.match(store, /"claimGeneration" = w\."claimGeneration" \+ 1/);
  assert.match(store, /"attemptCount"\s+= w\."attemptCount" \+ 1/);
  assert.match(store, /"processed" = false/);
  // Uses tagged-template parameterization, not string concatenation.
  assert.doesNotMatch(store, /\$queryRawUnsafe|\$executeRawUnsafe/);
  // ensureRecord must not claim or overwrite.
  assert.match(store, /skipDuplicates: true/);
  // Database clock is the lease time source.
  assert.match(store, /NOW\(\) AT TIME ZONE 'UTC'/);
}

/** STATIC — webhook modules must not log or return raw payloads. */
function testNoPayloadLoggingInNewModules() {
  for (const rel of [
    "src/lib/stripe/webhook-processing.ts",
    "src/lib/stripe/webhook-ops-log.ts",
    "src/lib/stripe/webhook-http-policy.ts",
  ]) {
    const text = read(rel);
    assert.doesNotMatch(text, /console\.(log|error|info|warn)\([^)]*payload/);
  }
}

function main() {
  const tests: Array<[string, () => void]> = [
    ["PURE outcome to HTTP mapping", testOutcomeToHttpMapping],
    ["PURE in_flight is retryable 503 with Retry-After", testInFlightIsRetryable],
    ["PURE terminal outcomes stay acknowledged", testTerminalOutcomesStayAcknowledged],
    ["STATIC in_flight path is read-only in orchestrator", testInFlightPathIsReadOnlyInOrchestrator],
    ["PURE every retryable code is 5xx", testEveryRetryableCodeIs5xx],
    ["PURE bodies contain only stable codes", testBodiesContainOnlyStableCodes],
    ["PURE classification ignores message text", testClassificationIgnoresMessageText],
    ["PURE structured transient codes", testStructuredTransientCodes],
    ["PURE only typed permanent errors terminal", testOnlyTypedPermanentErrorsAreTerminal],
    ["PURE error summary bounded", testErrorSummaryBounded],
    ["PURE ops log sanitization", testOpsLogSanitization],
    ["STATIC route uses typed policy only", testRouteUsesTypedPolicyOnly],
    ["STATIC service no longer check-then-act", testServiceNoLongerCheckThenAct],
    ["STATIC store SQL is fenced", testStoreSqlIsFenced],
    ["STATIC no payload logging in new modules", testNoPayloadLoggingInNewModules],
  ];
  for (const [name, fn] of tests) {
    fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} webhook HTTP/classification tests defined.`);
}

main();
