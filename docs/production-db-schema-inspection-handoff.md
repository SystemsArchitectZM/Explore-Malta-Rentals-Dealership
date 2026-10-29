# Production DB Schema Inspection Handoff

**Status:** Operator handoff only. Do **not** run migrations, `db push`, DDL, or data mutations.  
**Prepared for:** Explore Malta Rentals — Stripe online security-deposit / refund / webhook integration  
**Git reference (verified recovery checkpoint):** `wip/security-deposit-checkpoint-20261026` @ `9f88cd9b2cb89a1080b9965b3417836b4f447cf1`  
**Related migrations (feature branch; not on `origin/main` as folders):**

1. `20261023120000_stripe_refund_allocations_and_requests`
2. `20261023130000_webhook_event_claim_leases`
3. `20261023140000_webhook_recovery_dead_letter_columns`

**Companion SQL file (read-only SELECTs only):**  
[`production-db-schema-inspection-readonly.sql`](./production-db-schema-inspection-readonly.sql)

Phase 6 result was **UNKNOWN** (no production connection was opened by engineering). This package enables an authorized operator to classify production as **A / B / C / D / UNKNOWN**.

---

## 1. Operator setup (confirm production first)

1. Open the **hosting** dashboard (e.g. Vercel) → project → **Production** environment.  
   Note which database variable name is bound (e.g. `DATABASE_URL`) — **do not** paste the value into chat, tickets, or this repo.
2. Open the **database provider** dashboard (e.g. Neon). Select the project/branch that the production app actually uses (match by project name / production branch label — not by guessing from a laptop `.env`).
3. Prefer an **explicitly read-only** role or SQL editor session. If only a read-write role exists, do **not** proceed with this inspection unless a DBA confirms you will run **only** the SELECT/catalog queries in the companion SQL file.
4. Open a SQL session against that production database.
5. Run the queries in [`production-db-schema-inspection-readonly.sql`](./production-db-schema-inspection-readonly.sql) in order.
6. Return results using the **safe reply format** below. Do **not** share:
   - Connection strings, passwords, API tokens, or `.env` contents  
   - Customer PII, booking rows, payment amounts, Stripe IDs from business tables  
   - Full raw migration `logs` blobs (summarize failure text only if needed)

---

## 2. Reference contract (from checked-in Git)

Source of truth for expected objects: migration SQL + Prisma schema at checkpoint `9f88cd9`.

### 2.1 Migration `20261023120000_stripe_refund_allocations_and_requests`

| Object | Expected |
|--------|----------|
| Enum `RefundPurpose` | `RENTAL`, `SECURITY_DEPOSIT`, `UNSPECIFIED` |
| Enum `StripeRefundRequestStatus` | `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED` |
| `StripePayment.rentalAmountCents` | `INTEGER` / Prisma `Int`, **NOT NULL** after migration |
| `StripePayment.depositAmountCents` | `INTEGER NOT NULL DEFAULT 0` |
| `StripePayment.rentalRefundedCents` | `INTEGER NOT NULL DEFAULT 0` |
| `StripePayment.depositRefundedCents` | `INTEGER NOT NULL DEFAULT 0` |
| CHECKs on `StripePayment` | `StripePayment_allocation_sum_check` (`rental + deposit = amountCents`); non-neg checks on allocation + refunded columns including `refundedAmountCents` |
| Table `StripeRefundRequest` | PK `id`; columns `stripePaymentId`, `clientRequestId`, `purpose`, `amountCents`, `status`, `stripeRefundId`, `initiatedBy`, `notes`, `metadata`, `createdAt`, `updatedAt` |
| CHECK | `StripeRefundRequest_amountCents_positive_check` (`amountCents > 0`) |
| Unique indexes | `StripeRefundRequest_clientRequestId_key`, `StripeRefundRequest_stripeRefundId_key` |
| Indexes | `…_stripePaymentId_idx`, `…_stripePaymentId_status_idx`, `…_stripePaymentId_purpose_status_idx` |
| FK | `StripeRefundRequest_stripePaymentId_fkey` → `StripePayment(id)` ON DELETE CASCADE |

### 2.2 Migration `20261023130000_webhook_event_claim_leases`

| Object | Expected |
|--------|----------|
| Enum `WebhookEventStatus` | `RECEIVED`, `PROCESSING`, `PROCESSED`, `RETRYABLE_FAILED`, `DEAD_LETTER` |
| Columns on `WebhookEvent` | `status` (NOT NULL DEFAULT `RECEIVED`), `claimToken`, `claimExpiresAt`, `claimGeneration` (NOT NULL DEFAULT 0), `attemptCount` (NOT NULL DEFAULT 0), `lastErrorCode`, `lastAttemptAt` |
| CHECKs | `WebhookEvent_processed_status_check`, `WebhookEvent_processing_lease_check`, `WebhookEvent_claimGeneration_nonneg_check`, `WebhookEvent_attemptCount_nonneg_check` |
| Indexes | `WebhookEvent_status_claimExpiresAt_idx`, `WebhookEvent_status_createdAt_idx` |

### 2.3 Migration `20261023140000_webhook_recovery_dead_letter_columns`

| Object | Expected |
|--------|----------|
| Columns on `WebhookEvent` | `deadLetterReason` (nullable TEXT), `deadLetteredAt` (nullable TIMESTAMP) |
| Index | `WebhookEvent_status_lastAttemptAt_idx` |

### 2.4 Note on `origin/main` asymmetry

Remote `main` Prisma schema may already declare the four allocation columns **without** the three migration folders. Production may therefore show columns **without** matching `_prisma_migrations` rows (class **B**). That is a reconciliation case — **do not** run `20261023120000_…` unchanged if columns already exist.

---

## 3. Query categories in the companion SQL

1. Session/database identity metadata (names only — no secrets)  
2. `_prisma_migrations` rows for the three feature migrations + recent migration list  
3. `StripePayment` allocation columns (type / nullability / default)  
4. `StripePayment` CHECK constraints  
5. `StripeRefundRequest` table columns  
6. Refund-related enums (`RefundPurpose`, `StripeRefundRequestStatus`)  
7. `StripeRefundRequest` PK / FK / unique / non-unique indexes  
8. `WebhookEvent` claim + dead-letter columns  
9. `WebhookEventStatus` enum values  
10. `WebhookEvent` CHECKs and status-related indexes  

All statements are `SELECT` (or catalog reads). **No** `INSERT` / `UPDATE` / `DELETE` / `ALTER` / `CREATE` / `DROP` / `TRUNCATE` / `prisma migrate` commands.

---

## 4. Safe reply format (paste back to engineering)

```text
Environment confirmed: Production (provider project/branch labels only): <labels>
Session role: read-only? yes/no

Migration records:
- 20261023120000_stripe_refund_allocations_and_requests: present? Y/N | finished_at set? Y/N | rolled_back_at set? Y/N | failure summary: <none|short>
- 20261023130000_webhook_event_claim_leases: ...
- 20261023140000_webhook_recovery_dead_letter_columns: ...
Duplicates for those names? Y/N

Allocation columns on StripePayment:
- rentalAmountCents: present? Y/N | type | nullable | default
- depositAmountCents: ...
- rentalRefundedCents: ...
- depositRefundedCents: ...
CHECK names present: <list or none>

StripeRefundRequest:
- table present? Y/N
- enums RefundPurpose / StripeRefundRequestStatus present? Y/N (list values if present)
- FK to StripePayment present? Y/N
- unique clientRequestId / stripeRefundId present? Y/N
- expected indexes present? <list missing>

WebhookEvent claim/DL:
- status, claimToken, claimExpiresAt, claimGeneration, attemptCount, lastErrorCode, lastAttemptAt: each Y/N
- deadLetterReason, deadLetteredAt: each Y/N
- WebhookEventStatus values: <list or missing>
- CHECK / index names present: <list or missing>

Classification: A | B | C | D | UNKNOWN
Notes: <one short paragraph, no secrets>
```

---

## 5. Classification checklist

Use **all** of migration history + live catalog. Do not classify from Prisma schema alone.

| Class | Choose when |
|-------|-------------|
| **A** | None of the four allocation columns; no `StripeRefundRequest`; no claim/DL webhook fields; none of the three migration names in `_prisma_migrations`. |
| **B** | Some or all allocation columns exist, **and** migration history and/or remaining objects are incomplete (e.g. columns present but `20261023120000_…` absent; or enums/table/CHECKs missing). |
| **C** | All three migration names recorded successfully (`finished_at` set, `rolled_back_at` null), **and** allocation columns, CHECKs, `StripeRefundRequest` (+ enums/FK/indexes), and webhook claim + DL fields (+ enums/CHECKs/indexes) match the contract above. |
| **D** | History vs catalog disagree; failed/partial apply; wrong types; duplicate migration rows; or other drift that is not a clean A/B/C. |
| **UNKNOWN** | Wrong database, non-read-only session refused, query errors, or incomplete results. |

### Actions implied by class (engineering — not the operator)

| Class | Migration safety |
|-------|------------------|
| **A** | Do **not** auto-migrate. Still need integration review + explicit migrate approval. |
| **B** or **D** | **Prohibit** running the original three migrations unchanged until a reviewed reconciliation plan exists. |
| **C** | Do **not** reapply successful migrations. |
| **UNKNOWN** | Keep migrate blocked; obtain missing evidence. |

---

## 6. Files inspected to build this handoff (local Git only)

- `prisma/migrations/20261023120000_stripe_refund_allocations_and_requests/migration.sql`
- `prisma/migrations/20261023130000_webhook_event_claim_leases/migration.sql`
- `prisma/migrations/20261023140000_webhook_recovery_dead_letter_columns/migration.sql`
- `prisma/schema.prisma` models/enums: `StripePayment`, `StripeRefundRequest`, `WebhookEvent`, `RefundPurpose`, `StripeRefundRequestStatus`, `WebhookEventStatus`  
  (at checkpoint `9f88cd9b2cb89a1080b9965b3417836b4f447cf1`)

No database was contacted while preparing this document.
