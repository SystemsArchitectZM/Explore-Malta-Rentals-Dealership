/**
 * PostgreSQL implementation of WebhookEventStore using single-statement conditional
 * operations. Parameterized SQL only (tagged templates). Table/enum identifiers are
 * taken from prisma/schema.prisma + migrations 20261023130000_webhook_event_claim_leases
 * and 20261023140000_webhook_recovery_dead_letter_columns:
 *   table "WebhookEvent", enum "WebhookEventStatus".
 *
 * Time source: the DATABASE clock (`NOW() AT TIME ZONE 'UTC'`, matching how Prisma
 * stores TIMESTAMP(3) values), so leases are immune to application-server clock skew.
 *
 * Raw SQL is used for the new columns so this file does not depend on the generated
 * Prisma client having been regenerated.
 *
 * UNVERIFIED: the concurrency semantics below rely on PostgreSQL READ COMMITTED
 * behaviour (a `SELECT ... FOR UPDATE` in the CTE re-evaluates its WHERE clause after
 * waiting on a concurrent claim, so the loser matches zero rows). That has NOT been
 * exercised against a real database in this stage. See
 * docs/stripe-webhook-reliability.md for the required integration tests.
 */

import { Prisma } from "@/generated/prisma";
import { prisma } from "@/lib/prisma";

import type {
  WebhookClaim,
  WebhookDeadLetterRecord,
  WebhookEventRecordInput,
  WebhookEventState,
  WebhookEventStore,
  WebhookFailureRecord,
  WebhookRecoveryClaimOptions,
} from "./webhook-event-claim";
import type { WebhookEventStatusValue } from "./types";

type ClaimRow = {
  id: string;
  claimGeneration: number;
  attemptCount: number;
  previousStatus: string;
};

type StateRow = {
  status: string;
  processed: boolean;
  leaseActive: boolean;
};

/**
 * Recovery-only claim (Stage 3.23). Same single conditional UPDATE shape as the live
 * claim — CTE `SELECT ... FOR UPDATE` feeding `UPDATE ... RETURNING`, DB-clock lease,
 * claimGeneration/attemptCount increments, fresh claimToken — but the candidate WHERE
 * is the recovery eligibility predicate INSTEAD of the broader live predicate. The
 * predicate is strictly narrower than the live one (it re-requires an expired lease for
 * PROCESSING, enforces the retry backoff for RETRYABLE_FAILED, and never touches
 * generation-0 rows unless a valid cutover proves the row was created under the claim
 * protocol). When `RECOVERY_EXCLUDED_EVENT_TYPES` is non-empty, the same exclusion OR is
 * applied here and in the advisory lister. Because it is evaluated inside the locked
 * statement, a candidate that became ineligible after selection matches zero rows and
 * consumes no attempt.
 *
 * The predicate text between the markers MUST stay textually identical to the one in
 * webhook-recovery-store.ts (asserted by scripts/test-webhook-recovery.ts).
 *
 * UNVERIFIED against PostgreSQL: relies on READ COMMITTED re-evaluation of the WHERE
 * clause after the row lock, like the live claim.
 */
async function claimForRecovery(
  client: typeof prisma,
  input: {
    stripeEventId: string;
    claimToken: string;
    leaseSeconds: number;
    recovery: WebhookRecoveryClaimOptions;
  },
): Promise<WebhookClaim | null> {
  const { stripeEventId, claimToken, leaseSeconds } = input;
  const minRetryAgeSeconds = input.recovery.minRetryAgeSeconds;
  const claimProtocolCutoverIso = input.recovery.claimProtocolCutoverIso;

  const rows = await client.$queryRaw<ClaimRow[]>`
    WITH candidate AS (
      SELECT "id", "status" AS "previousStatus"
      FROM "WebhookEvent"
      WHERE "stripeEventId" = ${stripeEventId}
        AND "processed" = false
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
      FOR UPDATE
    )
    UPDATE "WebhookEvent" AS w
    SET
      "status"          = 'PROCESSING'::"WebhookEventStatus",
      "claimToken"      = ${claimToken},
      "claimExpiresAt"  = (NOW() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSeconds}::double precision),
      "claimGeneration" = w."claimGeneration" + 1,
      "attemptCount"    = w."attemptCount" + 1,
      "lastAttemptAt"   = (NOW() AT TIME ZONE 'UTC')
    FROM candidate
    WHERE w."id" = candidate."id"
    RETURNING
      w."id" AS "id",
      w."claimGeneration" AS "claimGeneration",
      w."attemptCount" AS "attemptCount",
      candidate."previousStatus"::text AS "previousStatus"
  `;

  const row = rows[0];
  if (!row) return null;
  return {
    eventRowId: row.id,
    stripeEventId,
    claimToken,
    claimGeneration: Number(row.claimGeneration),
    attemptCount: Number(row.attemptCount),
    previousStatus: row.previousStatus as WebhookEventStatusValue,
  };
}

export function createPrismaWebhookEventStore(client: typeof prisma = prisma): WebhookEventStore {
  return {
    async ensureRecord(event: WebhookEventRecordInput): Promise<void> {
      // INSERT ... ON CONFLICT DO NOTHING (skipDuplicates). Never overwrites an existing
      // row and never claims. status/attempt columns take their DB defaults.
      await client.webhookEvent.createMany({
        data: [
          {
            id: crypto.randomUUID(),
            stripeEventId: event.id,
            eventType: event.type,
            processed: false,
            payload: event.payload as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
    },

    async tryClaim({ stripeEventId, claimToken, leaseSeconds, recovery }): Promise<WebhookClaim | null> {
      if (recovery) {
        return claimForRecovery(client, { stripeEventId, claimToken, leaseSeconds, recovery });
      }

      const rows = await client.$queryRaw<ClaimRow[]>`
        WITH candidate AS (
          SELECT "id", "status" AS "previousStatus"
          FROM "WebhookEvent"
          WHERE "stripeEventId" = ${stripeEventId}
            AND "processed" = false
            AND (
              "status" IN ('RECEIVED'::"WebhookEventStatus", 'RETRYABLE_FAILED'::"WebhookEventStatus")
              OR (
                "status" = 'PROCESSING'::"WebhookEventStatus"
                AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= (NOW() AT TIME ZONE 'UTC'))
              )
            )
          FOR UPDATE
        )
        UPDATE "WebhookEvent" AS w
        SET
          "status"          = 'PROCESSING'::"WebhookEventStatus",
          "claimToken"      = ${claimToken},
          "claimExpiresAt"  = (NOW() AT TIME ZONE 'UTC') + make_interval(secs => ${leaseSeconds}::double precision),
          "claimGeneration" = w."claimGeneration" + 1,
          "attemptCount"    = w."attemptCount" + 1,
          "lastAttemptAt"   = (NOW() AT TIME ZONE 'UTC')
        FROM candidate
        WHERE w."id" = candidate."id"
        RETURNING
          w."id" AS "id",
          w."claimGeneration" AS "claimGeneration",
          w."attemptCount" AS "attemptCount",
          candidate."previousStatus"::text AS "previousStatus"
      `;

      const row = rows[0];
      if (!row) return null;
      return {
        eventRowId: row.id,
        stripeEventId,
        claimToken,
        claimGeneration: Number(row.claimGeneration),
        attemptCount: Number(row.attemptCount),
        previousStatus: row.previousStatus as WebhookEventStatusValue,
      };
    },

    async readState(stripeEventId: string): Promise<WebhookEventState | null> {
      const rows = await client.$queryRaw<StateRow[]>`
        SELECT
          "status"::text AS "status",
          "processed" AS "processed",
          ("claimExpiresAt" IS NOT NULL AND "claimExpiresAt" > (NOW() AT TIME ZONE 'UTC')) AS "leaseActive"
        FROM "WebhookEvent"
        WHERE "stripeEventId" = ${stripeEventId}
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        status: row.status as WebhookEventStatusValue,
        processed: row.processed,
        leaseActive: row.leaseActive,
      };
    },

    async markProcessed(claim: WebhookClaim): Promise<boolean> {
      // Fenced on token AND generation. Keeps `error`/`lastErrorCode` as attempt history.
      const affected = await client.$executeRaw`
        UPDATE "WebhookEvent"
        SET
          "status"         = 'PROCESSED'::"WebhookEventStatus",
          "processed"      = true,
          "processedAt"    = (NOW() AT TIME ZONE 'UTC'),
          "claimToken"     = NULL,
          "claimExpiresAt" = NULL
        WHERE "id" = ${claim.eventRowId}
          AND "status" = 'PROCESSING'::"WebhookEventStatus"
          AND "claimToken" = ${claim.claimToken}
          AND "claimGeneration" = ${claim.claimGeneration}
      `;
      return affected === 1;
    },

    async releaseForRetry(claim: WebhookClaim, failure: WebhookFailureRecord): Promise<boolean> {
      const affected = await client.$executeRaw`
        UPDATE "WebhookEvent"
        SET
          "status"         = 'RETRYABLE_FAILED'::"WebhookEventStatus",
          "error"          = ${failure.message},
          "lastErrorCode"  = ${failure.code},
          "claimToken"     = NULL,
          "claimExpiresAt" = NULL
        WHERE "id" = ${claim.eventRowId}
          AND "status" = 'PROCESSING'::"WebhookEventStatus"
          AND "claimToken" = ${claim.claimToken}
          AND "claimGeneration" = ${claim.claimGeneration}
      `;
      return affected === 1;
    },

    async markDeadLetter(claim: WebhookClaim, record: WebhookDeadLetterRecord): Promise<boolean> {
      // COALESCE keeps the existing failure evidence when none is supplied (retry limit
      // reached at claim time). `deadLetterReason` always carries the stable reason.
      const message = record.message ?? null;
      const lastErrorCode = record.lastErrorCode ?? null;
      const affected = await client.$executeRaw`
        UPDATE "WebhookEvent"
        SET
          "status"           = 'DEAD_LETTER'::"WebhookEventStatus",
          "error"            = COALESCE(${message}::text, "error"),
          "lastErrorCode"    = COALESCE(${lastErrorCode}::text, "lastErrorCode"),
          "deadLetterReason" = ${record.reason},
          "deadLetteredAt"   = (NOW() AT TIME ZONE 'UTC'),
          "claimToken"     = NULL,
          "claimExpiresAt" = NULL
        WHERE "id" = ${claim.eventRowId}
          AND "status" = 'PROCESSING'::"WebhookEventStatus"
          AND "claimToken" = ${claim.claimToken}
          AND "claimGeneration" = ${claim.claimGeneration}
      `;
      return affected === 1;
    },
  };
}
