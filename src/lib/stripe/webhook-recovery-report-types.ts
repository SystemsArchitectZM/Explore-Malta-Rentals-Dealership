/**
 * Pure (dependency-free) types and constants for the webhook recovery diagnostic
 * report. The SELECT-only queries that populate them live in webhook-recovery-store.ts.
 */

import type { ClaimProtocolCutover } from "./webhook-recovery-policy";

export const WEBHOOK_REPORT_CATEGORIES = [
  "ACTIVE_CLAIM",
  /** Stage 3.23: temporarily excluded from AUTOMATIC recovery; needs controlled review. */
  "EXCLUDED_EVENT_TYPE",
  "EXPIRED_CLAIM",
  "RETRYABLE_FAILED",
  /** RETRYABLE_FAILED with claimGeneration = 0 (pre-claim-protocol). Never auto-recovered. */
  "LEGACY_RETRYABLE",
  /** claimGeneration = 0 and not provably claim-era (legacy, or cutover unset/invalid). Never auto-recovered. */
  "LEGACY_UNCLAIMED",
  /** Never-claimed RECEIVED row created at/after a valid cutover: eligible for recovery. */
  "RECEIVED_CLAIM_ERA",
  "DEAD_LETTER_RETRY_LIMIT",
  "DEAD_LETTER_PERMANENT",
] as const;
export type WebhookReportCategory = (typeof WEBHOOK_REPORT_CATEGORIES)[number];

export const REPORT_DEFAULT_SAMPLE_LIMIT = 25;
export const REPORT_MAX_SAMPLE_LIMIT = 100;

export type WebhookRecoveryReportCounts = {
  /** PROCESSING with an unexpired lease: a worker may be running. Never touched. */
  activeClaims: number;
  /** PROCESSING, claimGeneration >= 1, expired/null lease, not an excluded type: eligible for a NEW claim attempt (not proof the old handler stopped). */
  expiredClaims: number;
  /** RETRYABLE_FAILED claimed under the lease protocol (not an excluded type). */
  retryableFailed: number;
  /** ...of which old enough for recovery (>= minRetryAgeSeconds since last attempt). */
  retryableFailedEligibleNow: number;
  /** Retryable/expired events one attempt short of the limit (excluded types omitted). */
  nearRetryLimit: number;
  /** Retryable/expired events at/over the limit: the next claim dead-letters them (excluded types omitted). */
  atRetryLimit: number;
  /** RETRYABLE_FAILED never claimed under leases (legacy backfill). NOT auto-recovered. */
  legacyRetryable: number;
  /**
   * claimGeneration = 0 rows that are stale (expired PROCESSING, or RECEIVED older than
   * minRetryAgeSeconds) and NOT provably claim-era: pre-cutover, or cutover unset/invalid
   * (fail closed). NOT auto-recovered; need controlled operator review.
   */
  legacyUnclaimed: number;
  /** Stale never-claimed RECEIVED rows created at/after a valid cutover. Eligible for recovery. */
  receivedClaimEraEligible: number;
  /**
   * Unprocessed rows of an automatic-recovery-EXCLUDED event type that recovery would
   * otherwise consider (RETRYABLE_FAILED, expired PROCESSING, stale RECEIVED). Not
   * discarded, not marked processed: awaiting controlled review.
   */
  excludedEventTypePending: number;
  /** DEAD_LETTER because the retry limit was reached (original failure evidence on the row). */
  deadLetterRetryLimit: number;
  /** DEAD_LETTER with any other reason (permanent classification or legacy). Needs ADMIN review. */
  deadLetterPermanent: number;
};

export type WebhookRecoveryReportSample = {
  stripeEventId: string;
  eventType: string;
  status: string;
  category: WebhookReportCategory;
  attemptCount: number;
  claimGeneration: number;
  lastErrorCode: string | null;
  deadLetterReason: string | null;
  createdAt: string | null;
  lastAttemptAt: string | null;
  claimExpiresAt: string | null;
};

export type WebhookRecoveryReport = {
  maxAttempts: number;
  minRetryAgeSeconds: number;
  /**
   * How the claim-protocol cutover was interpreted. "unset"/"invalid" => fail closed:
   * claimGeneration = 0 rows are reported as legacy and never recovered automatically.
   */
  claimProtocolCutover: ClaimProtocolCutover;
  counts: WebhookRecoveryReportCounts;
  samples: WebhookRecoveryReportSample[];
};
