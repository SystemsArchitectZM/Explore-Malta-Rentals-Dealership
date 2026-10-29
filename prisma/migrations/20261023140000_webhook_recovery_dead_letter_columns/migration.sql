-- Migration: webhook_recovery_dead_letter_columns
-- Stage 3.21. Additive follow-up to 20261023130000_webhook_event_claim_leases
-- (that migration is NOT modified).
--
-- Purpose:
--   * "deadLetterReason" / "deadLetteredAt": record WHY and WHEN an event was
--     dead-lettered as stable, queryable columns, so "lastErrorCode"/"error" can keep
--     the ORIGINAL failure evidence when the retry limit is reached.
--   * An index serving the bounded recovery candidate query
--     (status = 'RETRYABLE_FAILED' ordered by "lastAttemptAt").
--
-- Safety properties (review before applying; NOT applied by the authoring stage):
--   * Purely additive: no DROP, no type change, no row deletion, no constraint added.
--   * Both columns are nullable, so old and new application code both keep working
--     (old code never writes them; rows written by old code simply have NULL).
--   * The backfill only fills the new columns on rows ALREADY in DEAD_LETTER and never
--     touches any existing column, status, payload or timestamp.
--   * Index creation takes a SHARE lock on "WebhookEvent" for its duration (blocks
--     writes briefly on a small table). On a very large table use
--     CREATE INDEX CONCURRENTLY outside a transaction instead.
--
-- Rollback note (code rollback only; schema is left in place): the columns are ignored
-- by older code.

ALTER TABLE "WebhookEvent"
  ADD COLUMN "deadLetterReason" TEXT,
  ADD COLUMN "deadLetteredAt"   TIMESTAMP(3);

-- Rows dead-lettered by Stage 3.19 code stored the dead-letter code in "lastErrorCode"
-- (and may have overwritten the original error). Mark their reason as best-effort and
-- clearly distinguishable from a recorded reason so operators know the original
-- evidence may have been replaced. "lastErrorCode" is left exactly as it was.
UPDATE "WebhookEvent"
SET
  "deadLetterReason" = COALESCE("lastErrorCode", 'UNKNOWN_LEGACY_DEAD_LETTER'),
  "deadLetteredAt"   = COALESCE("lastAttemptAt", "createdAt")
WHERE "status" = 'DEAD_LETTER'
  AND "deadLetterReason" IS NULL;

CREATE INDEX "WebhookEvent_status_lastAttemptAt_idx" ON "WebhookEvent"("status", "lastAttemptAt");
