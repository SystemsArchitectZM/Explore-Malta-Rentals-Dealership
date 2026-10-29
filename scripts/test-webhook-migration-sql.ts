/**
 * STATIC review of the additive WebhookEvent migration + schema consistency.
 *
 *   npm run test:webhook-migration-sql
 *
 * This test READS SQL/Prisma text only. It does NOT execute SQL and does NOT connect to
 * PostgreSQL, so it cannot prove the migration applies cleanly or that backfilled rows are
 * correct in a real database. A real-PostgreSQL migration rehearsal on a copy of
 * production-shaped data is required (see docs/stripe-webhook-reliability.md).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { legacyWebhookEventStatus } from "../src/lib/stripe/webhook-event-claim";

const root = process.cwd();
const migrationsDir = path.join(root, "prisma/migrations");
const NEW_MIGRATION = "20261023130000_webhook_event_claim_leases";
const STAGE_1B_MIGRATION = "20261023120000_stripe_refund_allocations_and_requests";

function newSql(): string {
  return fs.readFileSync(path.join(migrationsDir, NEW_MIGRATION, "migration.sql"), "utf8");
}

/** Strip SQL line comments so assertions only see executable statements. */
function executable(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

function testMigrationIsNewAndOrderedAfterStage1B() {
  assert.ok(fs.existsSync(path.join(migrationsDir, NEW_MIGRATION, "migration.sql")));
  assert.ok(
    fs.existsSync(path.join(migrationsDir, STAGE_1B_MIGRATION, "migration.sql")),
    "Stage 1B migration must remain present",
  );
  assert.ok(NEW_MIGRATION > STAGE_1B_MIGRATION, "new migration sorts after Stage 1B");
}

function testMigrationIsAdditiveOnly() {
  const sql = executable(newSql());
  assert.doesNotMatch(sql, /\bDROP\b/i);
  assert.doesNotMatch(sql, /\bDELETE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /ALTER\s+COLUMN/i, "no type/nullability changes on existing columns");
  assert.doesNotMatch(sql, /RENAME/i);
  // Only the WebhookEvent table is altered.
  const alters = sql.match(/ALTER TABLE "[A-Za-z]+"/g) ?? [];
  assert.ok(alters.length > 0);
  for (const stmt of alters) assert.equal(stmt, 'ALTER TABLE "WebhookEvent"');
  // Updates only touch WebhookEvent.
  const updates = sql.match(/UPDATE "[A-Za-z]+"/g) ?? [];
  for (const stmt of updates) assert.equal(stmt, 'UPDATE "WebhookEvent"');
}

function testEnumColumnsAndDefaults() {
  const sql = executable(newSql());
  assert.match(
    sql,
    /CREATE TYPE "WebhookEventStatus" AS ENUM \(\s*'RECEIVED',\s*'PROCESSING',\s*'PROCESSED',\s*'RETRYABLE_FAILED',\s*'DEAD_LETTER'\s*\)/,
  );
  assert.match(sql, /ADD COLUMN "status"\s+"WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED'/);
  assert.match(sql, /ADD COLUMN "claimToken"\s+TEXT,/);
  assert.match(sql, /ADD COLUMN "claimExpiresAt"\s+TIMESTAMP\(3\),/);
  assert.match(sql, /ADD COLUMN "claimGeneration" INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN "attemptCount"\s+INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN "lastErrorCode"\s+TEXT,/);
  assert.match(sql, /ADD COLUMN "lastAttemptAt"\s+TIMESTAMP\(3\)/);
  // The enum is created before any column uses it.
  assert.ok(sql.indexOf("CREATE TYPE") < sql.indexOf("ADD COLUMN"));
}

function testBackfillPrecedesConstraintsAndKeepsHistory() {
  const sql = executable(newSql());
  const backfillProcessed = sql.search(/"status"\s+= 'PROCESSED'/);
  const backfillRetryable = sql.search(/"status"\s+= 'RETRYABLE_FAILED'/);
  const firstConstraint = sql.indexOf("ADD CONSTRAINT");
  assert.ok(backfillProcessed > 0 && backfillRetryable > 0);
  assert.ok(backfillProcessed < firstConstraint, "backfill before constraints");
  assert.ok(backfillRetryable < firstConstraint, "backfill before constraints");
  assert.match(sql, /WHERE "processed" = true/);
  assert.match(sql, /WHERE "processed" = false\s+AND "error" IS NOT NULL/);
  // History columns are never overwritten by the backfill.
  assert.doesNotMatch(sql, /SET[^;]*"error"\s*=/);
  assert.doesNotMatch(sql, /SET[^;]*"payload"\s*=/);
  assert.doesNotMatch(sql, /SET[^;]*"processedAt"\s*=/);
  assert.doesNotMatch(sql, /SET[^;]*"stripeEventId"\s*=/);
}

function testConstraintsAreRollbackSafe() {
  const sql = executable(newSql());
  // One-directional: PROCESSED requires processed=true; processed=true with a stale status
  // (old code after rollback) is deliberately allowed.
  assert.match(
    sql,
    /"WebhookEvent_processed_status_check"\s+CHECK \("status" <> 'PROCESSED' OR "processed" = true\)/,
  );
  assert.doesNotMatch(sql, /CHECK \("processed" = \("status" = 'PROCESSED'\)\)/);
  assert.match(
    sql,
    /"WebhookEvent_processing_lease_check"\s+CHECK \("status" <> 'PROCESSING' OR \("claimToken" IS NOT NULL AND "claimExpiresAt" IS NOT NULL\)\)/,
  );
  assert.match(sql, /"claimGeneration" >= 0/);
  assert.match(sql, /"attemptCount" >= 0/);
}

function testIndexes() {
  const sql = executable(newSql());
  assert.match(sql, /CREATE INDEX "WebhookEvent_status_claimExpiresAt_idx" ON "WebhookEvent"\("status", "claimExpiresAt"\)/);
  assert.match(sql, /CREATE INDEX "WebhookEvent_status_createdAt_idx"\s+ON "WebhookEvent"\("status", "createdAt"\)/);
}

function testSchemaMatchesMigration() {
  const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");
  const model = schema.match(/model WebhookEvent \{[\s\S]*?\n\}/);
  assert.ok(model, "WebhookEvent model present");
  const body = model[0];
  assert.match(body, /stripeEventId\s+String\s+@unique/);
  assert.match(body, /status\s+WebhookEventStatus\s+@default\(RECEIVED\)/);
  assert.match(body, /claimToken\s+String\?/);
  assert.match(body, /claimExpiresAt\s+DateTime\?/);
  assert.match(body, /claimGeneration\s+Int\s+@default\(0\)/);
  assert.match(body, /attemptCount\s+Int\s+@default\(0\)/);
  assert.match(body, /lastErrorCode\s+String\?/);
  assert.match(body, /lastAttemptAt\s+DateTime\?/);
  assert.match(body, /@@index\(\[status, claimExpiresAt\]\)/);
  assert.match(body, /@@index\(\[status, createdAt\]\)/);
  // Legacy columns retained.
  assert.match(body, /processed\s+Boolean\s+@default\(false\)/);
  assert.match(body, /payload\s+Json/);
  assert.match(body, /error\s+String\?/);
  assert.match(
    schema,
    /enum WebhookEventStatus \{\s*RECEIVED\s*PROCESSING\s*PROCESSED\s*RETRYABLE_FAILED\s*DEAD_LETTER\s*\}/,
  );
}

/** 15. STATIC/PURE — legacy WebhookEvent rows map into consistent states. */
function testLegacyRowsMapToConsistentStates() {
  assert.deepEqual(legacyWebhookEventStatus({ processed: true, error: null }), {
    status: "PROCESSED",
    attemptCount: 1,
    lastErrorCode: null,
  });
  // processed=true with an old error string (failed then later succeeded) stays PROCESSED.
  assert.equal(legacyWebhookEventStatus({ processed: true, error: "old failure" }).status, "PROCESSED");
  assert.deepEqual(legacyWebhookEventStatus({ processed: false, error: "boom" }), {
    status: "RETRYABLE_FAILED",
    attemptCount: 1,
    lastErrorCode: "LEGACY_UNCLASSIFIED_ERROR",
  });
  assert.deepEqual(legacyWebhookEventStatus({ processed: false, error: null }), {
    status: "RECEIVED",
    attemptCount: 0,
    lastErrorCode: null,
  });

  // The SQL backfill must express the same mapping (text-level check).
  const sql = executable(newSql());
  assert.match(sql, /"attemptCount"\s+= 1,\s+"lastAttemptAt" = "processedAt"\s+WHERE "processed" = true/);
  assert.match(sql, /"lastErrorCode" = 'LEGACY_UNCLASSIFIED_ERROR'\s+WHERE "processed" = false\s+AND "error" IS NOT NULL/);

  // After the mapping, the one-directional CHECK holds for every legacy combination.
  for (const processed of [true, false]) {
    for (const error of [null, "e"]) {
      const mapped = legacyWebhookEventStatus({ processed, error });
      assert.ok(mapped.status !== "PROCESSED" || processed, "status PROCESSED implies processed");
      assert.notEqual(mapped.status, "PROCESSING", "no legacy row is mapped to an unleased PROCESSING");
    }
  }
}

function testStage1BMigrationNotReferencedOrEdited() {
  // The new migration must not restate Stage 1B objects.
  const sql = executable(newSql());
  assert.doesNotMatch(sql, /StripeRefundRequest|RefundPurpose|rentalAmountCents/);
  // Stage 1B SQL file is still the Stage 1B artifact.
  const stage1b = fs.readFileSync(
    path.join(migrationsDir, STAGE_1B_MIGRATION, "migration.sql"),
    "utf8",
  );
  assert.match(stage1b, /CREATE TYPE "RefundPurpose"/);
  assert.doesNotMatch(stage1b, /WebhookEventStatus/);
}

function main() {
  const tests: Array<[string, () => void]> = [
    ["STATIC migration new and ordered after Stage 1B", testMigrationIsNewAndOrderedAfterStage1B],
    ["STATIC migration additive only", testMigrationIsAdditiveOnly],
    ["STATIC enum, columns and defaults", testEnumColumnsAndDefaults],
    ["STATIC backfill precedes constraints and keeps history", testBackfillPrecedesConstraintsAndKeepsHistory],
    ["STATIC constraints are rollback safe", testConstraintsAreRollbackSafe],
    ["STATIC indexes", testIndexes],
    ["STATIC schema matches migration", testSchemaMatchesMigration],
    ["STATIC legacy rows map to consistent states", testLegacyRowsMapToConsistentStates],
    ["STATIC Stage 1B migration untouched", testStage1BMigrationNotReferencedOrEdited],
  ];
  for (const [name, fn] of tests) {
    fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} static migration checks defined (SQL NOT executed).`);
}

main();
