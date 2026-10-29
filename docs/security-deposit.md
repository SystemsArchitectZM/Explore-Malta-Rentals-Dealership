# Security Deposit — Complete Guide

> **Product:** Explore Malta Rentals  
> **Scope:** Online security deposit in Stripe Checkout, allocation accounting, purpose-aware refunds, admin lifecycle, and edge cases  
> **Stack:** Next.js App Router · TypeScript · Prisma · PostgreSQL · Stripe Checkout · Vercel  

This document describes how the **€250 refundable security deposit** works in this codebase end to end. It is based on current source (`SECURITY_DEPOSIT_EUR`, checkout allocation, refund eligibility, admin lifecycle). Related Stripe payment docs: [`stripe-payment-integration.md`](./stripe-payment-integration.md), [`stripe-refund-request-schema.md`](./stripe-refund-request-schema.md).

---

## Table of contents

1. [What it is (and what it is not)](#1-what-it-is-and-what-it-is-not)
2. [Fixed amount and constants](#2-fixed-amount-and-constants)
3. [Deposit methods: ONLINE vs IN_PERSON](#3-deposit-methods-online-vs-in_person)
4. [Customer booking flow](#4-customer-booking-flow)
5. [Money model on the booking](#5-money-model-on-the-booking)
6. [Stripe Checkout: combined charge + line items](#6-stripe-checkout-combined-charge--line-items)
7. [Deposit-only checkout (loyalty covers rental)](#7-deposit-only-checkout-loyalty-covers-rental)
8. [Payment confirmation and integrity](#8-payment-confirmation-and-integrity)
9. [Database fields and enums](#9-database-fields-and-enums)
10. [Admin lifecycle (collect / complete / cancel)](#10-admin-lifecycle-collect--complete--cancel)
11. [Refunding the deposit via Stripe](#11-refunding-the-deposit-via-stripe)
12. [Accounting rules (cents, caps, pending)](#12-accounting-rules-cents-caps-pending)
13. [Historical payments and reconciliation](#13-historical-payments-and-reconciliation)
14. [Unpaid / failed / cancelled checkout](#14-unpaid--failed--cancelled-checkout)
15. [What does *not* auto-refund the deposit](#15-what-does-not-auto-refund-the-deposit)
16. [UI surfaces](#16-ui-surfaces)
17. [API routes involved](#17-api-routes-involved)
18. [Key source files](#18-key-source-files)
19. [Tests (reference)](#19-tests-reference)
20. [Operational checklist](#20-operational-checklist)
21. [Glossary](#21-glossary)

---

## 1. What it is (and what it is not)

### What it is

- A **fixed €250** refundable security deposit charged as part of **Stripe Checkout** for standard online bookings.
- Stored and tracked as a **separate allocation** on `StripePayment` (`depositAmountCents`), distinct from the rental allocation (`rentalAmountCents`).
- Refunded later (when eligible) as a **purpose-specific Stripe refund** with purpose `SECURITY_DEPOSIT`.
- Also tracked on the booking as operational status (`Booking.securityDepositStatus`: `PENDING` → `COLLECTED` / `REFUNDED` / `DEDUCTED`) for admin handover / completion bookkeeping.

### What it is not

- **Not a Stripe Authorization / card hold** (`capture_method: manual`). Checkout uses `mode: "payment"` — the customer is **charged** for rental + deposit (or deposit only). “Held for 7–10 days after return” in the wizard copy is **product language** for when the team typically refunds; it is not a Stripe uncaptured hold.
- **Not included in loyalty discounts.** Loyalty credits apply only to booking charges (rental/fees), never to the deposit.
- **Not automatically refunded** when an admin marks a booking completed or cancelled. Completion updates booking deposit outcome fields; **Stripe money movement requires an explicit ADMIN refund** (or the pre-pickup cancel API exception path).
- **Not the same as** `Booking.depositRefundAmount` / `depositDeductionAmount` alone — those are admin bookkeeping fields; Stripe refunds live on `StripeRefundRequest` / `StripeRefund` / payment counters.

---

## 2. Fixed amount and constants

| Constant | Location | Value |
|----------|----------|--------|
| `SECURITY_DEPOSIT_EUR` | `src/features/booking/lib/booking-schema.ts` | `250` |
| `SECURITY_DEPOSIT_CENTS` | `src/lib/stripe/checkout-allocation.ts` | `25000` (`Math.round(250 * 100)`) |

Online checkout **rejects** any deposit amount that is not exactly €250.00 (cent-accurate).

---

## 3. Deposit methods: ONLINE vs IN_PERSON

Enum: `DepositMethod` in Prisma — `ONLINE` | `IN_PERSON`.

| Method | When used | Effect on money |
|--------|-----------|-----------------|
| **ONLINE** | Standard Stripe bookings (`payment.mode === "STRIPE"`) | Deposit is included in `totalDueOnline` and charged in Checkout |
| **IN_PERSON** | `ALREADY_PAID` / offline proof paths; legacy/admin semantics | Deposit is due at pickup (`totalDueLater`); **not** charged via Stripe Checkout |

**Hard rule for Stripe mode** (`bookingSubmissionSchema.ts`):

> If `payment.mode === "STRIPE"`, `deposit.depositMethod` **must** be `ONLINE`.

The booking wizard’s security-deposit step **forces** `depositMethod: "online"` for the customer path.

Checkout and refund services also fail closed if `depositMethod !== "ONLINE"` when creating sessions or issuing Stripe refunds.

---

## 4. Customer booking flow

```
Wizard steps (vehicle → dates → … → Security deposit → Summary → Pay)
        │
        ▼
POST /api/bookings  (submitBooking)
  → Booking created
  → depositMethod = ONLINE (Stripe path)
  → depositAmount = 250
  → totalDueOnline = rental charges (after loyalty) + 250
  → totalDueLater = 0
  → securityDepositStatus = PENDING
  → status often PENDING_PAYMENT until paid
        │
        ▼
POST /api/stripe/checkout  (createCheckoutSession)
  → allocateCombinedCheckoutAmounts()
  → Stripe Checkout Session with line items:
       1) "{Vehicle} Rental"   (if rental > 0)
       2) "Security Deposit"  (always €250 online)
  → StripePayment row: amountCents / rentalAmountCents / depositAmountCents
        │
        ▼
Customer pays on Stripe hosted page
        │
        ▼
Webhooks + confirm-paid path
  → StripePayment.stripeStatus = SUCCEEDED
  → Booking.paymentStatus = PAID
  → Booking confirmed (from pending) + confirmation email
```

**Important:** Successful payment marks the **booking payment** as paid. The operational field `securityDepositStatus` is **not** automatically flipped to `COLLECTED` in the Stripe confirm path; admins typically update deposit outcome at completion (or when recording collection for offline flows). For online-paid deposits, treat Stripe `depositAmountCents` + refund counters as the source of truth for **money**, and `securityDepositStatus` as **ops bookkeeping**.

---

## 5. Money model on the booking

Pricing / payment summary (`buildBookingPaymentSummary`):

| Concept | ONLINE | IN_PERSON |
|---------|--------|-----------|
| Booking charges | `subtotal − loyalty` | same |
| Security deposit | €250 | €250 |
| Amount payable online | charges + deposit | charges only |
| Amount due later | `0` | deposit |
| Loyalty | Never reduces the deposit | same |

On create (`submitBooking`):

- `depositAmount` from pricing breakdown (fixed €250 in product config).
- If loyalty is redeemed after create, `totalDueOnline` / `totalDueLater` are recalculated so deposit remains included when method is ONLINE.
- Edge: if loyalty drives online total to `≤ 0` while status is still pending payment, booking can be auto-confirmed as paid with `paymentReceivedAmount: 0` — that path is for **zero online charge**; standard ONLINE deposit still requires a positive online total that includes €250 (deposit-only Checkout when rental is fully covered — see §7).

---

## 6. Stripe Checkout: combined charge + line items

### Allocation (`allocateCombinedCheckoutAmounts`)

Inputs:

- `totalDueOnlineEur` (booking total charged online)
- `rentalSubtotalEur` (booking charges after loyalty; may be `0`)
- `depositAmountEur` (must be €250)
- `depositMethod` (must be `ONLINE`)

Checks:

1. Deposit method ONLINE  
2. Finite, positive deposit and online total  
3. `depositAmountCents === 25000`  
4. `rentalAmountCents + depositAmountCents === amountCents` (exact)

### Line items (`buildCombinedCheckoutLineItems`)

| Case | Line items |
|------|------------|
| Rental &gt; 0 | Rental line + Security Deposit line |
| Rental = 0 (deposit-only) | **Only** Security Deposit line (no €0 rental line) |

Metadata on items / session includes `allocation: "rental" | "security_deposit"` and cent amounts for integrity checks (`checkout-session-policy.ts`).

### Persistence

`StripePayment` stores:

| Field | Meaning |
|-------|---------|
| `amountCents` | Total charged |
| `rentalAmountCents` | Rental portion |
| `depositAmountCents` | Deposit portion (€25000 for new online checkouts) |
| `rentalRefundedCents` | Succeeded rental-purpose refunds |
| `depositRefundedCents` | Succeeded deposit-purpose refunds |
| `refundedAmountCents` | Combined succeeded refund total (compatibility) |

Invariant: `rentalAmountCents + depositAmountCents = amountCents`.

---

## 7. Deposit-only checkout (loyalty covers rental)

When loyalty (or equivalent) reduces payable rental to **€0** but the customer still owes the online deposit:

- Allocation: `rentalAmountCents = 0`, `depositAmountCents = 25000`, `amountCents = 25000`
- Checkout shows a **single** “Security Deposit” line
- This is intentional (“Option A” / deposit-only Checkout in code comments)
- Unpaid failure / cancel paths still release soft reserves carefully so a later paid webhook cannot be overwritten (see unpaid terminal PI policy + deposit-only release tests)

---

## 8. Payment confirmation and integrity

Before promoting a payment to paid / sending confirmation:

1. **Allocation consistency** — `validateStoredPaymentAllocation`  
2. **Amount / currency match** Stripe session or PaymentIntent  
3. **Session / PI identity** match stored IDs  
4. Only unpaid Stripe statuses may be written to `SUCCEEDED`  
5. `Booking.paymentStatus` is not moved back from `PAID` or `REFUNDED`

Failures fail closed (no silent confirm). Confirmation email is sent only for eligible succeeded payments.

---

## 9. Database fields and enums

### On `Booking`

| Field | Role |
|-------|------|
| `depositAmount` | Expected deposit (€) |
| `depositMethod` | `ONLINE` / `IN_PERSON` |
| `totalDueOnline` / `totalDueLater` | Split of what customer pays now vs later |
| `securityDepositStatus` | `PENDING` \| `COLLECTED` \| `REFUNDED` \| `DEDUCTED` |
| `securityDepositCollectedAmount` | Ops amount recorded as collected |
| `depositRefundAmount` | Ops amount marked refunded at completion |
| `depositDeductionAmount` / `depositDeductionReason` | Ops deduction at completion |

### On `StripePayment` / refund tables

| Model | Role |
|-------|------|
| `StripePayment` | Charge + rental/deposit split + refund counters |
| `StripeRefundRequest` | Durable ADMIN claim **before** Stripe refund API (`purpose`, `clientRequestId`, status) |
| `StripeRefund` | Mirror of Stripe refund objects |
| `RefundPurpose` | `RENTAL` \| `SECURITY_DEPOSIT` \| `UNSPECIFIED` |

Migrations of note (deposit allocations / requests):

- `prisma/migrations/20261023120000_stripe_refund_allocations_and_requests/`

Historical backfill for older payments: `depositAmountCents = 0`, `rentalAmountCents = amountCents` (deposit not invented for old rows).

---

## 10. Admin lifecycle (collect / complete / cancel)

### Complete booking (`completeBooking`)

From status `RETURNED` → `COMPLETED`, admin supplies `depositOutcome`:

- `REFUNDED` → sets `securityDepositStatus = REFUNDED`, optional `depositRefundAmount`
- `DEDUCTED` → sets `securityDepositStatus = DEDUCTED`, deduction amount/reason

**This does not call Stripe.** Money still on the card/charge until an ADMIN runs a Stripe deposit refund (if ONLINE and eligible).

### Cancel booking (`cancelBooking`)

May update `securityDepositStatus` when `depositOutcome` is `REFUNDED` / `DEDUCTED` and current status is `COLLECTED`. Again: **bookkeeping**, not Stripe.

### Offline / already-paid

`ALREADY_PAID` creates with `depositMethod = IN_PERSON` semantics and may set `securityDepositStatus = COLLECTED` with `securityDepositCollectedAmount` at create. Those bookings **cannot** use Stripe refund APIs (channel eligibility blocks proof / non-ONLINE paths).

---

## 11. Refunding the deposit via Stripe

### Channel eligibility (`evaluateStripeRefundChannelEligibility`)

All must hold:

- Stripe payment status refund-eligible (`SUCCEEDED` or `PARTIALLY_REFUNDED`)
- PaymentIntent ID present
- No offline payment proof path
- Online amount due &gt; 0 (where checked)
- `depositMethod === "ONLINE"`

### Purpose eligibility (`evaluatePurposeRefundEligibility`)

| Purpose | Rule |
|---------|------|
| `RENTAL` | Channel-eligible + capacity |
| `SECURITY_DEPOSIT` | Channel-eligible + (`booking.status === "COMPLETED"` **or** pre-pickup cancel exception) |

**Pre-pickup cancel exception (API / server):**

- Status `CANCELLED`
- Prior status was `CONFIRMED` (from status history)
- `cancelledAt` exists and is **before** `pickupDateTime`
- Deposit method ONLINE

**Admin UI** is stricter: deposit purpose is only offered when status is `COMPLETED` (`canSubmitDepositPurposeInUi`). Pre-pickup deposit refund remains an **explicit ADMIN API** capability, not a normal UI button.

### Request flow (Stage 3.2)

```
ADMIN POST refund
  → Validate purpose + eligibility + capacity
  → Insert StripeRefundRequest PENDING (clientRequestId)
  → Call Stripe Refunds API with idempotency key
       refund:{stripePaymentId}:{clientRequestId}
  → Link stripeRefundId; mark SUCCEEDED / FAILED from API + webhooks
  → Recompute rentalRefundedCents / depositRefundedCents absolutely
```

Webhooks (`refund.created` / `refund.updated`) upsert mirrors and recompute counters. `charge.refunded` updates combined status only — **never** invents purpose from aggregate totals.

---

## 12. Accounting rules (cents, caps, pending)

Integer cents only.

```
available_rental  = rentalAmountCents  - rentalRefundedCents  - PENDING(RENTAL)
available_deposit = depositAmountCents - depositRefundedCents - PENDING(SECURITY_DEPOSIT)
available_combined = amountCents - refundedAmountCents - all PENDING
```

Both **purpose** and **combined** caps must pass before a new PENDING reservation.

Pending capacity is **derived** from `StripeRefundRequest` rows with `status = PENDING` (no separate pending counter columns).

Succeeded counters are **recomputed** from succeeded requests so API + webhook cannot double-count.

---

## 13. Historical payments and reconciliation

Older `StripePayment` rows may have `depositAmountCents = 0` (entire charge treated as rental). Purpose-specific refunds can be blocked when:

- Unmatched historical `StripeRefund` rows
- `UNSPECIFIED` active requests
- Unallocated combined refunded amounts

Then ADMIN must use **reconcile-refunds** (`POST /api/admin/payments/[id]/reconcile-refunds`) with explicit `RENTAL` / `SECURITY_DEPOSIT` allocations before new purpose refunds proceed (`needs_reconciliation`).

Terminal refund recovery (`recover-terminal-refund`) can resume typed `RENTAL` / `SECURITY_DEPOSIT` requests; it does not invent purpose for unspecified historical refunds.

---

## 14. Unpaid / failed / cancelled checkout

When Checkout fails or is abandoned:

- Unpaid terminal PaymentIntent events update local status only when the PI matches the stored unpaid attempt
- Paid / paid-lineage statuses are **protected** (no overwrite, no vehicle release from a stale failed PI)
- Soft-reserved vehicles can be released for true unpaid terminals; deposit-only bookings follow the same unpaid-release protection rules (see `unpaid-terminal-payment-intent-policy.ts` and deposit-only release tests)

Expired Checkout sessions are handled by dedicated expired-session policy/handlers so retries create a coherent new session without corrupting a paid booking.

---

## 15. What does *not* auto-refund the deposit

| Event | Stripe deposit refund? |
|-------|-------------------------|
| Customer completes Checkout | Charge happens; no refund |
| Admin marks vehicle returned | No |
| Admin completes booking with outcome REFUNDED | Updates booking fields only |
| Admin cancels booking | Booking deposit status may change; **no automatic Stripe refund** |
| Review-request cron / other crons | Unrelated |
| Loyalty credit issuance | Unrelated to deposit money |

Operators must run a **SECURITY_DEPOSIT** refund (when eligible) to return card funds.

---

## 16. UI surfaces

| Surface | Behavior |
|---------|----------|
| Wizard — Security deposit step | Explains €250; forces online; copy mentions hold period after return |
| Wizard — Summary | Shows deposit in online total; “pay online now” |
| Payment success / cancel pages | Reflect online payment including deposit |
| Confirmation email | Deposit method label (online vs in person) |
| Admin booking detail | Deposit method, status, collected/refund/deduction fields |
| Admin Stripe payments | Purpose selector `RENTAL` / `SECURITY_DEPOSIT`; deposit UI gated to COMPLETED; reconcile dialog |

Terms page copy may still mention “cash or card hold at pickup” for general policy; **standard Stripe product path** collects the deposit **online at booking**.

---

## 17. API routes involved

| Route | Role |
|-------|------|
| `POST /api/bookings` | Create booking with deposit fields |
| `POST /api/stripe/checkout` | Create/reuse Checkout (allocation enforced) |
| `GET` checkout-redirect / verify-session | Retry / poll |
| `POST /api/stripe/webhook` | Succeeded payment, refunds, unpaid terminals |
| `POST /api/admin/payments/[id]/refund` | Purpose-aware refund (`RENTAL` \| `SECURITY_DEPOSIT`) |
| `POST /api/admin/payments/[id]/reconcile-refunds` | Allocate historical ambiguity |
| `POST /api/admin/payments/[id]/recover-terminal-refund` | Recover stuck typed refund requests |
| Admin booking lifecycle APIs | Complete / cancel deposit **bookkeeping** |

---

## 18. Key source files

```
src/features/booking/lib/booking-schema.ts          # SECURITY_DEPOSIT_EUR = 250
src/features/booking-flow/steps/security-deposit-step.tsx
src/lib/booking/bookingSubmissionSchema.ts          # STRIPE ⇒ ONLINE required
src/lib/booking/build-booking-payment-summary.ts
src/lib/booking/submitBooking.ts
src/lib/stripe/checkout-allocation.ts               # cents + line items
src/lib/stripe/checkout-session-policy.ts
src/lib/stripe/payment-service.ts                   # createCheckoutSession
src/lib/stripe/payment-confirmation-integrity.ts
src/lib/stripe/confirm-paid-booking.ts
src/lib/stripe/refund-eligibility.ts
src/lib/stripe/refund-accounting.ts
src/lib/stripe/refund-service.ts
src/lib/stripe/refund-reconciliation.ts
src/lib/stripe/webhook-service.ts
src/lib/admin/bookings/lifecycle/completeBooking.ts
src/lib/admin/bookings/lifecycle/cancelBooking.ts
src/features/admin/lib/stripe-refund-ui-policy.ts
prisma/schema.prisma                                # Booking + StripePayment + RefundPurpose
docs/stripe-refund-request-schema.md
```

---

## 19. Tests (reference)

Do not treat this list as “green” without running them. Relevant scripts/modules include:

| Area | Example |
|------|---------|
| Deposit method policy | `scripts/test-booking-deposit-method-policy.ts` |
| Deposit-only unpaid release | `scripts/test-deposit-only-release-unpaid.ts` |
| Refund / allocation / webhook | packages under `src/lib/stripe/*` tested via project `npm run test:*` scripts |
| Review cron | Unrelated to deposit money |

---

## 20. Operational checklist

**Before relying on online deposits in Production**

1. Apply Prisma migrations that add allocation columns and `StripeRefundRequest`  
2. Set live Stripe keys + webhook secret; confirm webhook events include Checkout + refund types  
3. Confirm `SECURITY_DEPOSIT_EUR` matches published terms (€250)  
4. Train admins: completion “REFUNDED” ≠ Stripe refund; use Stripe payments panel for money movement  
5. For pre-pickup full deposit return after cancel, use ADMIN API with evidence of CONFIRMED→CANCELLED before pickup (UI may not expose it)  
6. Reconcile any historical payments (`depositAmountCents = 0`) before purpose refunds  
7. Never expect deposit refunds for `IN_PERSON` / ALREADY_PAID proof bookings via Stripe  

**Typical happy path after rental**

1. Customer paid online (rental + €250 deposit)  
2. Vehicle returned → admin completes booking → choose deposit outcome for ops  
3. If full/partial return of deposit funds: ADMIN Stripe refund purpose `SECURITY_DEPOSIT` while booking is `COMPLETED`  
4. Counters update; booking `securityDepositStatus` should stay consistent with ops practice  

---

## 21. Glossary

| Term | Meaning in this project |
|------|-------------------------|
| **Security deposit** | Fixed €250 refundable amount |
| **ONLINE deposit** | Charged in Stripe Checkout with rental (or alone) |
| **IN_PERSON deposit** | Due at pickup; not Stripe-refundable here |
| **Allocation** | Split of `amountCents` into rental + deposit cents |
| **Deposit-only Checkout** | Single €250 line when rental payable is €0 |
| **Purpose** | `RENTAL` or `SECURITY_DEPOSIT` on a refund request |
| **PENDING request** | Reserved refund capacity before Stripe confirms |
| **Ops deposit status** | `Booking.securityDepositStatus` bookkeeping |
| **Hold (marketing)** | Refundable period after return — **not** Stripe uncaptured auth |

---

## Summary diagram

```
                 ┌─────────────────────────────────────┐
                 │         Customer Checkout           │
                 │  Rental (optional) + €250 Deposit   │
                 └─────────────────┬───────────────────┘
                                   │ mode: payment (charged)
                                   ▼
                 ┌─────────────────────────────────────┐
                 │ StripePayment                       │
                 │  rentalAmountCents                  │
                 │  depositAmountCents = 25000         │
                 │  amountCents = sum                  │
                 └─────────────────┬───────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
   RENTAL refunds         SECURITY_DEPOSIT refunds    Combined caps
   (anytime eligible)     (COMPLETED, or pre-pickup   (always enforced)
                           cancel exception via API)
```

---

*Document generated from repository source. Live Production schema, dashboard cron settings, and secret values are out of scope for this file — verify those in your environment before go-live.*
