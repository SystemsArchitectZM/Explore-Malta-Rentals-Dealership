# Stripe webhook reliability (lease-based claims, durable recovery)

Status: implemented in source (Stages 3.19, 3.21 and 3.23 hardening), **not applied, not
generated, not run, not verified** against PostgreSQL, Stripe or any hosting platform. This document is a review aid, not a readiness
claim (neither staging nor production).

## Why

The previous `processWebhookEvent` read `WebhookEvent.processed`, upserted the row, ran the
handler, and only then marked the event processed. Two concurrent deliveries of the same
Stripe event id could both enter the handler, and the route returned HTTP 200 for many
incomplete failures (message-substring classification), so Stripe stopped retrying while
`processed` stayed `false`.

## State machine (`WebhookEvent.status`)

| State | Meaning |
|-------|---------|
| `RECEIVED` | Row exists, never claimed (or legacy unfinished row). Claimable by a live delivery. |
| `PROCESSING` | Claimed by one worker (`claimToken`) until `claimExpiresAt`. |
| `PROCESSED` | Handler finished and finalization recorded (`processed = true`). Terminal. Also used for intentionally ignored (unsupported) event types. |
| `RETRYABLE_FAILED` | Last attempt incomplete; lease released. Claimable by the next delivery or by recovery. |
| `DEAD_LETTER` | Terminal disposition recorded durably (documented permanent error, or attempt cap). Never retried automatically. `deadLetterReason` says why. |

```
(absent) -> RECEIVED
RECEIVED | RETRYABLE_FAILED | PROCESSING(lease expired) --atomic claim--> PROCESSING
PROCESSING --handler ok + fenced finalize--> PROCESSED
PROCESSING --retryable error--> RETRYABLE_FAILED   (or DEAD_LETTER when attemptCount >= max)
PROCESSING --documented permanent error--> DEAD_LETTER
PROCESSING --worker crash--> (lease expires) --> claimable again
claim with attemptCount > max --> DEAD_LETTER (RETRY_LIMIT_EXCEEDED), handler NOT run
```

Fields added in Stage 3.19: `status`, `claimToken`, `claimExpiresAt`, `claimGeneration`
(fencing), `attemptCount`, `lastErrorCode`, `lastAttemptAt`. Stage 3.21 adds
`deadLetterReason`, `deadLetteredAt` (new additive migration
`20261023140000_webhook_recovery_dead_letter_columns`; the Stage 3.19 migration is unchanged).
Legacy `processed`, `processedAt`, `error`, `payload` are retained.

### processed/status compatibility

- New code writes `processed = true` together with `status = 'PROCESSED'`.
- The Stage 3.19 migration enforces only the one-way rule `status = 'PROCESSED' => processed = true`.
  It deliberately does **not** forbid `processed = true` with a stale status, so rolled-back
  code that only sets `processed` never violates a constraint.
- New code treats `processed = true` as already processed regardless of `status` and the
  claim `WHERE` clause requires `processed = false`.

## Atomic claim and fencing

`src/lib/stripe/webhook-event-store.ts` (`createPrismaWebhookEventStore`):

1. `ensureRecord`: `createMany({ skipDuplicates: true })` (INSERT ... ON CONFLICT DO NOTHING).
   Never claims, never overwrites an existing row, never rewrites `payload`.
2. `tryClaim`: one statement — a CTE `SELECT ... FOR UPDATE` of the claimable row feeding an
   `UPDATE ... RETURNING`. Succeeds only when `processed = false` and the row is `RECEIVED`,
   `RETRYABLE_FAILED`, or `PROCESSING` with an expired lease. It increments `attemptCount`
   and `claimGeneration`, sets a new `claimToken`, and sets `claimExpiresAt` using the
   **database clock** (`NOW() AT TIME ZONE 'UTC'`), so application clock skew cannot grant
   overlapping leases.
3. `markProcessed` / `releaseForRetry` / `markDeadLetter`: single `UPDATE`s fenced on
   `status = 'PROCESSING' AND claimToken = $token AND claimGeneration = $generation`.
   A stale worker therefore updates zero rows and cannot overwrite a newer owner's status,
   error, or completion.

Claim results (`claimWebhookEvent`): `acquired`, `already_processed`, `dead_lettered`,
`in_flight` (valid lease held elsewhere), `unavailable` (row changed between statements ->
treated as retryable).

The claim statement and the finalize statements are each short single statements. No Stripe
network call occurs inside any transaction owned by this module.

### Critical limitation: a lease does not stop a running handler

If worker A's lease expires while A is still running, worker B can claim and run the same
handler. Fencing only protects the `WebhookEvent` row. Duplicate financial effects are
prevented **only** by handler idempotency, which this change leaves untouched:

- payment-row `FOR UPDATE` in refund webhook reconciliation and `charge.refunded`
- absolute SUCCEEDED recompute of refund counters
- stable Stripe idempotency keys, PENDING-before-Stripe reservations, purpose + combined caps
- unique `StripeRefund.stripeRefundId` / `StripeTransaction.stripeTransactionId`

**An expired lease is permission to attempt a new claim, not proof that the old handler
stopped.** This applies equally to live redelivery and to operator recovery.

Leases are not heartbeat-renewed (handlers are short DB transactions). Default lease is
300 s (clamped 60–1800 s), intentionally long relative to a handler. This design does **not**
provide exactly-once execution across PostgreSQL and Stripe; delivery is at-least-once with
idempotent handlers.

Known pre-existing handler caveat (unchanged): `confirmBookingPayment` does not take the
payment row lock; two concurrent runs can race on `StripeTransaction.stripeTransactionId`
(unique), causing one run to throw. That throw is retryable and the retry observes
`already_succeeded`.

## Typed outcomes and HTTP policy

`ProcessWebhookResult.outcome` -> HTTP (`src/lib/stripe/webhook-http-policy.ts`):

| Outcome | HTTP | Event state |
|---------|------|-------------|
| `processed` | 200 | `PROCESSED` |
| `ignored` (unsupported event type) | 200 | `PROCESSED` (terminal decision recorded first) |
| `already_processed` | 200 | unchanged |
| `in_flight` | **503** + `Retry-After: 30` (`WEBHOOK_IN_FLIGHT_HTTP_STATUS`) | unchanged (peer owns lease) |
| `permanent_failure` (dead-lettered) | 200 | `DEAD_LETTER` |
| `retryable_failure` | 500 | `RETRYABLE_FAILED`, or `PROCESSING` until lease expiry if release failed |
| missing/invalid signature, unreadable body | 400 | no row created |
| signing secret not configured | 500 | no row created |

### `in_flight` is 503 (Stage 3.21; previously 200)

The earlier 200 acknowledged a delivery that ran nothing and recorded nothing. If the lease
owner then died, Stripe could have stopped retrying while the event was still unprocessed
(audit finding F1). Now an in-flight duplicate gets a retryable `503` with a stable body
(`{ received: false, outcome: "in_flight", error: "EVENT_IN_FLIGHT" }`) and a `Retry-After`
header.

- The 503 is derived from a **read-only** observation of the row. It never changes the lease
  owner's state, never releases or steals its lease, and never runs a handler.
- `processed` (200 `already_processed`) and `DEAD_LETTER` (200) responses are unchanged.
- **Trade-off:** a retryable response can raise duplicate-delivery volume while a slow handler
  is still running, and a retry that lands after the lease expires can legitimately re-enter
  the handler. That is acceptable only because handler idempotency (above) is what actually
  protects financial state; the HTTP code is not a safety mechanism.
- Whether Stripe stops retrying after the first 2xx for an event is **unverified** here.
  Recovery below deliberately does not depend on Stripe redelivery at all.

Other notes:

- Stripe retries any non-2xx; a 400 for body/signature problems means "reject this delivery".
- Response bodies contain only stable codes (no stack traces, SQL, or secrets).
- Stripe's retry window is finite, so even with 503 an event can eventually stop being
  redelivered. Durable recovery is the answer to that, not the HTTP status.

### Failure classification (no message substrings)

`src/lib/stripe/webhook-errors.ts`:

- Only `WebhookPermanentError` (documented codes) is terminal:
  - `EVENT_METADATA_MISSING` (`checkout.session.completed` without booking identifiers)
  - `BOOKING_CANCELLED_PAYMENT_RECEIVED` (payment captured for a cancelled booking; the
    handler transaction rolls back; needs human decision)
  - `EVENT_PAYLOAD_INVALID` (stored payload has no usable `data.object`; only arises when
    recovery replays a corrupt stored row)
- Every other thrown value is retryable (fail closed). Structured infrastructure codes
  (Prisma `P1001/P1002/P1008/P1017/P2024/P2028/P2034`, PostgreSQL SQLSTATE `40001/40P01/
  55P03/57014/57P0x/08xxx/53xxx`, Node errno such as `ECONNREFUSED`) only add the
  `DB_TRANSIENT` label for observability.

### Retry limit and dead-lettering

- `STRIPE_WEBHOOK_MAX_ATTEMPTS`: default 8, **clamped 3–50** (Stage 3.21: the floor was 1, which
  let a config typo disable retries; 0, 1 and 2 now become 3).
- A retryable failure on the final allowed attempt, or any claim beyond the limit (crash
  loops, exhausted events found by recovery), becomes `DEAD_LETTER` with
  `deadLetterReason = RETRY_LIMIT_EXCEEDED`. A claim beyond the limit does not run the handler.
- **Evidence is preserved (F10):** `lastErrorCode` / `error` keep the *original* failure
  (`HANDLER_ERROR`, `DB_TRANSIENT`, `FINALIZE_FAILED`, ...). The dead-letter write only
  overwrites them when it carries a fresh failure of its own; otherwise it `COALESCE`s the
  existing values. The stable dead-letter reason lives in `deadLetterReason`.
- `DEAD_LETTER` is only reported once the fenced terminal write succeeded. If that write
  fails, the result is retryable (`DEAD_LETTER_PERSIST_FAILED`); the orchestrator then
  best-effort records the failure evidence through the fenced release so it is not lost.
  If that also fails the lease simply expires and the event stays recoverable.

Non-secret tuning variables: `STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS`, `STRIPE_WEBHOOK_MAX_ATTEMPTS`,
`STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS` and `STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT` (the last
two are documented under "Stage 3.23 hardening").

## Durable recovery (Stage 3.21)

### What exists, and what does not

Recovery remains an **ADMIN-authorized** operator endpoint:

- `POST /api/admin/webhooks/recovery` — one bounded recovery pass (ADMIN session only)
- `GET /api/admin/webhooks/recovery` — read-only diagnostic report (ADMIN session only)

**Vercel Cron (Hobby / Free) backstop** (source-configured; activation is not proven by Git alone):

| Path | Schedule (UTC) | Auth |
|------|----------------|------|
| `GET /api/cron/stripe-webhook-recovery` | `0 3 * * *` (daily) | `Authorization: Bearer ${CRON_SECRET}` |
| `GET /api/cron/expired-holds-cleanup` | `0 4 * * *` (daily) | same `CRON_SECRET` |
| `GET`/`POST` `/api/cron/review-requests` | `0 5 * * *` (daily) | `CRON_SECRET` via Bearer and/or `x-cron-secret` (incoming review helper) |

Defined in `vercel.json` (`crons` only). Hobby allows **at most one execution per day** per
job; Vercel may invoke the job **any time within the scheduled hour** (not an exact
minute guarantee). Configuring the file does **not** prove the cron is deployed or
active — verify after a production deploy in the Vercel dashboard (cron history).

**Product trade-off:** review-request processing was originally scheduled every minute on
`main`. On Vercel Hobby it runs **once daily** (`0 5 * * *`), which may delay post-rental
review emails until the next daily window. Upgrade the plan or accept delayed delivery.

- Set **`CRON_SECRET`** in the Vercel **Production** environment variables before relying
  on these endpoints (random string, ≥16 characters recommended by Vercel). Missing or
  invalid credentials → cron handlers reject the request (recovery/cleanup **401**; review
  route **401**, or **503** if the secret is unset). Do not use an ADMIN session as a
  machine credential.
- Cron recovery calls the same `runProductionWebhookRecovery` worker as ADMIN recovery
  (claim fencing, batch/soft budget, no `PROCESSED` / `DEAD_LETTER` replay). Actor:
  `cron:webhook-recovery`.
- **Daily cron is only a backstop**, not timely webhook recovery. Between runs, rely on
  Stripe redelivery and/or a manual ADMIN recovery pass. Dead-letter events are **not**
  automatically replayed by cron or ADMIN recovery.
- **Vercel does not automatically retry** failed cron HTTP invocations. Inspect failures
  (non-2xx) and retry via the next scheduled run, ADMIN `POST` recovery, or
  `npm run cleanup:expired-holds` as appropriate.
- Expired-hold / unpaid cleanup cron reuses `cleanupExpiredHolds` +
  `cleanupUnpaidPendingPaymentBookings` (same as the CLI). **Opportunistic cleanup** on
  top-level availability reads remains important between daily runs. Known risk: expired
  ACTIVE hold selection is currently **unbounded** (no `take`); a large backlog can stress
  one Function invocation.

### How a recovery pass works

`src/lib/stripe/webhook-recovery.ts` (pure, injected deps) + `webhook-recovery-store.ts`
(SELECT-only) + `webhook-recovery-service.ts` (wiring):

1. **Select** candidates from durable state (read-only, bounded, database clock). The row
   must be `processed = false`, **not** one of the temporarily excluded event types (see
   "Stage 3.23 hardening"), and one of:
   - `PROCESSING`, `claimGeneration >= 1`, with an expired (or null) lease;
   - `RETRYABLE_FAILED`, `claimGeneration >= 1`, whose `lastAttemptAt` is at least
     `minRetryAgeSeconds` old (default 300, range 60–86400, so recovery does not fight
     Stripe's own redelivery);
   - `RECEIVED`, `claimGeneration = 0`, created at/after a **valid, explicitly configured
     claim-protocol cutover** and at least `minRetryAgeSeconds` old (a never-claimed
     claim-era row). Without a valid cutover this branch never matches.
   Never selected: `DEAD_LETTER`, `PROCESSED`, active leases, excluded event types, and any
   `claimGeneration = 0` row that is not provably claim-era (legacy; fail closed). Events
   at/over the retry limit **are** selected, so the claim path can dead-letter them with
   their evidence preserved.
2. **Hand each candidate to the production orchestrator** (`processWebhookEventForRecovery`,
   which calls the same `processWebhookEventWithDeps` the webhook route uses) with the stored
   `payload` (the full Stripe event JSON captured at first delivery). There is no second
   processing implementation.
3. The orchestrator performs the atomic claim — for recovery, the claim itself re-checks the
   same eligibility predicate (see "Claim-time eligibility") — runs the handler under the
   fencing token, and persists the outcome with fenced updates. Recovery only counts what the
   orchestrator returns:
   - `recovered` only after the fenced `markProcessed` succeeded;
   - `deadLettered` only after the fenced dead-letter write succeeded;
   - a failed finalize or terminal write is `stillRetryable`, never a success;
   - `in_flight` (someone else owns it) is `skippedInFlight`; nothing runs;
   - `recovery_not_eligible` (predicate no longer held at claim time) is `skippedNotEligible`;
     nothing was claimed, no attempt was consumed, no handler ran. It is a skip, not a failure.

Recovery never writes `WebhookEvent` itself, never resets a row to `RECEIVED`, never clears a
lease, never edits counters, never replays `DEAD_LETTER`/`PROCESSED`, and never calls Stripe or
refund code directly. Refund safety (payment-row `FOR UPDATE`, authoritative caps, pending
reservations, terminal recovery, ADMIN-only refund controls) is entirely inside the existing
handlers and is untouched.

### Bounds and loop prevention

- Batch size 1–25 (**default 5**, lowered from 10 in Stage 3.23 because each candidate can run
  a Stripe-bound handler; the maximum is unchanged), processed sequentially; the candidate query
  fetches `batchSize + 1` rows so `hasMore` is exact.
- A **soft** wall-clock budget (default 10 s, `STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS`, see
  below) stops a pass early between events (`stoppedEarly`, `hasMore = true`).
- Every claim increments `attemptCount`; at the limit the claim path dead-letters instead of
  running the handler. Repeated passes therefore cannot loop; a `RETRYABLE_FAILED` event that
  keeps failing is re-selected at most until it is dead-lettered.

### Concurrency

There is deliberately no global lock. Overlapping passes (or a pass racing a live Stripe
delivery) all go through `tryClaim`: exactly one can own an event and the other gets
`in_flight` (`skippedInFlight`). Session-level advisory locks are unsafe with pooled
connections, and a transaction-scoped lock would have to span handler work. This relies on
PostgreSQL behaviour that has **not** been exercised against a real database (see the
integration specification below).

### Endpoint contract

`POST /api/admin/webhooks/recovery` — ADMIN only (`requireAdminApiRole(["ADMIN"])`; STAFF gets
403, no session 401). Authorization precedes body parsing and all DB work.

```json
{ "batchSize": 5, "minRetryAgeSeconds": 300 }
```

Both fields optional; the body is `strict` (unknown keys such as `force`, `includeDeadLetter`,
`status`, `maxAttempts`, `purpose`, `eventIds` are rejected with 400 `INVALID_PARAMETERS`).
Response: `{ success: true, result }` with counts (`scanned`, `attempted`, `recovered`,
`alreadyProcessed`, `skippedInFlight`, `skippedNotEligible`, `excludedEventType`,
`stillRetryable`, `deadLettered`, `alreadyDeadLettered`, `errors`, `hasMore`, `stoppedEarly`)
and per-event `{ stripeEventId, eventType, outcome, code? }`. `excludedEventType` counts only
candidates dropped by the in-process defense-in-depth check (the SQL already excludes them, so it
is normally 0); the true backlog of excluded rows is the report's `excludedEventTypePending`.
Stable error codes: `UNAUTHORIZED` (401), `FORBIDDEN` (403), `INVALID_JSON` /
`INVALID_PARAMETERS` (400), `RECOVERY_LOOKUP_FAILED` (503), `INTERNAL_ERROR` (500).

`GET /api/admin/webhooks/recovery?minRetryAgeSeconds=&sampleLimit=&category=` — ADMIN only,
read-only report (see below).

Auditing: each pass writes one best-effort `PaymentAuditLog` row, action
`webhook_recovery_run`, actor `admin:<id>`, containing counts and `{id, type, outcome, code}`
per event — never payloads or secrets. It is best-effort like every webhook audit row; the
per-event outcomes are already durable on the `WebhookEvent` rows and in the ops log.

## Operator visibility

Distinguishing states (report categories and counts; the sample rows expose only stable codes,
timestamps and counters — never `payload` or the free-text `error`):

| Question | Where to look |
|----------|---------------|
| Active claim (a worker may be running) | `activeClaims` / category `ACTIVE_CLAIM` (never touched) |
| Expired claim (eligible for a new claim attempt) | `expiredClaims` / `EXPIRED_CLAIM` |
| Retryable failure | `retryableFailed`, `retryableFailedEligibleNow` / `RETRYABLE_FAILED` |
| Near / at the retry limit | `nearRetryLimit`, `atRetryLimit` |
| Retry-limit dead letter | `deadLetterRetryLimit` / `DEAD_LETTER_RETRY_LIMIT` (`deadLetterReason = RETRY_LIMIT_EXCEEDED`, original code in `lastErrorCode`) |
| Permanently classified | `deadLetterPermanent` / `DEAD_LETTER_PERMANENT` (`deadLetterReason` is the permanent code) |
| Legacy `RETRYABLE_FAILED`, `claimGeneration = 0` (never auto-recovered) | `legacyRetryable` / `LEGACY_RETRYABLE` |
| Legacy / unproven `claimGeneration = 0` (stale `RECEIVED`, or expired `PROCESSING`) — pre-cutover, or cutover unset/invalid | `legacyUnclaimed` / `LEGACY_UNCLAIMED` (never auto-recovered; controlled review) |
| Claim-era never-claimed `RECEIVED` (eligible for recovery) | `receivedClaimEraEligible` / `RECEIVED_CLAIM_ERA` |
| Excluded event type awaiting controlled review | `excludedEventTypePending` / `EXCLUDED_EVENT_TYPE` (not discarded, not marked processed) |
| How the cutover was interpreted | report field `claimProtocolCutover` = `{ status: "unset" \| "invalid" \| "valid", value }` (`unset`/`invalid` => fail closed) |
| A failed recovery attempt | ops log `webhook.recovery_candidate_failed` / `..._dead_lettered`, the audit row's `events`, and the row's incremented `attemptCount` / `lastErrorCode` / `lastAttemptAt` |

Ops log lines added: `webhook.recovery_run_started`, `webhook.recovery_run_completed`,
`webhook.recovery_candidate_skipped_in_flight`, `webhook.recovery_candidate_failed`,
`webhook.recovery_candidate_dead_lettered`, `webhook.recovery_candidate_lookup_failed`, and (Stage 3.23)
`webhook.recovery_candidate_excluded_event_type`, `webhook.recovery_candidate_not_eligible`,
`webhook.recovery_claim_not_eligible`.
Existing lines: `webhook.event_claimed`, `webhook.retry_attempt_started`,
`webhook.expired_claim_reclaimed`, `webhook.duplicate_already_processed`,
`webhook.duplicate_in_flight_skipped`, `webhook.duplicate_dead_lettered`,
`webhook.retryable_failure`, `webhook.permanent_failure_dead_lettered`,
`webhook.retry_limit_exceeded_dead_lettered`, `webhook.stale_finalization_rejected`,
`webhook.handler_succeeded_finalize_failed`, `webhook.event_ignored_unsupported`,
`webhook.event_processed`. Context keys are allow-listed; payloads/PII are never logged.

`PaymentAuditLog` actions (best-effort): `webhook_received`, `webhook_duplicate`,
`webhook_in_flight_skipped`, `webhook_claim_reclaimed`, `webhook_retryable_failure`,
`webhook_dead_lettered`, `webhook_stale_finalization_rejected`, `webhook_finalize_failed`,
`webhook_recovery_run`.

**A missing audit row does not mean an uncommitted financial operation.** Audit writes swallow
their own errors and never change an outcome. The authoritative record is the `WebhookEvent`
row (`status`, `attemptCount`, `lastErrorCode`, `deadLetterReason`) plus the handler's own
transactional writes; the ops log line is the fallback when an audit insert fails.

## Recovery behaviour summary

| Situation | Behaviour |
|-----------|-----------|
| Worker crashes after claiming | Lease expires; next delivery **or recovery pass** reclaims (`previousStatus = PROCESSING`). |
| Handler succeeds, finalize fails | 500, `handlerCompleted = true`; lease released best-effort; retry/recovery re-runs the (idempotent) handler. |
| A's lease expires, B claims | A's finalize/release/dead-letter update zero rows; A returns retryable `CLAIM_SUPERSEDED`. |
| Duplicate delivery of processed event | No handler call; 200. |
| Duplicate delivery during an active lease | No handler call; **503** (retryable). |
| Retryable error | Lease released -> `RETRYABLE_FAILED`; Stripe retries and/or recovery re-attempts. |
| Retry limit reached | `DEAD_LETTER` (`RETRY_LIMIT_EXCEEDED`), original evidence kept, 200 to Stripe. |
| Poison/permanent | `DEAD_LETTER`, 200, no automatic retry. |

## Read-only diagnostics

These queries only `SELECT`, never touch `payload` or the free-text `error` column, and are
safe to run against production by an operator with read access. The `GET` report endpoint
computes the same categories. Substitute `<MAX_ATTEMPTS>` with the configured limit (default 8)
and the interval with the desired minimum age.

### Legacy retryable events (never claimed under leases; NOT auto-recovered)

```sql
SELECT "stripeEventId", "eventType", "status", "attemptCount", "claimGeneration",
       "lastErrorCode", "createdAt", "lastAttemptAt"
FROM "WebhookEvent"
WHERE "processed" = false
  AND "status" = 'RETRYABLE_FAILED'
  AND "claimGeneration" = 0
ORDER BY "createdAt";
```

### Unfinished events never claimed (RECEIVED), older than 1 hour

```sql
SELECT "stripeEventId", "eventType", "createdAt"
FROM "WebhookEvent"
WHERE "processed" = false
  AND "status" = 'RECEIVED'
  AND "createdAt" <= (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 hour'
ORDER BY "createdAt";
```

### Expired or very old PROCESSING claims

```sql
SELECT "stripeEventId", "eventType", "attemptCount", "claimGeneration",
       "claimExpiresAt", "lastAttemptAt"
FROM "WebhookEvent"
WHERE "processed" = false
  AND "status" = 'PROCESSING'
  AND ("claimExpiresAt" IS NULL OR "claimExpiresAt" <= (NOW() AT TIME ZONE 'UTC'))
ORDER BY "claimExpiresAt" NULLS FIRST;
```

### Aged retryable failures (eligible for recovery) and events at/near the retry limit

```sql
SELECT "stripeEventId", "eventType", "attemptCount", "lastErrorCode", "lastAttemptAt",
       ("attemptCount" >= <MAX_ATTEMPTS>) AS "atRetryLimit"
FROM "WebhookEvent"
WHERE "processed" = false
  AND "status" = 'RETRYABLE_FAILED'
  AND "claimGeneration" >= 1
  AND "lastAttemptAt" <= (NOW() AT TIME ZONE 'UTC') - INTERVAL '5 minutes'
ORDER BY "lastAttemptAt";
```

### Excluded event types awaiting controlled review (Stage 3.23)

Uses the `eventType` column only; the in-system exclusion also checks `payload.type` and fails
closed on either, so this query can under-count a row whose stored payload disagrees with its
column. Use the `GET` report (`excludedEventTypePending`) for the authoritative count.

```sql
SELECT "stripeEventId", "eventType", "status", "attemptCount", "claimGeneration",
       "lastErrorCode", "createdAt", "lastAttemptAt"
FROM "WebhookEvent"
WHERE "processed" = false
  AND "status" IN ('RECEIVED', 'RETRYABLE_FAILED', 'PROCESSING')
  AND "eventType" IN ('payment_intent.payment_failed', 'payment_intent.canceled')
ORDER BY "createdAt";
```

### Dead-lettered events needing review

```sql
SELECT "stripeEventId", "eventType", "attemptCount", "lastErrorCode",
       "deadLetterReason", "deadLetteredAt", "lastAttemptAt", "createdAt"
FROM "WebhookEvent"
WHERE "status" = 'DEAD_LETTER'
ORDER BY COALESCE("deadLetteredAt", "lastAttemptAt", "createdAt");
```

## Legacy backlog (events from before Stage 3.19) — review before any replay

Rows that existed when the Stage 3.19 migration ran were backfilled: `processed = true` ->
`PROCESSED`; `processed = false` with an `error` -> `RETRYABLE_FAILED` (`attemptCount = 1`,
`lastErrorCode = LEGACY_UNCLASSIFIED_ERROR`, `claimGeneration = 0`); `processed = false`
without an error -> `RECEIVED`. Rows dead-lettered by Stage 3.19 code were back-filled by the
Stage 3.21 migration with `deadLetterReason` = their old `lastErrorCode`; **their original
error may already have been overwritten** (that was F10), so treat the stored text as possibly
incomplete.

Automatic recovery **does not touch** `claimGeneration = 0` rows unless they are provably
claim-era (see "Legacy versus claim-era rows"), because their financial and business
disposition is unknown: a legacy "failed" row may in fact have completed its side
effects before the old code failed to mark it processed, and old code also returned 200 for
failures, so Stripe may never have redelivered. Review procedure:

1. Run the legacy, unclaimed-`RECEIVED` and dead-letter diagnostics above.
2. For each event, identify what it would do (`eventType` + the Stripe object) and check the
   real-world state in the application and in the Stripe dashboard: is the booking/payment
   already confirmed, is the refund already reflected in `StripeRefund` / payment counters?
3. Events whose effect is already reflected: leave them; no action is needed.
4. Events whose effect is genuinely missing: replay only through a deliberate, reviewed
   action (see "Terminal replay" below), one at a time, for refunds/disputes with a second
   reviewer. Never bulk-replay.
5. Record the decision outside the application (ticket/notes); no code path records it.

## Terminal replay (manual, outside recovery, explicitly reviewed)

Recovery never replays `DEAD_LETTER` events and no replay endpoint exists. A Stripe dashboard
"resend" of a dead-lettered event id will hit the `dead_lettered` claim result and return 200
without running anything, by design. If a reviewed decision is to give an event exactly **one
more** attempt, an authorized operator with database access may perform the following manually
(this is **not** part of the diagnostics above and is **not** executed by any code):

- Never set `status = 'RECEIVED'`, never reset `claimGeneration`, never zero `attemptCount`.
- Move the row to `RETRYABLE_FAILED` with `attemptCount = <MAX_ATTEMPTS> - 1` so a single
  claim is permitted; a failure at the limit dead-letters it again. Keep `lastErrorCode`
  and `error` (evidence), clear `deadLetterReason`/`deadLetteredAt`, and set `lastAttemptAt`
  to now so it is not immediately eligible.
- Only after the financial/business review above, with a second reviewer for refund/dispute
  events. An ADMIN-authorized, audited replay API is a separate future decision.

## Stage 3.23 hardening (recovery eligibility and resource limits)

Source-only changes responding to the Stage 3.22 audit. None of this has been executed or
verified against PostgreSQL, Stripe or a hosting platform.

### Recovery-excluded event types (F1) — currently empty

`RECOVERY_EXCLUDED_EVENT_TYPES` in `webhook-recovery-policy.ts` is currently empty. Automatic
recovery redispatches stored events through the same orchestrator as live delivery
(`processWebhookEventForRecovery` → `processWebhookEventWithDeps` → `dispatchStripeEvent`).

`payment_intent.payment_failed` and `payment_intent.canceled` were previously excluded because
early handlers could release a `PENDING_PAYMENT` booking by `metadata.bookingId` alone. Step 11
added attempt-scoped matching (`decideUnpaidTerminalPaymentIntentEffect`): missing/unlinked
PaymentIntents stay **retryable** within the existing attempt budget; a stale PaymentIntent
cannot fail or release a newer checkout attempt; paid-lineage / protected payments are ignored.
With those guards, recovery of these types is safe under the same claim, idempotency, and
dead-letter rules as other events.

- When the exclusion list is non-empty again, candidates are checked on **both** the
  `eventType` column and `payload.type` (fail closed on either). Excluded rows are never
  selected, claimed, handled, marked processed, or dead-lettered; they appear as
  `excludedEventTypePending` / category `EXCLUDED_EVENT_TYPE`.
- **Normal Stripe delivery of these event types is unchanged**: the live claim statement is
  separate from `claimForRecovery`.
- Soft budget (`STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS`), batch size, min-retry age, cutover,
  and dead-letter caps are unchanged by emptying the list.

### Claim-time eligibility (F3)

Recovery passes a recovery option to the same claim. `claimForRecovery` in
`webhook-event-store.ts` is a separate statement with the same shape as the live claim (CTE
`SELECT ... FOR UPDATE` then `UPDATE ... RETURNING`, DB clock, `claimGeneration + 1`,
`attemptCount + 1`, fresh `claimToken`) whose candidate `WHERE` is the recovery eligibility
predicate **instead of** the broader live predicate:

- the predicate is strictly narrower than the live one: excluded types never match, a `PROCESSING`
  row needs an expired lease and `claimGeneration >= 1`, a `RETRYABLE_FAILED` row needs the
  `minRetryAgeSeconds` backoff and `claimGeneration >= 1`, and `RECEIVED` needs the cutover rule;
- a candidate that became ineligible after it was listed (for example another attempt moved
  `lastAttemptAt`) matches zero rows, so it **consumes no attempt**, does not advance
  `claimGeneration` and runs no handler; the orchestrator returns `recovery_not_eligible`, counted
  as `skippedNotEligible` (distinct from `skippedInFlight`, `stillRetryable` and `errors`);
- an active lease observed after selection is still reported as `in_flight`;
- live Stripe deliveries never pass the option, so **no backoff or exclusion is imposed on them**;
- max attempts, `RETRY_LIMIT_EXCEEDED` dead-lettering, terminal states and fencing are unchanged;
- the lister's SQL and the claim's predicate are kept textually identical between
  `/* recovery-eligibility:start */` and `/* recovery-eligibility:end */` markers; a static test
  asserts equality.

The predicate relies on READ COMMITTED re-evaluation of the `WHERE` clause after the row lock, like
the live claim. That is **unverified** against PostgreSQL.

### Legacy versus claim-era rows (F4)

`claimGeneration = 0` is ambiguous on its own: it is true both of rows created before the claim
protocol existed and of a row inserted by claim-era code that crashed before its first claim.
Automatic recovery therefore treats `claimGeneration = 0` rows as **legacy and never recovers them**
unless an operator has set an explicit, documented cutover marker:

- `STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT` — ISO-8601 instant **with an explicit offset** (for
  example `2026-11-02T09:30:00Z`). Meaning: from that instant on, every application instance that
  can ingest Stripe webhooks uses the lease-claim protocol and no pre-claim instance can insert or
  process `WebhookEvent` rows. Set it only after the controlled drain/switch below. It is **never
  defaulted or inferred** and no timestamp is invented.
- Missing, blank, offset-less, date-only, impossible calendar date, before 2020, or in the future
  => `unset`/`invalid` => **fail closed** (`claimProtocolCutover.status` in the report says which).
- With a valid cutover, only never-claimed `RECEIVED` rows with `createdAt >=` cutover and at least
  `minRetryAgeSeconds` old become eligible (category `RECEIVED_CLAIM_ERA`). A `claimGeneration = 0`
  `RETRYABLE_FAILED` or `PROCESSING` row is impossible under the claim protocol and stays excluded
  even after the cutover.
- Nothing reclassifies, backfills or mutates legacy rows, and no migration was added. `createdAt`
  is compared as a UTC `TIMESTAMP(3)`; whether Prisma-written values follow that convention is
  unverified (integration item 9).
- Legacy/unproven rows are reported as `legacyRetryable` and `legacyUnclaimed` (categories
  `LEGACY_RETRYABLE`, `LEGACY_UNCLAIMED`), separate from eligible rows, without exposing payloads or
  free-text errors. A persisted cutover/"claim protocol since" column (a migration) is a possible
  follow-up and was not added.

### Request-duration limits (F2)

- Default batch size 5 (max 25).
- `STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS`: **soft** per-pass budget, default **10**, **clamped
  1–60**. Missing, blank or non-integer values fall back to 10 (never to "unbounded"). Same
  non-secret, seconds-based convention as `STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS`.
- The budget is checked **between events** only. A handler already running is not cancelled, so one
  slow event (a Stripe-bound refund reconciliation, for instance) can overrun it; the pass stops
  before starting the next candidate and reports `stoppedEarly` / `hasMore`.
- **No route-level `maxDuration` was set** on recovery or cron routes. `vercel.json` now lists
  Hobby-compatible daily crons only; it does not set function duration. Soft recovery budget
  (`STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS`) still applies between events. **Deployment
  follow-up:** confirm Hobby function duration limits and, if needed, set a route-level
  `maxDuration` at or above worst-case handler time + soft budget (or keep the batch small).
  Until then a pass could be cut off by the platform mid-handler; claims are leases and fencing
  makes that recoverable, but it is not tested against production.
- ADMIN recovery authorization is unchanged (`requireAdminApiRole(["ADMIN"])`). Cron routes use
  `CRON_SECRET` Bearer auth only.

### FINALIZE_FAILED dead letters (F10)

A dead letter whose `lastErrorCode` is `FINALIZE_FAILED` can mean the **handler completed its
financial effects** and only the `WebhookEvent` finalize write failed (attempts then ran out). Do
not treat it as a handler failure and do not replay it blindly: first confirm what the handler's
transactional writes already did (booking state, `StripeRefund`, payment counters, Stripe
dashboard).

## Operational cautions (F5 / F10)

- **Claim exclusivity holds only when every instance that can process a webhook uses the claim
  protocol.** An instance still running pre-claim code can enter a handler for an event another
  instance holds a lease on, and can ignore `DEAD_LETTER`/lease semantics entirely.
- **Avoid mixed-version webhook processing.** Use a controlled drain/switch: stop (or route away)
  all old-version instances from the Stripe webhook endpoint, wait for in-flight deliveries to
  finish, deploy the claim-protocol version everywhere, then (optionally) record the
  `STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT` marker. Do not run old and new versions concurrently.
- **Rollback to pre-claim code is unproven and unsafe by default.** Old code may ignore
  `DEAD_LETTER`, `status` and leases and could reprocess rows the new code dead-lettered or
  holds. The schema realignment statement below is a sketch only; **rollback and realignment have
  not been rehearsed**. If a rollback is needed, repeat the drain/switch plan in the other
  direction rather than swapping versions live.
- **Manual replay and direct database intervention are not audited in-system.** Nothing records
  who changed a `WebhookEvent` row by hand; record such actions in an external ticket.
- **Prefer a single recovery scheduler** (or a single operator at a time) until overlapping
  passes have been measured against real PostgreSQL. Overlap is claim-safe by design but is
  unverified, and it multiplies Stripe-bound handler load.

## Deployment sequencing and rollback (for review; nothing applied)

1. Review `prisma/migrations/20261023130000_webhook_event_claim_leases/migration.sql`
   (additive; backfill before constraints) and
   `prisma/migrations/20261023140000_webhook_recovery_dead_letter_columns/migration.sql`
   (additive nullable columns, backfill only of rows already `DEAD_LETTER`, one index).
2. Apply both migrations **before** deploying the new code (new SQL references the enum and
   columns, including `deadLetterReason`). The previous application version keeps working
   against the new schema.
3. Regenerate the Prisma client in the build (`schema.prisma` changed). The stores use raw SQL
   for the new columns, so correctness does not depend on generated types for them.
4. Rollback = redeploy previous code; leave the schema in place — **only via the controlled
   drain/switch described in "Operational cautions"; this has not been rehearsed** and pre-claim
   code may ignore dead-letter semantics. Optional realign:
   `UPDATE "WebhookEvent" SET "status" = 'PROCESSED' WHERE "processed" = true AND "status" <> 'PROCESSED';`
   Rows left `PROCESSING` become reclaimable after `claimExpiresAt`.
5. Set `CRON_SECRET` in Vercel Production, deploy so `vercel.json` crons register, and confirm
   cron history in the Vercel dashboard. ADMIN recovery remains available for manual passes.
   Prefer a single automatic recovery caller (the daily cron) plus occasional ADMIN use.
6. Optionally set `STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS` (default 10, 1–60) and, only after the
   drain/switch is complete, `STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT`. Confirm Hobby
   function duration limits (see "Request-duration limits").

## Tests

Mocked / static (written, **not executed in the authoring stage**):

```
npm run test:webhook-event-claim
npm run test:webhook-http-policy
npm run test:webhook-migration-sql
npm run test:webhook-recovery
npm run test:admin-webhook-recovery-auth
npm run test:cron-authorization
npm run test:cron-stripe-webhook-recovery-auth
npm run test:cron-expired-holds-cleanup-auth
```

Existing related suites (unchanged):

```
npm run test:refund-webhook-reconciliation
npm run test:refund-service
npm run test:refund-terminal-recovery
npm run test:refund-ops-log
```

Test labels: `MOCK` = real module against an in-memory model of the store contract;
`FAKE` = real query functions against a fake client; `STATIC` = source text assertions. The
mocked store is a single-threaded model of the store **contract**. It does not reproduce
PostgreSQL row locks or READ COMMITTED re-evaluation and proves no database concurrency
property; the in-memory candidate filter used by recovery tests is a model of the SQL
predicates, which are only asserted textually.

## Real PostgreSQL integration tests (specification only; none implemented, no DB connected)

Run against a disposable PostgreSQL database after migrations, using the real
`createPrismaWebhookEventStore` and the recovery store:

1. **Concurrent claim**: N parallel `tryClaim` for one event id -> exactly one non-null result;
   `attemptCount = 1`, `claimGeneration = 1`.
2. **Claim vs expired-lease reclaim race**: expire a lease (set `claimExpiresAt` in the past),
   N parallel claims -> exactly one winner; generation increments by exactly 1.
3. **Fenced finalize**: A claims; force-expire; B claims; A `markProcessed`/`releaseForRetry`/
   `markDeadLetter` all return false and leave B's row unchanged.
4. **Legacy backfill rehearsal**: load representative legacy rows (processed true/false, with and
   without `error`), apply both migrations, assert status/attemptCount/lastErrorCode and the
   Stage 3.21 `deadLetterReason` backfill, and that all CHECK constraints hold.
5. **Old-code compatibility**: after migration, simulate old-code writes (`processed = true`
   only) and confirm no constraint violation and that new code reports `already_processed`.
6. **End-to-end duplicate delivery**: parallel `processWebhookEvent` for a `refund.updated`
   fixture against real rows -> refund counters equal the absolute SUCCEEDED sum; request
   status set once.
7. **Refund API vs webhook**: parallel `createRefund` + refund webhook on one payment ->
   caps hold; no over-reservation (exercises real `FOR UPDATE`).
8. **Crash window**: terminate a worker between handler commit and finalize; redelivery after
   lease expiry completes without duplicate effects.
9. **Clock behaviour**: confirm lease comparisons use the database clock and `TIMESTAMP(3)`
   UTC semantics match Prisma-written values.
10. **Statement/lock timeouts**: under induced lock contention, claim and finalize fail with a
    retryable outcome (5xx), never a false 200.
11. **Recovery candidate query**: seed one row per state (active lease, expired lease, aged and
    fresh `RETRYABLE_FAILED`, `DEAD_LETTER`, `PROCESSED`, `RECEIVED`, `claimGeneration = 0`
    legacy) and assert the SQL returns exactly the eligible set, ordered, bounded by `LIMIT`;
    assert the `jsonb` `payload` comes back as an object through `$queryRaw`.
12. **Concurrent recovery passes**: two parallel `runWebhookRecovery` against real rows ->
    each event's handler runs once; the loser records `skippedInFlight`.
13. **Recovery vs live delivery**: a pass and a webhook POST on the same event -> one owner,
    the other `in_flight` (503 on the HTTP side).
14. **Recovery + refunds**: recover a `charge.refunded`/`refund.updated` event concurrently
    with `createRefund` on the same payment -> authoritative caps hold and counters equal
    the absolute SUCCEEDED recompute.
15. **Dead-letter evidence**: drive an event to the limit with real failures and assert
    `lastErrorCode`/`error` hold the original failure while `deadLetterReason =
    RETRY_LIMIT_EXCEEDED`; confirm the `COALESCE(... ::text ...)` parameter casts execute.
16. **Diagnostics are read-only**: run each documented query and the `GET` report inside a
    `READ ONLY` transaction (or with a read-only role); none may fail for write reasons and
    row checksums must be unchanged.
17. **Recovery claim atomicity (Stage 3.23)**: list a candidate, then update its `lastAttemptAt` to
    now from another connection, then call `tryClaim` with the recovery option -> `null`,
    `attemptCount`/`claimGeneration` unchanged. Repeat with N parallel recovery claims and one
    live claim on the same row: exactly one winner, recovery never beats the backoff.
18. **Excluded types**: seed `payment_intent.payment_failed` / `.canceled` rows in each
    non-terminal state (and one whose `payload.type` disagrees with `eventType`); assert recovery
    never lists or claims them and a live `tryClaim` (no option) still can.
19. **Legacy vs claim era**: seed `claimGeneration = 0` rows before/after a cutover and with no
    cutover; assert only post-cutover stale `RECEIVED` rows are eligible, and that the
    `::text::timestamptz` / `AT TIME ZONE 'UTC'` comparison matches Prisma-written `createdAt`.
20. **SQL typing**: execute the candidate and report SQL with parameters bound as Prisma sends
    them and confirm the `::int` casts on both `LIMIT` clauses and the `->>'type'` expressions
    plan and run without type errors.
21. **Request limits**: on the real hosting platform, run a pass with a slow handler and confirm
    the platform limit versus the soft budget behaves as documented (no hosting behaviour has
    been verified).
