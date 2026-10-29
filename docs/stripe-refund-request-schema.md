# Stripe refund allocations & `StripeRefundRequest` (Stage 1B)

Schema/migration only. Refund service, APIs, and webhooks are **not** implemented in this change.

## Models

### `StripePayment` (extended)

| Column | Role |
|--------|------|
| `amountCents` / `refundedAmountCents` | Combined charge and combined succeeded refund total (unchanged meaning) |
| `rentalAmountCents` / `depositAmountCents` | Split of the charge; CHECK: sum equals `amountCents` |
| `rentalRefundedCents` / `depositRefundedCents` | Succeeded purpose-specific refunds only |

**No pending counters** on the payment. Pending reserved capacity is derived:

```text
SUM(StripeRefundRequest.amountCents)
WHERE stripePaymentId = ? AND status = 'PENDING'
```

(and the same filter scoped by `purpose` for purpose caps).

### `StripeRefund` (unchanged)

Stripe-facing mirror used by existing webhook upserts. `stripeRefundId` remains required and unique.

### `StripeRefundRequest` (new)

Durable admin refund **claim** that must exist **before** the Stripe Refunds API call.

| Field | Role |
|-------|------|
| `clientRequestId` | Stable unique client identity; survives crash without a Stripe id |
| `purpose` | `RENTAL` \| `SECURITY_DEPOSIT` \| `UNSPECIFIED` |
| `status` | `PENDING` \| `SUCCEEDED` \| `FAILED` \| `CANCELLED` |
| `stripeRefundId` | Nullable unique; set only from a real Stripe/webhook id |

Suggested Stripe idempotency key for the future service:

```text
refund:{stripePaymentId}:{clientRequestId}
```

## Status enum (no UNKNOWN / RECONCILING)

Chosen states: `PENDING`, `SUCCEEDED`, `FAILED`, `CANCELLED` (spelling matches existing `CANCELLED` enums in this schema).

An extra reconciliation status was **not** added because:

1. In-flight / unknown Stripe outcomes stay `PENDING` until a definitive webhook or admin terminal update.
2. Historical ambiguity lives on unmatched `StripeRefund` rows and payment allocations; that is a **service** reconciliation concern, not a request-row lifecycle state.
3. Keeping four terminal-aware states avoids dual meaning of “needs reconciliation” on both payments and requests.

## Historical backfill (migration)

For every existing `StripePayment`:

- `rentalAmountCents = amountCents`
- `depositAmountCents = 0`
- `rentalRefundedCents = 0`
- `depositRefundedCents = 0`
- `refundedAmountCents` left untouched

**No** `StripeRefundRequest` rows are created from historical `StripeRefund`s. Inventing requests would fabricate claim identities and risk double-counting once the service also reads `StripeRefund`.

Future allocation logic **must** still consider historical `StripeRefund` amounts with unknown purpose as **`UNSPECIFIED`** when computing remaining rental/deposit capacity and the “ambiguous refund blocks purpose-specific refunds” rule—even when no request row exists.

## Future service requirements (not implemented here)

1. **Persist `PENDING` request first**, then call Stripe with the idempotency key above; attach `stripeRefundId` when known; mark `SUCCEEDED` only on definitive success (API terminal success and/or webhook)—not merely on HTTP accept if policy requires webhook confirmation.
2. **Serialize reservation decisions per payment** (e.g. `SELECT … FOR UPDATE` on `StripePayment`, or equivalent transactional lock) before inserting a `PENDING` request so concurrent admins cannot over-reserve.
3. **Webhook replay safety:** upsert by `stripeRefundId` / `clientRequestId`; never increment `*RefundedCents` twice for the same Stripe refund; prefer absolute recompute from succeeded requests + unmatched historical refunds where needed.
4. **Crash recovery:** retry with the same `clientRequestId`; do not rely on a nullable Stripe id alone as the durable identity.

## Rollback considerations

Migration is additive:

1. Drop table `StripeRefundRequest` (and its indexes/FK).
2. Drop CHECK constraints and columns on `StripePayment` (`rentalAmountCents`, `depositAmountCents`, `rentalRefundedCents`, `depositRefundedCents`).
3. Drop enum types `StripeRefundRequestStatus`, `RefundPurpose`.

No historical payment totals or `StripeRefund` rows are rewritten by the forward migration beyond the explicit allocation backfill (`depositAmountCents = 0`, etc.). Rollback does not need to restore invented deposit splits.

## Apply / generate (out of scope for Stage 1B)

Do **not** run against a database from this task. When approved later:

- `npx prisma migrate deploy` (or project script) to apply SQL
- `npx prisma generate` to refresh the client

Runtime refund code is unchanged until a later stage.

---

# Stage 3.2 — Purpose-aware refund service (implemented in code)

## Request state machine

```text
(none) --reserve--> PENDING --Stripe succeeded--> SUCCEEDED
                       |----Stripe failed/canceled--> FAILED
                       |----timeout / pending Stripe--> stays PENDING (retry same clientRequestId)
```

`CANCELLED` is reserved for explicit admin abandonment (not used by the ordinary Stripe create path).

## Accounting rules

- Integer cents only.
- Available rental = `rentalAmountCents - rentalRefundedCents - PENDING RENTAL`
- Available deposit = `depositAmountCents - depositRefundedCents - PENDING SECURITY_DEPOSIT`
- Available combined = `amountCents - refundedAmountCents - all PENDING`
- Both purpose and combined caps must pass before reservation.
- Succeeded counters are **absolutely recomputed** from `SUCCEEDED` requests (never incremented blindly) so API success + webhook cannot double-count.

## Idempotency

- Client identity: `StripeRefundRequest.clientRequestId` (required on ADMIN API).
- Stripe idempotency key: `refund:{stripePaymentId}:{clientRequestId}`.
- Same clientRequestId + same material params resumes the same request.
- Same clientRequestId + different params → conflict (`request_conflict`).

## Eligibility

- Channel: Stripe `SUCCEEDED` payment intent, ONLINE combined checkout, no ALREADY_PAID proof path.
- RENTAL: channel-eligible + capacity.
- SECURITY_DEPOSIT: COMPLETED by default, or CONFIRMED→CANCELLED with `BookingStatusHistory` proving cancel time before `pickupDateTime` (explicit ADMIN action only).
- Cancellation / completion bookkeeping does **not** call Stripe refunds.

## Historical ambiguity

If unmatched `StripeRefund` rows, `UNSPECIFIED` active requests, or unallocated combined refunded amounts exist, purpose-specific refunds are blocked (`needs_reconciliation`) until ADMIN posts explicit allocations to `POST /api/admin/payments/[id]/reconcile-refunds` with audited evidence.

## Webhooks

- `refund.created` / `refund.updated`: upsert `StripeRefund`, link by `stripeRefundId` or metadata `clientRequestId`, absolute counter recompute on success; unmatched IDs stay unresolved (no invented purpose).
- `charge.refunded`: updates combined Stripe status mirrors only; **never** allocates purpose from aggregate charge totals.

## Admin UI

`/[locale]/admin/stripe-payments` — purpose selector, stable client request ID per attempt, reconciliation dialog when blocked.
