/**
 * Pure tests for Vercel Cron Bearer authorization (no HTTP server, no secrets logged).
 *
 *   npm run test:cron-authorization
 */

import assert from "node:assert/strict";

import {
  CronUnauthorizedError,
  assertCronAuthorization,
} from "../src/lib/cron/assert-cron-authorization";

function req(authorization?: string | null): Request {
  const headers = new Headers();
  if (authorization !== undefined && authorization !== null) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/api/cron/example", { method: "GET", headers });
}

function testMissingSecretFailsClosed() {
  for (const env of [
    {},
    { CRON_SECRET: "" },
    { CRON_SECRET: "   " },
    { CRON_SECRET: "has\nnewline" },
    { CRON_SECRET: "has\0null" },
  ] as NodeJS.ProcessEnv[]) {
    assert.throws(
      () => assertCronAuthorization(req("Bearer anything"), env),
      CronUnauthorizedError,
      JSON.stringify(env),
    );
  }
}

function testInvalidBearerRejected() {
  const env = { CRON_SECRET: "test-cron-secret-value" } as NodeJS.ProcessEnv;
  for (const header of [
    undefined,
    null,
    "",
    "Bearer",
    "Bearer ",
    "bearer test-cron-secret-value",
    "Basic test-cron-secret-value",
    "Bearer wrong-secret",
    "Bearer test-cron-secret-valueX",
    "Bearer test-cron-secret-valu",
  ]) {
    assert.throws(
      () => assertCronAuthorization(req(header), env),
      CronUnauthorizedError,
      String(header),
    );
  }
}

function testValidBearerAccepted() {
  const secret = "test-cron-secret-value";
  const env = { CRON_SECRET: secret } as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => assertCronAuthorization(req(`Bearer ${secret}`), env));
}

function main() {
  const tests: Array<[string, () => void]> = [
    ["missing/empty/malformed CRON_SECRET fails closed", testMissingSecretFailsClosed],
    ["invalid Authorization rejected", testInvalidBearerRejected],
    ["valid Bearer accepted", testValidBearerAccepted],
  ];
  for (const [name, fn] of tests) {
    fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} cron authorization tests passed.`);
}

main();
