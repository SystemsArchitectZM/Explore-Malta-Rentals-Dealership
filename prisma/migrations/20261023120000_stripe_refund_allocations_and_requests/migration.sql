-- Migration: stripe_refund_allocations_and_requests
-- Additive schema for rental/deposit payment allocations and durable refund requests.
-- Does NOT invent historical deposit allocations or duplicate StripeRefund rows into requests.
-- Does NOT mutate existing StripeRefund rows or combined refundedAmountCents totals.

-- ── Enums ──────────────────────────────────────────────────────────────────────

CREATE TYPE "RefundPurpose" AS ENUM (
  'RENTAL',
  'SECURITY_DEPOSIT',
  'UNSPECIFIED'
);

CREATE TYPE "StripeRefundRequestStatus" AS ENUM (
  'PENDING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED'
);

-- ── StripePayment allocation columns ───────────────────────────────────────────
-- Add nullable rentalAmountCents first, backfill, then enforce NOT NULL.
-- deposit / purpose-refunded columns default to 0 for history and new rows.

ALTER TABLE "StripePayment"
  ADD COLUMN "rentalAmountCents" INTEGER,
  ADD COLUMN "depositAmountCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rentalRefundedCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "depositRefundedCents" INTEGER NOT NULL DEFAULT 0;

-- Historical payments: entire charge is rental; no invented online deposit allocation.
UPDATE "StripePayment"
SET
  "rentalAmountCents" = "amountCents",
  "depositAmountCents" = 0,
  "rentalRefundedCents" = 0,
  "depositRefundedCents" = 0;

ALTER TABLE "StripePayment"
  ALTER COLUMN "rentalAmountCents" SET NOT NULL;

-- Allocation and non-negativity invariants (service still enforces pending + purpose caps).
ALTER TABLE "StripePayment"
  ADD CONSTRAINT "StripePayment_allocation_sum_check"
    CHECK ("rentalAmountCents" + "depositAmountCents" = "amountCents"),
  ADD CONSTRAINT "StripePayment_rentalAmountCents_nonneg_check"
    CHECK ("rentalAmountCents" >= 0),
  ADD CONSTRAINT "StripePayment_depositAmountCents_nonneg_check"
    CHECK ("depositAmountCents" >= 0),
  ADD CONSTRAINT "StripePayment_rentalRefundedCents_nonneg_check"
    CHECK ("rentalRefundedCents" >= 0),
  ADD CONSTRAINT "StripePayment_depositRefundedCents_nonneg_check"
    CHECK ("depositRefundedCents" >= 0),
  ADD CONSTRAINT "StripePayment_refundedAmountCents_nonneg_check"
    CHECK ("refundedAmountCents" >= 0);

-- ── StripeRefundRequest ────────────────────────────────────────────────────────
-- Durable claim/reservation identity (clientRequestId) independent of Stripe refund id.
-- stripeRefundId is nullable until Stripe returns a real id; never fabricate values.
-- No FK to StripeRefund.stripeRefundId: avoids create-order coupling with webhook upserts;
-- uniqueness still prevents two requests claiming the same Stripe refund id.

CREATE TABLE "StripeRefundRequest" (
  "id"              TEXT NOT NULL,
  "stripePaymentId" TEXT NOT NULL,
  "clientRequestId" TEXT NOT NULL,
  "purpose"         "RefundPurpose" NOT NULL,
  "amountCents"     INTEGER NOT NULL,
  "status"          "StripeRefundRequestStatus" NOT NULL DEFAULT 'PENDING',
  "stripeRefundId"  TEXT,
  "initiatedBy"     TEXT,
  "notes"           TEXT,
  "metadata"        JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StripeRefundRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StripeRefundRequest_amountCents_positive_check"
    CHECK ("amountCents" > 0)
);

CREATE UNIQUE INDEX "StripeRefundRequest_clientRequestId_key"
  ON "StripeRefundRequest"("clientRequestId");

CREATE UNIQUE INDEX "StripeRefundRequest_stripeRefundId_key"
  ON "StripeRefundRequest"("stripeRefundId");

CREATE INDEX "StripeRefundRequest_stripePaymentId_idx"
  ON "StripeRefundRequest"("stripePaymentId");

CREATE INDEX "StripeRefundRequest_stripePaymentId_status_idx"
  ON "StripeRefundRequest"("stripePaymentId", "status");

CREATE INDEX "StripeRefundRequest_stripePaymentId_purpose_status_idx"
  ON "StripeRefundRequest"("stripePaymentId", "purpose", "status");

ALTER TABLE "StripeRefundRequest"
  ADD CONSTRAINT "StripeRefundRequest_stripePaymentId_fkey"
  FOREIGN KEY ("stripePaymentId") REFERENCES "StripePayment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Intentionally no backfill of StripeRefund → StripeRefundRequest.
-- Existing StripeRefund rows keep their Stripe IDs and remain the historical mirror.
-- Future allocation/reconciliation must treat unmatched historical StripeRefunds as
-- UNSPECIFIED for purpose caps (service-level), without inventing request rows here.
