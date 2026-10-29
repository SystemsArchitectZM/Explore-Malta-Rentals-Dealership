/**
 * PostgreSQL READ-ONLY queries for webhook recovery (Stage 3.21, hardened in 3.23).
 *
 * Every statement in this file is a SELECT. Nothing here claims, releases, resets or
 * otherwise mutates a WebhookEvent row; all mutation goes through the fenced
 * WebhookEventStore methods used by the orchestrator. Candidate selection is advisory:
 * a row listed here may be claimed by another worker (or processed) before recovery
 * reaches it, and the claim in the orchestrator is what decides ownership AND
 * re-enforces the same eligibility predicate atomically (webhook-event-store.ts).
 *
 * Time source: the database clock (`NOW() AT TIME ZONE 'UTC'`), same as the claim.
 *
 * UNVERIFIED against a real database in this stage (no DB access was permitted):
 * column names come from prisma/schema.prisma and migrations
 * 20261023130000_* / 20261023140000_*. `payload` is assumed to be returned by
 * `$queryRaw` already parsed from jsonb; recovery treats a non-object payload as the
 * permanent EVENT_PAYLOAD_INVALID, so a different driver representation fails safe
 * (dead-letter for review) rather than running a handler on bad input. The
 * `::text::timestamptz` cutover comparison is likewise unexecuted. When
 * `RECOVERY_EXCLUDED_EVENT_TYPES` is non-empty again, reintroduce a
 * `"payload"->>'type'` exclusion check in eligibility/report SQL (never project
 * full `payload` from the reporter).
 */

import { prisma } from "@/lib/prisma";

import type { WebhookRecoveryCandidate } from "./webhook-recovery";
import {
  REPORT_MAX_SAMPLE_LIMIT,
  type WebhookRecoveryReport,
  type WebhookRecoveryReportCounts,
  type WebhookReportCategory,
} from "./webhook-recovery-report-types";
import type { ClaimProtocolCutover } from "./webhook-recovery-policy";

/** Minimal structural client so tests can inject a fake that rejects writes. */
export type WebhookRecoveryDbClient = Pick<typeof prisma, "$queryRaw">;

type CandidateRow = {
  stripeEventId: string;
  eventType: string;
  status: string;
  attemptCount: number;
  payload: unknown;
};

/**
 * Eligibility (Stage 3.23). processed=false AND one of:
 *   - PROCESSING, claimGeneration >= 1, expired (or null) lease on the database clock;
 *   - RETRYABLE_FAILED, claimGeneration >= 1, last attempt at least `minRetryAgeSeconds` old;
 *   - RECEIVED, claimGeneration = 0, created at/after a VALID claim-protocol cutover and
 *     at least `minRetryAgeSeconds` old (never-claimed row from the claim-protocol era).
 * Never selected: DEAD_LETTER, PROCESSED, active leases, and claimGeneration = 0 rows
 * that cannot be proven claim-era (legacy / cutover unset or invalid => fail closed).
 *
 * When `RECOVERY_EXCLUDED_EVENT_TYPES` is non-empty, a NOT (column OR payload.type IN …)
 * clause is added here and in `claimForRecovery` (and mirrored in the report
 * `isExcluded` flag). The list is currently empty: PI failed/canceled recovery is
 * safe because redispatches reuse the Step 11 attempt-scoped handler.
 *
 * The text between the recovery-eligibility markers MUST stay textually identical (modulo
 * whitespace) to the predicate in webhook-event-store.ts `claimForRecovery`; the static
 * suite asserts this so the advisory list and the atomic claim cannot drift.
 *
 * Events at/over the attempt limit are intentionally still selected: claiming them
 * makes the orchestrator dead-letter them (RETRY_LIMIT_EXCEEDED) without running a
 * handler, with the original failure evidence preserved.
 */
export function createWebhookRecoveryCandidateLister(client: WebhookRecoveryDbClient = prisma) {
  return async function listCandidates(input: {
    limit: number;
    minRetryAgeSeconds: number;
    claimProtocolCutoverIso: string | null;
  }): Promise<WebhookRecoveryCandidate[]> {
    const minRetryAgeSeconds = input.minRetryAgeSeconds;
    const claimProtocolCutoverIso = input.claimProtocolCutoverIso;
    const rows = await client.$queryRaw<CandidateRow[]>`
      SELECT
        "stripeEventId" AS "stripeEventId",
        "eventType"     AS "eventType",
        "status"::text  AS "status",
        "attemptCount"  AS "attemptCount",
        "payload"       AS "payload"
      FROM "WebhookEvent"
      WHERE "processed" = false
        AND
        /* recovery-eligibility:start */
        (
          (
            "status" = 'PROCESSING'::"WebhookEventStatus"
            AND "claimGeneration" >= 1
            AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= (NOW() AT TIME ZONE 'UTC'))
          )
          OR (
            "status" = 'RETRYABLE_FAILED'::"WebhookEventStatus"
            AND "claimGeneration" >= 1
            AND ("lastAttemptAt" IS NULL OR "lastAttemptAt" <= (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${minRetryAgeSeconds}::double precision))
          )
          OR (
            ${claimProtocolCutoverIso}::text IS NOT NULL
            AND "status" = 'RECEIVED'::"WebhookEventStatus"
            AND "claimGeneration" = 0
            AND "createdAt" >= ((${claimProtocolCutoverIso}::text)::timestamptz AT TIME ZONE 'UTC')
            AND "createdAt" <= (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${minRetryAgeSeconds}::double precision)
          )
        )
        /* recovery-eligibility:end */
      ORDER BY "lastAttemptAt" ASC NULLS FIRST, "createdAt" ASC
      LIMIT ${input.limit}::int
    `;
    return rows.map((row) => ({
      stripeEventId: row.stripeEventId,
      eventType: row.eventType,
      status:
        row.status === "PROCESSING"
          ? "PROCESSING"
          : row.status === "RECEIVED"
            ? "RECEIVED"
            : "RETRYABLE_FAILED",
      attemptCount: Number(row.attemptCount),
      payload: row.payload,
    }));
  };
}

// ─── Read-only diagnostics ─────────────────────────────────────────────────────

type CountsRow = Record<keyof WebhookRecoveryReportCounts, bigint | number>;
type SampleRow = {
  stripeEventId: string;
  eventType: string;
  status: string;
  category: string;
  attemptCount: number;
  claimGeneration: number;
  lastErrorCode: string | null;
  deadLetterReason: string | null;
  createdAt: Date | null;
  lastAttemptAt: Date | null;
  claimExpiresAt: Date | null;
};

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * Operator report. SELECT-only; never exposes `payload` or any secret. With an empty
 * `RECOVERY_EXCLUDED_EVENT_TYPES`, `isExcluded` is the constant FALSE (no payload read).
 * When the exclusion list is non-empty again, reintroduce the column/payload.type OR
 * expression here (never project `payload` itself). `error` text is not selected either,
 * only the stable `lastErrorCode` / `deadLetterReason` codes.
 *
 * Partition (each unprocessed non-terminal row lands in exactly one sample category):
 *   ACTIVE_CLAIM > EXCLUDED_EVENT_TYPE > LEGACY_RETRYABLE > LEGACY_UNCLAIMED >
 *   RECEIVED_CLAIM_ERA > EXPIRED_CLAIM > RETRYABLE_FAILED; dead letters by reason.
 * "Legacy/unclaimed" = claimGeneration = 0 rows that are NOT provably claim-era; they are
 * never auto-recovered and need controlled operator review.
 */
export function createWebhookRecoveryReporter(client: WebhookRecoveryDbClient = prisma) {
  return async function loadReport(input: {
    maxAttempts: number;
    minRetryAgeSeconds: number;
    sampleLimit: number;
    category?: WebhookReportCategory;
    claimProtocolCutover: ClaimProtocolCutover;
  }): Promise<WebhookRecoveryReport> {
    const { maxAttempts, minRetryAgeSeconds, claimProtocolCutover } = input;
    const claimProtocolCutoverIso = claimProtocolCutover.value;
    const sampleLimit = Math.min(REPORT_MAX_SAMPLE_LIMIT, Math.max(1, Math.trunc(input.sampleLimit)));
    const category = input.category ?? null;

    const countRows = await client.$queryRaw<CountsRow[]>`
      SELECT
        COUNT(*) FILTER (WHERE w."status" = 'PROCESSING'::"WebhookEventStatus"
          AND w."claimExpiresAt" IS NOT NULL AND w."claimExpiresAt" > (NOW() AT TIME ZONE 'UTC')) AS "activeClaims",
        COUNT(*) FILTER (WHERE w."status" = 'PROCESSING'::"WebhookEventStatus"
          AND (w."claimExpiresAt" IS NULL OR w."claimExpiresAt" <= (NOW() AT TIME ZONE 'UTC'))
          AND w."claimGeneration" >= 1 AND NOT w."isExcluded") AS "expiredClaims",
        COUNT(*) FILTER (WHERE w."status" = 'RETRYABLE_FAILED'::"WebhookEventStatus"
          AND w."claimGeneration" >= 1 AND NOT w."isExcluded") AS "retryableFailed",
        COUNT(*) FILTER (WHERE w."status" = 'RETRYABLE_FAILED'::"WebhookEventStatus"
          AND w."claimGeneration" >= 1 AND NOT w."isExcluded"
          AND (w."lastAttemptAt" IS NULL
            OR w."lastAttemptAt" <= (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${minRetryAgeSeconds}::double precision))) AS "retryableFailedEligibleNow",
        COUNT(*) FILTER (WHERE w."status" IN ('PROCESSING'::"WebhookEventStatus", 'RETRYABLE_FAILED'::"WebhookEventStatus")
          AND w."claimGeneration" >= 1 AND NOT w."isExcluded"
          AND w."attemptCount" = ${maxAttempts}::int - 1) AS "nearRetryLimit",
        COUNT(*) FILTER (WHERE w."status" IN ('PROCESSING'::"WebhookEventStatus", 'RETRYABLE_FAILED'::"WebhookEventStatus")
          AND w."claimGeneration" >= 1 AND NOT w."isExcluded"
          AND w."attemptCount" >= ${maxAttempts}::int) AS "atRetryLimit",
        COUNT(*) FILTER (WHERE w."status" = 'RETRYABLE_FAILED'::"WebhookEventStatus"
          AND w."claimGeneration" = 0 AND NOT w."isExcluded") AS "legacyRetryable",
        COUNT(*) FILTER (WHERE w."claimGeneration" = 0 AND NOT w."isExcluded"
          AND (
            (w."status" = 'PROCESSING'::"WebhookEventStatus"
              AND (w."claimExpiresAt" IS NULL OR w."claimExpiresAt" <= (NOW() AT TIME ZONE 'UTC')))
            OR (w."status" = 'RECEIVED'::"WebhookEventStatus"
              AND w."createdAt" <= (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${minRetryAgeSeconds}::double precision)
              AND NOT w."isClaimEra")
          )) AS "legacyUnclaimed",
        COUNT(*) FILTER (WHERE w."status" = 'RECEIVED'::"WebhookEventStatus"
          AND w."claimGeneration" = 0 AND NOT w."isExcluded" AND w."isClaimEra"
          AND w."createdAt" <= (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${minRetryAgeSeconds}::double precision)) AS "receivedClaimEraEligible",
        COUNT(*) FILTER (WHERE w."isExcluded"
          AND (
            w."status" = 'RETRYABLE_FAILED'::"WebhookEventStatus"
            OR (w."status" = 'PROCESSING'::"WebhookEventStatus"
              AND (w."claimExpiresAt" IS NULL OR w."claimExpiresAt" <= (NOW() AT TIME ZONE 'UTC')))
            OR (w."status" = 'RECEIVED'::"WebhookEventStatus"
              AND w."createdAt" <= (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${minRetryAgeSeconds}::double precision))
          )) AS "excludedEventTypePending",
        COUNT(*) FILTER (WHERE w."status" = 'DEAD_LETTER'::"WebhookEventStatus"
          AND w."deadLetterReason" = 'RETRY_LIMIT_EXCEEDED') AS "deadLetterRetryLimit",
        COUNT(*) FILTER (WHERE w."status" = 'DEAD_LETTER'::"WebhookEventStatus"
          AND w."deadLetterReason" IS DISTINCT FROM 'RETRY_LIMIT_EXCEEDED') AS "deadLetterPermanent"
      FROM (
        SELECT
          "status", "claimGeneration", "attemptCount", "claimExpiresAt", "lastAttemptAt",
          "createdAt", "deadLetterReason",
          FALSE AS "isExcluded",
          (
            ${claimProtocolCutoverIso}::text IS NOT NULL
            AND "createdAt" >= ((${claimProtocolCutoverIso}::text)::timestamptz AT TIME ZONE 'UTC')
          ) AS "isClaimEra"
        FROM "WebhookEvent"
        WHERE "processed" = false
      ) AS w
    `;
    const c = countRows[0];
    const counts: WebhookRecoveryReportCounts = {
      activeClaims: Number(c?.activeClaims ?? 0),
      expiredClaims: Number(c?.expiredClaims ?? 0),
      retryableFailed: Number(c?.retryableFailed ?? 0),
      retryableFailedEligibleNow: Number(c?.retryableFailedEligibleNow ?? 0),
      nearRetryLimit: Number(c?.nearRetryLimit ?? 0),
      atRetryLimit: Number(c?.atRetryLimit ?? 0),
      legacyRetryable: Number(c?.legacyRetryable ?? 0),
      legacyUnclaimed: Number(c?.legacyUnclaimed ?? 0),
      receivedClaimEraEligible: Number(c?.receivedClaimEraEligible ?? 0),
      excludedEventTypePending: Number(c?.excludedEventTypePending ?? 0),
      deadLetterRetryLimit: Number(c?.deadLetterRetryLimit ?? 0),
      deadLetterPermanent: Number(c?.deadLetterPermanent ?? 0),
    };

    const sampleRows = await client.$queryRaw<SampleRow[]>`
      SELECT * FROM (
        SELECT
          s."stripeEventId"        AS "stripeEventId",
          s."eventType"            AS "eventType",
          s."status"::text         AS "status",
          CASE
            WHEN s."status" = 'PROCESSING'::"WebhookEventStatus"
              AND s."claimExpiresAt" IS NOT NULL AND s."claimExpiresAt" > (NOW() AT TIME ZONE 'UTC') THEN 'ACTIVE_CLAIM'
            WHEN s."isExcluded" AND s."status" <> 'DEAD_LETTER'::"WebhookEventStatus" THEN 'EXCLUDED_EVENT_TYPE'
            WHEN s."status" = 'RETRYABLE_FAILED'::"WebhookEventStatus" AND s."claimGeneration" = 0 THEN 'LEGACY_RETRYABLE'
            WHEN s."status" = 'PROCESSING'::"WebhookEventStatus" AND s."claimGeneration" = 0 THEN 'LEGACY_UNCLAIMED'
            WHEN s."status" = 'RECEIVED'::"WebhookEventStatus" AND NOT s."isClaimEra" THEN 'LEGACY_UNCLAIMED'
            WHEN s."status" = 'RECEIVED'::"WebhookEventStatus" THEN 'RECEIVED_CLAIM_ERA'
            WHEN s."status" = 'PROCESSING'::"WebhookEventStatus" THEN 'EXPIRED_CLAIM'
            WHEN s."status" = 'RETRYABLE_FAILED'::"WebhookEventStatus" THEN 'RETRYABLE_FAILED'
            WHEN s."status" = 'DEAD_LETTER'::"WebhookEventStatus" AND s."deadLetterReason" = 'RETRY_LIMIT_EXCEEDED' THEN 'DEAD_LETTER_RETRY_LIMIT'
            WHEN s."status" = 'DEAD_LETTER'::"WebhookEventStatus" THEN 'DEAD_LETTER_PERMANENT'
            ELSE 'OTHER'
          END                      AS "category",
          s."attemptCount"         AS "attemptCount",
          s."claimGeneration"      AS "claimGeneration",
          s."lastErrorCode"        AS "lastErrorCode",
          s."deadLetterReason"     AS "deadLetterReason",
          s."createdAt"            AS "createdAt",
          s."lastAttemptAt"        AS "lastAttemptAt",
          s."claimExpiresAt"       AS "claimExpiresAt"
        FROM (
          SELECT
            "stripeEventId", "eventType", "status", "attemptCount", "claimGeneration",
            "lastErrorCode", "deadLetterReason", "createdAt", "lastAttemptAt", "claimExpiresAt",
            FALSE AS "isExcluded",
            (
              ${claimProtocolCutoverIso}::text IS NOT NULL
              AND "createdAt" >= ((${claimProtocolCutoverIso}::text)::timestamptz AT TIME ZONE 'UTC')
            ) AS "isClaimEra"
          FROM "WebhookEvent"
          WHERE "processed" = false
            AND NOT (
              "status" = 'RECEIVED'::"WebhookEventStatus"
              AND "createdAt" > (NOW() AT TIME ZONE 'UTC') - make_interval(secs => ${minRetryAgeSeconds}::double precision)
            )
        ) AS s
      ) AS t
      WHERE (${category}::text IS NULL OR t."category" = ${category}::text)
      ORDER BY t."createdAt" ASC
      LIMIT ${sampleLimit}::int
    `;

    return {
      maxAttempts,
      minRetryAgeSeconds,
      claimProtocolCutover,
      counts,
      samples: sampleRows.map((row) => ({
        stripeEventId: row.stripeEventId,
        eventType: row.eventType,
        status: row.status,
        category: row.category as WebhookReportCategory,
        attemptCount: Number(row.attemptCount),
        claimGeneration: Number(row.claimGeneration),
        lastErrorCode: row.lastErrorCode,
        deadLetterReason: row.deadLetterReason,
        createdAt: iso(row.createdAt),
        lastAttemptAt: iso(row.lastAttemptAt),
        claimExpiresAt: iso(row.claimExpiresAt),
      })),
    };
  };
}
