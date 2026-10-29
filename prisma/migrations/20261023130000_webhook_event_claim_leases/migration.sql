-- Migration: webhook_event_claim_leases
-- Additive schema for lease-based Stripe webhook claims, fencing, attempts and
-- typed processing status.
--
-- Safety properties (review before applying; NOT applied by the authoring stage):
--   * Purely additive: no DROP, no column type change, no row deletion.
--   * Does not modify prior migrations (including 20261023120000_*).
--   * Existing payloads, stripeEventId values, timestamps and `error` text are kept.
--   * Existing rows are backfilled into a consistent status BEFORE constraints are added.
--   * Old application code (pre-claim) keeps working after this migration:
--       - inserts take defaults (status RECEIVED, processed false);
--       - it only writes `processed`/`processedAt`/`error`, never `status`;
--       - the CHECK constraints below are one-directional so they never reject those writes.
--   * New application code treats `processed = true` as "already processed" even when
--     `status` was left stale by old code (rollback window), so no reprocessing storm.
--
-- Rollback note (code rollback only; schema is left in place):
--   After rolling application code back, rows completed by old code may show
--   status <> 'PROCESSED' with processed = true. To realign before re-deploying new
--   code (optional, because new code already honours `processed`), an operator may run:
--     UPDATE "WebhookEvent" SET "status" = 'PROCESSED'
--      WHERE "processed" = true AND "status" <> 'PROCESSED';
--   Rows left in PROCESSING by an interrupted new-code worker become reclaimable once
--   "claimExpiresAt" passes, and are ignored by old code.

-- ── Enum ───────────────────────────────────────────────────────────────────────

CREATE TYPE "WebhookEventStatus" AS ENUM (
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'RETRYABLE_FAILED',
  'DEAD_LETTER'
);

-- ── Columns (all nullable or defaulted so existing rows stay readable) ─────────

ALTER TABLE "WebhookEvent"
  ADD COLUMN "status"          "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
  ADD COLUMN "claimToken"      TEXT,
  ADD COLUMN "claimExpiresAt"  TIMESTAMP(3),
  ADD COLUMN "claimGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "attemptCount"    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastErrorCode"   TEXT,
  ADD COLUMN "lastAttemptAt"   TIMESTAMP(3);

-- ── Backfill existing rows into consistent states ──────────────────────────────
-- Every existing row starts as RECEIVED via the column default. Then:
--   processed = true                      -> PROCESSED (at least one attempt happened)
--   processed = false AND error IS NOT NULL -> RETRYABLE_FAILED (history kept in "error")
--   processed = false AND error IS NULL     -> stays RECEIVED (never completed, never failed)
-- attemptCount is set to 1 only where a prior attempt is evidenced; claimGeneration stays 0.

UPDATE "WebhookEvent"
SET
  "status"        = 'PROCESSED',
  "attemptCount"  = 1,
  "lastAttemptAt" = "processedAt"
WHERE "processed" = true;

UPDATE "WebhookEvent"
SET
  "status"        = 'RETRYABLE_FAILED',
  "attemptCount"  = 1,
  "lastErrorCode" = 'LEGACY_UNCLASSIFIED_ERROR'
WHERE "processed" = false
  AND "error" IS NOT NULL;

-- ── Constraints (added after backfill) ─────────────────────────────────────────
-- One-directional processed/status rule (see header). The reverse direction
-- (processed = true with a non-PROCESSED status) is deliberately NOT forbidden.

ALTER TABLE "WebhookEvent"
  ADD CONSTRAINT "WebhookEvent_processed_status_check"
    CHECK ("status" <> 'PROCESSED' OR "processed" = true),
  ADD CONSTRAINT "WebhookEvent_processing_lease_check"
    CHECK ("status" <> 'PROCESSING' OR ("claimToken" IS NOT NULL AND "claimExpiresAt" IS NOT NULL)),
  ADD CONSTRAINT "WebhookEvent_claimGeneration_nonneg_check"
    CHECK ("claimGeneration" >= 0),
  ADD CONSTRAINT "WebhookEvent_attemptCount_nonneg_check"
    CHECK ("attemptCount" >= 0);

-- ── Indexes ────────────────────────────────────────────────────────────────────
-- status + lease expiry: expired-claim recovery and ops queries.
-- status + createdAt: dead-letter / retryable review queues.

CREATE INDEX "WebhookEvent_status_claimExpiresAt_idx" ON "WebhookEvent"("status", "claimExpiresAt");
CREATE INDEX "WebhookEvent_status_createdAt_idx"      ON "WebhookEvent"("status", "createdAt");
