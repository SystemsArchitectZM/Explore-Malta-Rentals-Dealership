-- =============================================================================
-- Explore Malta Rentals — Production schema inspection (READ-ONLY)
-- Companion to: docs/production-db-schema-inspection-handoff.md
-- Git checkpoint reference: 9f88cd9b2cb89a1080b9965b3417836b4f447cf1
--
-- SAFETY:
--   * SELECT / catalog queries ONLY.
--   * Do NOT run DDL, DML, TRUNCATE, or Prisma migrate commands.
--   * Confirm this session targets PRODUCTION via provider dashboards first.
--   * Prefer an explicitly read-only database role.
--   * Do NOT paste connection strings, credentials, or customer/payment rows
--     into chat. Return only presence, types, statuses, and short summaries.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) Session / database identity (labels only — no secrets)
-- -----------------------------------------------------------------------------
SELECT
  current_database() AS database_name,
  current_user       AS session_user,
  inet_server_addr() AS server_addr_nullable,
  current_setting('server_version', true) AS server_version;

-- -----------------------------------------------------------------------------
-- 1) Migration history — the three feature migrations
-- -----------------------------------------------------------------------------
SELECT
  migration_name,
  finished_at,
  rolled_back_at,
  started_at,
  applied_steps_count,
  CASE
    WHEN logs IS NULL THEN 'no_logs'
    WHEN logs = '' THEN 'empty_logs'
    ELSE 'logs_present'
  END AS logs_presence,
  -- Safe short failure hint: first 200 chars only if logs look like an error.
  CASE
    WHEN logs IS NULL OR logs = '' THEN NULL
    WHEN logs ILIKE '%error%' OR logs ILIKE '%fail%' OR logs ILIKE '%exception%'
      THEN left(logs, 200)
    ELSE NULL
  END AS failure_summary_short
FROM "_prisma_migrations"
WHERE migration_name IN (
  '20261023120000_stripe_refund_allocations_and_requests',
  '20261023130000_webhook_event_claim_leases',
  '20261023140000_webhook_recovery_dead_letter_columns'
)
ORDER BY migration_name, started_at;

-- Duplicate / contradictory records for those names?
SELECT
  migration_name,
  COUNT(*) AS row_count
FROM "_prisma_migrations"
WHERE migration_name IN (
  '20261023120000_stripe_refund_allocations_and_requests',
  '20261023130000_webhook_event_claim_leases',
  '20261023140000_webhook_recovery_dead_letter_columns'
)
GROUP BY migration_name
HAVING COUNT(*) > 1
ORDER BY migration_name;

-- Recent migrations (context for booking/payment schema; names + timestamps only)
SELECT
  migration_name,
  finished_at,
  rolled_back_at
FROM "_prisma_migrations"
ORDER BY finished_at DESC NULLS LAST, started_at DESC
LIMIT 40;

-- -----------------------------------------------------------------------------
-- 2) StripePayment allocation columns — type, nullability, default
-- -----------------------------------------------------------------------------
SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'StripePayment'
  AND column_name IN (
    'rentalAmountCents',
    'depositAmountCents',
    'rentalRefundedCents',
    'depositRefundedCents',
    'amountCents',
    'refundedAmountCents'
  )
ORDER BY column_name;

-- Expected CHECK constraints from 20261023120000_…
SELECT
  c.conname AS constraint_name,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'StripePayment'
  AND c.contype = 'c'
  AND c.conname IN (
    'StripePayment_allocation_sum_check',
    'StripePayment_rentalAmountCents_nonneg_check',
    'StripePayment_depositAmountCents_nonneg_check',
    'StripePayment_rentalRefundedCents_nonneg_check',
    'StripePayment_depositRefundedCents_nonneg_check',
    'StripePayment_refundedAmountCents_nonneg_check'
  )
ORDER BY c.conname;

-- Any other CHECKs on StripePayment (for drift detection; names + defs only)
SELECT
  c.conname AS constraint_name,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'StripePayment'
  AND c.contype = 'c'
ORDER BY c.conname;

-- -----------------------------------------------------------------------------
-- 3) StripeRefundRequest table, enums, FK, unique, indexes
-- -----------------------------------------------------------------------------
SELECT EXISTS (
  SELECT 1
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name = 'StripeRefundRequest'
) AS stripe_refund_request_table_exists;

SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'StripeRefundRequest'
ORDER BY ordinal_position;

-- Enums RefundPurpose / StripeRefundRequestStatus
SELECT
  t.typname AS enum_name,
  e.enumlabel AS enum_value,
  e.enumsortorder
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typname IN ('RefundPurpose', 'StripeRefundRequestStatus')
ORDER BY t.typname, e.enumsortorder;

-- Primary key + CHECK on StripeRefundRequest
SELECT
  c.conname AS constraint_name,
  c.contype AS constraint_type,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'StripeRefundRequest'
  AND c.contype IN ('p', 'c', 'f', 'u')
ORDER BY c.contype, c.conname;

-- Foreign keys (expect StripeRefundRequest_stripePaymentId_fkey → StripePayment)
SELECT
  tc.constraint_name,
  kcu.column_name,
  ccu.table_name AS foreign_table_name,
  ccu.column_name AS foreign_column_name,
  rc.delete_rule,
  rc.update_rule
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
 AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
 AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints AS rc
  ON rc.constraint_name = tc.constraint_name
 AND rc.constraint_schema = tc.table_schema
WHERE tc.table_schema = 'public'
  AND tc.table_name = 'StripeRefundRequest'
  AND tc.constraint_type = 'FOREIGN KEY'
ORDER BY tc.constraint_name;

-- Indexes (unique + non-unique)
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'StripeRefundRequest'
ORDER BY indexname;

-- -----------------------------------------------------------------------------
-- 4) WebhookEvent claim-lease + dead-letter fields, enum, CHECKs, indexes
-- -----------------------------------------------------------------------------
SELECT
  column_name,
  data_type,
  udt_name,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'WebhookEvent'
  AND column_name IN (
    'status',
    'claimToken',
    'claimExpiresAt',
    'claimGeneration',
    'attemptCount',
    'lastErrorCode',
    'lastAttemptAt',
    'deadLetterReason',
    'deadLetteredAt',
    -- legacy columns retained by design:
    'processed',
    'processedAt',
    'error'
  )
ORDER BY column_name;

SELECT
  t.typname AS enum_name,
  e.enumlabel AS enum_value,
  e.enumsortorder
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = 'public'
  AND t.typname = 'WebhookEventStatus'
ORDER BY e.enumsortorder;

-- Expected CHECKs from 20261023130000_…
SELECT
  c.conname AS constraint_name,
  pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public'
  AND t.relname = 'WebhookEvent'
  AND c.contype = 'c'
ORDER BY c.conname;

-- Status-related indexes (claim / recovery)
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'WebhookEvent'
  AND (
    indexname IN (
      'WebhookEvent_status_claimExpiresAt_idx',
      'WebhookEvent_status_createdAt_idx',
      'WebhookEvent_status_lastAttemptAt_idx'
    )
    OR indexdef ILIKE '%status%'
  )
ORDER BY indexname;

-- -----------------------------------------------------------------------------
-- 5) Quick presence matrix (single-row summary for handoff)
-- -----------------------------------------------------------------------------
SELECT
  (SELECT COUNT(*) FROM "_prisma_migrations"
     WHERE migration_name = '20261023120000_stripe_refund_allocations_and_requests'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS mig_120000_finished,
  (SELECT COUNT(*) FROM "_prisma_migrations"
     WHERE migration_name = '20261023130000_webhook_event_claim_leases'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS mig_130000_finished,
  (SELECT COUNT(*) FROM "_prisma_migrations"
     WHERE migration_name = '20261023140000_webhook_recovery_dead_letter_columns'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS mig_140000_finished,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'StripePayment'
       AND column_name = 'rentalAmountCents') AS col_rentalAmountCents,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'StripePayment'
       AND column_name = 'depositAmountCents') AS col_depositAmountCents,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'StripePayment'
       AND column_name = 'rentalRefundedCents') AS col_rentalRefundedCents,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'StripePayment'
       AND column_name = 'depositRefundedCents') AS col_depositRefundedCents,
  (SELECT COUNT(*) FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'StripeRefundRequest') AS table_StripeRefundRequest,
  (SELECT COUNT(*) FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'RefundPurpose') AS enum_RefundPurpose,
  (SELECT COUNT(*) FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'StripeRefundRequestStatus') AS enum_StripeRefundRequestStatus,
  (SELECT COUNT(*) FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'public' AND t.typname = 'WebhookEventStatus') AS enum_WebhookEventStatus,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'WebhookEvent'
       AND column_name = 'status') AS col_webhook_status,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'WebhookEvent'
       AND column_name = 'claimToken') AS col_claimToken,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'WebhookEvent'
       AND column_name = 'deadLetterReason') AS col_deadLetterReason,
  (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'WebhookEvent'
       AND column_name = 'deadLetteredAt') AS col_deadLetteredAt;

-- End of read-only inspection script.
