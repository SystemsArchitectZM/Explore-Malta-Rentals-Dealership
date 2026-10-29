# Stripe Payment Integration — Explore Malta Rentals

> **Author:** AI Senior Engineer  
> **Date:** June 2026  
> **Stack:** Next.js 16 · Prisma 7 · PostgreSQL (Neon) · Stripe API v2026-05-27  

---

## Table of Contents

1. [Overview](#1-overview)
2. [How the Payment Flow Works](#2-how-the-payment-flow-works)
3. [Environment Variables](#3-environment-variables)
4. [Folder Structure](#4-folder-structure)
5. [Database Schema — New Tables](#5-database-schema--new-tables)
6. [Service Layer](#6-service-layer)
7. [API Routes](#7-api-routes)
8. [UI Pages](#8-ui-pages)
9. [Webhook Event Handling](#9-webhook-event-handling)
10. [Refund System](#10-refund-system)
11. [Security Design](#11-security-design)
12. [Error Handling & Edge Cases](#12-error-handling--edge-cases)
13. [Admin Payments Dashboard](#13-admin-payments-dashboard)
14. [Testing with Stripe Test Cards](#14-testing-with-stripe-test-cards)
15. [Going Live — Production Checklist](#15-going-live--production-checklist)

---

## 1. Overview

Before this integration, the booking system created bookings as **Confirmed + Payment Pending** and the customer paid cash or card at vehicle pickup. There was no online payment.

This integration adds **full Stripe Checkout** so customers pay online at the time of booking. The vehicle is only fully confirmed after Stripe sends a webhook confirming the payment succeeded.

### Key design principles

| Principle | Implementation |
|-----------|---------------|
| **Never confirm before payment** | Email is sent only after the webhook fires, not at booking creation |
| **Idempotent** | Every webhook is deduplicated by `stripeEventId`. Checkout sessions are reused if still open |
| **Fault tolerant** | If the webhook arrives twice, the second one is silently skipped |
| **Non-blocking** | Audit log failures never break the payment flow |
| **Secure** | Webhook signature verified with HMAC-SHA256. Secret keys are server-only |

---

## 2. How the Payment Flow Works

### Step-by-step — Happy Path

```
Customer fills booking wizard
        │
        ▼
POST /api/bookings
  → Booking created in DB
  → Status: CONFIRMED
  → paymentStatus: PENDING
  → Vehicle unit: RESERVED
  → No confirmation email yet
  → Returns: { bookingReference, bookingId, totalDueOnline }
        │
        ▼  (if totalDueOnline > 0)
POST /api/stripe/checkout
  → StripePayment record created in DB
  → Stripe Checkout Session created (30-min expiry)
  → Returns: { checkoutUrl }
        │
        ▼
window.location.href = checkoutUrl
  → Customer lands on Stripe's hosted payment page
  → Enters card details securely on Stripe's servers
        │
        ▼  (customer pays)
Stripe redirects → /en/booking/payment/success?session_id=cs_xxx
        │
        ▼  (simultaneously, async)
POST /api/stripe/webhook  ← Stripe sends this
  Event: checkout.session.completed
  → Verify HMAC signature
  → Check WebhookEvent table (idempotency)
  → Update StripePayment.stripeStatus = SUCCEEDED
  → Update Booking.paymentStatus = PAID
  → Send confirmation email to customer
        │
        ▼
Success page verifies session with Stripe directly
  → Shows: booking reference, amount paid, full booking details
  → "View My Booking" button → /booking?ref=EMR-xxx
```

### What happens if payment fails / is cancelled

```
Customer closes browser or clicks Cancel on Stripe
        │
        ▼
Stripe redirects → /en/booking/payment/cancel?ref=EMR-xxx
        │
Stripe sends webhook → payment_intent.payment_failed  (or .canceled)
  → Update StripePayment.stripeStatus = FAILED / CANCELLED
  → Update Booking.paymentStatus = FAILED
  → Release VehicleUnit.status = AVAILABLE  ← vehicle is freed for others
        │
Cancel page shows:
  → Booking details (vehicle, dates, amount due)
  → "Pay €XX now" retry button → creates fresh Stripe session
  → WhatsApp + email contact links
```

---

## 3. Environment Variables

Add these to your `.env` file:

```env
# ─── Stripe ────────────────────────────────────────────────────────────────────

# From: https://dashboard.stripe.com/apikeys
# Use sk_test_... / pk_test_... in development. Switch to live keys for production.
STRIPE_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..."

# From: stripe listen --forward-to localhost:3000/api/stripe/webhook  (development)
# Or: Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret (production)
STRIPE_WEBHOOK_SECRET="whsec_..."

# Canonical app URL — no trailing slash
# Development:  http://localhost:3000
# Production:   https://exploremaltarentals.com
NEXT_PUBLIC_APP_URL="http://localhost:3000"
```

> ⚠️ `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are **server-only**. Never expose them to the browser.
> `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is safe to expose to the browser (it is a public key by design).

---

## 4. Folder Structure

```
src/
├── lib/
│   └── stripe/
│       ├── stripe-client.ts        ← Stripe SDK singleton
│       ├── types.ts                ← Shared input/result types
│       ├── payment-service.ts      ← Create sessions, verify payments
│       ├── webhook-service.ts      ← Process all webhook events
│       ├── refund-service.ts       ← Full & partial refunds
│       ├── audit-service.ts        ← Immutable audit log writer
│       └── index.ts                ← Public exports
│
├── app/
│   └── api/
│       └── stripe/
│           ├── checkout/route.ts           ← POST: create checkout session
│           ├── webhook/route.ts            ← POST: receive Stripe webhooks
│           ├── checkout-redirect/route.ts  ← GET: server-side retry redirect
│           └── verify-session/route.ts     ← GET: poll payment status
│       └── admin/
│           └── payments/
│               ├── route.ts                ← GET: paginated payments list
│               └── [id]/refund/route.ts    ← POST: initiate refund
│
│   └── [locale]/(site)/booking/payment/
│       ├── success/
│       │   ├── page.tsx                    ← Server-rendered success page
│       │   └── payment-verifying-poller.tsx ← Client component: polls until confirmed
│       └── cancel/
│           ├── page.tsx                    ← Server-rendered cancel page
│           └── retry-payment-button.tsx    ← Client component: retry payment
│
prisma/
├── schema.prisma                   ← 5 new models added
└── migrations/
    └── 20260613120000_stripe_payment_tables/
        └── migration.sql
```

---

## 5. Database Schema — New Tables

### StripePayment

One row per booking. The central payment record.

| Column | Type | Description |
|--------|------|-------------|
| `id` | String (cuid) | Primary key |
| `bookingId` | String (unique) | Links to `Booking.id` |
| `stripePaymentIntentId` | String (unique) | Stripe's PaymentIntent ID (`pi_xxx`) |
| `stripeCheckoutSessionId` | String (unique) | Stripe's Session ID (`cs_xxx`) |
| `amountCents` | Int | Amount charged in euro cents (e.g. 15000 = €150.00) |
| `currency` | String | Always `eur` |
| `stripeStatus` | Enum | `PENDING → SUCCEEDED / FAILED / CANCELLED / REFUNDED / DISPUTED` |
| `refundStatus` | Enum | `NONE / PENDING / PARTIAL / FULL / FAILED` |
| `refundedAmountCents` | Int | Running total of refunded cents |
| `metadata` | JSON | Customer name, vehicle, dates snapshot |

### StripeTransaction

One row per charge or refund event.

| Column | Type | Description |
|--------|------|-------------|
| `transactionType` | String | `charge` or `refund` |
| `stripeTransactionId` | String (unique) | Stripe charge/refund ID |
| `amountCents` | Int | Transaction amount |
| `status` | String | `succeeded / pending / failed` |

### StripeRefund

One row per refund issued.

| Column | Type | Description |
|--------|------|-------------|
| `stripeRefundId` | String (unique) | Stripe refund ID (`re_xxx`) |
| `amountCents` | Int | Refunded amount in cents |
| `reason` | Enum | `DUPLICATE / FRAUDULENT / REQUESTED_BY_CUSTOMER / ADMIN_INITIATED / BOOKING_CANCELLED / FAILED_BOOKING` |
| `status` | String | `pending / succeeded / failed / canceled` |
| `initiatedBy` | String | Admin ID or `"system"` |
| `notes` | String | Optional admin notes |

### WebhookEvent

Idempotency store — every Stripe webhook received is recorded here.

| Column | Type | Description |
|--------|------|-------------|
| `stripeEventId` | String (unique) | Stripe event ID (`evt_xxx`) — prevents duplicate processing |
| `eventType` | String | e.g. `checkout.session.completed` |
| `processed` | Boolean | Set to `true` once handled successfully (written together with `status = PROCESSED`) |
| `processedAt` | DateTime | When it was processed |
| `payload` | JSON | Full Stripe event payload (for debugging/replay) |
| `error` | String | Truncated error text of the last failure (history) |
| `status` | Enum | `RECEIVED`, `PROCESSING`, `PROCESSED`, `RETRYABLE_FAILED`, `DEAD_LETTER` |
| `claimToken` / `claimExpiresAt` | String / DateTime | Current lease owner and expiry (database clock); null unless `PROCESSING` |
| `claimGeneration` | Int | Fencing value, incremented on every claim |
| `attemptCount` | Int | Claims acquired (handler attempts started) |
| `lastErrorCode` / `lastAttemptAt` | String / DateTime | Stable failure code and last attempt time |

### PaymentAuditLog

Immutable audit trail — every payment action is logged.

| Column | Type | Description |
|--------|------|-------------|
| `bookingId` | String | Related booking |
| `stripePaymentId` | String | Related payment |
| `action` | String | e.g. `checkout_session_created`, `payment_succeeded`, `refund_initiated` |
| `actor` | String | Customer email, `admin:id`, or `stripe-webhook` |
| `oldValue` | JSON | Previous state |
| `newValue` | JSON | New state |
| `ipAddress` | String | For security events |

---

## 6. Service Layer

### `stripe-client.ts`

Creates one singleton Stripe SDK instance for the whole application.

```typescript
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-05-27.dahlia",
  maxNetworkRetries: 3,   // auto-retries transient errors
  timeout: 30_000,        // 30s per Stripe API call
});
```

### `payment-service.ts`

**`createCheckoutSession(input)`**  
Creates a Stripe Checkout Session with:
- Line item: vehicle name + booking dates + amount
- `success_url` → `/[locale]/booking/payment/success?session_id={CHECKOUT_SESSION_ID}`
- `cancel_url` → `/[locale]/booking/payment/cancel?ref=EMR-xxx`
- 30-minute session expiry
- Idempotency: if a pending session already exists for the booking, reuses it

**`verifyCheckoutSession(sessionId)`**  
Called by the success page. Fetches the session from Stripe directly (not just from DB) so it works even before the webhook arrives. Returns full booking details including:
- Vehicle name, pickup/return dates
- Amount paid and timestamp
- Stripe receipt URL

### `webhook-service.ts`

**`constructWebhookEvent(rawBody, signature)`**  
Verifies the Stripe signature using `HMAC-SHA256`. Throws if invalid.

**`processWebhookEvent(event)`**  
Idempotent — claims `WebhookEvent.stripeEventId` with a lease-based atomic claim before doing any work and returns a typed outcome (`processed`, `ignored`, `already_processed`, `in_flight`, `retryable_failure`, `permanent_failure`). See [stripe-webhook-reliability.md](./stripe-webhook-reliability.md). Handles the event types in section 9.

### `refund-service.ts`

**`createRefund(input)`**  
Admin-only. Validates the payment is in `SUCCEEDED` state, checks the refundable balance, calls `stripe.refunds.create()`, then updates `StripePayment.refundedAmountCents` and creates a `StripeRefund` record.

### `audit-service.ts`

**`writePaymentAuditLog(...)`**  
Fire-and-forget audit writer. Failures are swallowed so they never break the main payment flow.

---

## 7. API Routes

### `POST /api/stripe/checkout`

Creates a Stripe Checkout Session for a pending booking.

**Request body:**
```json
{ "bookingReference": "EMR-20260614-A1B2", "locale": "en" }
```

**Response (success):**
```json
{ "ok": true, "checkoutUrl": "https://checkout.stripe.com/pay/cs_xxx..." }
```

**Guards:**
- Booking must exist
- `paymentStatus` must not be `PAID` or `REFUNDED`
- `totalDueOnline` must be > 0

---

### `POST /api/stripe/webhook`

Receives all Stripe webhook events. **Must receive the raw body** for signature verification.

```
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Returns `200` for processed, ignored, already-processed and permanently dead-lettered events (a terminal decision was durably recorded).  
Returns `503` (with `Retry-After`) for an in-flight duplicate, and `500` for any incomplete or retryable processing, so Stripe will retry. Stuck events are additionally recoverable through the ADMIN recovery endpoint. See [stripe-webhook-reliability.md](./stripe-webhook-reliability.md).

---

### `GET /api/stripe/verify-session?session_id=cs_xxx`

Lightweight polling endpoint used by the success page. Returns `{ paymentStatus: "paid" | "pending" | "unpaid" }`.

---

### `GET /api/stripe/checkout-redirect?ref=EMR-xxx&locale=en`

Server-side redirect used by the "Retry Payment" link. Creates a fresh Checkout Session and immediately redirects to Stripe.

---

### `GET /api/admin/payments`

Paginated list of all Stripe payments. Admin-only (requires session cookie).

**Query params:** `?page=1&limit=20&status=SUCCEEDED&search=EMR-xxx`

---

### `POST /api/admin/payments/[id]/refund`

Initiates a full or partial refund. Admin-only.

**Request body:**
```json
{
  "amountEur": 75.00,              // optional — omit for full refund
  "reason": "requested_by_customer",
  "notes": "Customer cancelled trip due to illness"
}
```

---

## 8. UI Pages

### Success Page — `/[locale]/booking/payment/success`

A **server-rendered** page that verifies the Stripe session.

**3 states:**

| State | Condition | What shows |
|-------|-----------|-----------|
| **Confirmed** | `session.payment_status === "paid"` | Full success UI with booking summary |
| **Verifying** | Session exists but payment not yet confirmed | Client-side spinner, polls every 2s for 30s |
| **Error** | Session not found or verification failed | Helpful message with contact info |

**Confirmed state shows:**
- ✅ Green banner — "Your rental is booked!"
- Booking reference (large monospace)
- Amount paid + timestamp
- Link to Stripe receipt
- Full booking summary: vehicle, pickup date, return date, duration, location
- Security deposit reminder (€250 at pickup)
- "What to bring" checklist (licence, passport, deposit)
- "View My Booking" → `/booking?ref=EMR-xxx`

### Cancel Page — `/[locale]/booking/payment/cancel`

**Shows:**
- ❌ Red banner — "Payment cancelled"
- Clear message: vehicle is NOT yet secured
- Urgency warning: another customer can book it
- Full booking details fetched from DB
- **"Pay €XX now" button** — creates a new Stripe session client-side with loading state
- Already-paid guard: if customer arrives here after paying, shows green "already paid" screen

---

## 9. Webhook Event Handling

| Event | Action |
|-------|--------|
| `checkout.session.completed` | Mark `StripePayment → SUCCEEDED`, `Booking.paymentStatus → PAID`, send confirmation email |
| `payment_intent.succeeded` | Safety net if checkout event was missed — same as above |
| `payment_intent.payment_failed` | Mark payment `FAILED`, booking `FAILED`, release vehicle unit |
| `payment_intent.canceled` | Mark payment `CANCELLED`, release vehicle unit |
| `charge.refunded` | Update refund status/amount, mark booking `REFUNDED` if full |
| `charge.dispute.created` | Mark payment `DISPUTED`, log for admin review |
| `charge.dispute.closed` | Log dispute outcome |
| `refund.created` | Create/upsert `StripeRefund` record |
| `refund.updated` | Update `StripeRefund.status` |

**Idempotency guarantee:** Each event id is claimed through an atomic, lease-based conditional update before any handler runs; processed events are skipped without invoking handlers, and a stale worker cannot finalize a newer worker's claim. Delivery is at-least-once with idempotent handlers (not exactly-once across PostgreSQL and Stripe). See [stripe-webhook-reliability.md](./stripe-webhook-reliability.md) for the state machine, HTTP policy and recovery behaviour.

---

## 10. Refund System

### How to issue a refund (admin)

1. Go to Admin → Payments
2. Find the payment record
3. Click "Refund"
4. Enter amount (leave blank for full refund) and reason
5. Submit → `POST /api/admin/payments/[id]/refund`

### What happens internally

```
Admin submits refund
        │
        ▼
Validate: payment must be SUCCEEDED
Validate: amountEur ≤ remaining refundable balance
        │
        ▼
stripe.refunds.create({ payment_intent, amount, reason })
        │
        ▼
DB transaction:
  - StripePayment.refundedAmountCents += amountCents
  - StripePayment.refundStatus = PARTIAL or FULL
  - StripePayment.stripeStatus = PARTIALLY_REFUNDED or REFUNDED
  - StripeRefund record created
  - Booking.paymentStatus = REFUNDED (if full refund)
        │
        ▼
Stripe fires refund.created webhook → StripeRefund record upserted
PaymentAuditLog entry written
```

---

## 11. Security Design

| Concern | Solution |
|---------|---------|
| Fake webhook requests | HMAC-SHA256 signature verified using `STRIPE_WEBHOOK_SECRET` before any processing |
| Replay attacks | `WebhookEvent.stripeEventId` unique constraint — duplicate events silently skipped |
| Exposing secret keys | `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are server-only env vars, never sent to browser |
| Double payment | `StripePayment.bookingId` is `@unique` — one payment record per booking, enforced at DB level |
| Amount tampering | Amount is always read from `Booking.totalDueOnline` in the database, never from the client request |
| Admin routes | All `/api/admin/*` routes require a valid admin session cookie (`requireAdminApi()`) |

---

## 12. Error Handling & Edge Cases

| Scenario | What happens |
|----------|-------------|
| User clicks "Pay" twice | Second call to `/api/stripe/checkout` reuses the existing open Stripe session (idempotent) |
| User closes browser after paying | Webhook still arrives and updates the booking. Email is sent. |
| Webhook arrives twice | Second event is skipped — `WebhookEvent.processed = true` |
| User refreshes success page | `verifyCheckoutSession` re-checks Stripe directly — shows correct status |
| Payment fails | `paymentStatus → FAILED`, vehicle unit released back to `AVAILABLE` |
| Stripe times out during checkout creation | `createCheckoutSession` returns `{ ok: false, error }` — booking-flow shows inline error |
| DB down during webhook | Webhook returns `500` → Stripe retries later |
| Webhook arrives before redirect | Success page polls every 2 seconds until confirmed (up to 30s) |
| User retries on cancel page | Creates a fresh Checkout Session (old one may have expired) |
| Admin issues refund for already-refunded booking | `refundedAmountCents` guard prevents over-refunding |

---

## 13. Admin Payments Dashboard

**API:** `GET /api/admin/payments?page=1&limit=20&status=SUCCEEDED&search=EMR-xxx`

Returns for each payment:
- Booking reference, customer name/email, vehicle
- Amount, currency, Stripe status
- Refund status and total refunded
- Stripe checkout session ID and payment intent ID
- List of individual refunds

**Refund API:** `POST /api/admin/payments/[id]/refund`

---

## 14. Testing with Stripe Test Cards

Use these card numbers on Stripe's test checkout page:

| Scenario | Card Number | Result |
|----------|-------------|--------|
| ✅ Successful payment | `4242 4242 4242 4242` | Pays immediately |
| ❌ Card declined | `4000 0000 0000 0002` | Generic decline |
| 🔐 3D Secure required | `4000 0025 0000 3155` | Triggers authentication |
| 💳 Insufficient funds | `4000 0000 0000 9995` | Insufficient funds error |
| 📅 Expired card | `4000 0000 0000 0069` | Expired card error |

Use any future expiry date, any 3-digit CVV, any postcode.

### Test the webhook locally

```bash
# Terminal 1 — Start the dev server
npm run dev

# Terminal 2 — Start the Stripe CLI listener
stripe listen --forward-to localhost:3000/api/stripe/webhook

# Terminal 3 — Trigger a test event manually
stripe trigger checkout.session.completed
stripe trigger payment_intent.payment_failed
stripe trigger charge.refunded
```

---

## 15. Going Live — Production Checklist

Before switching to live Stripe keys:

- [ ] Replace `sk_test_...` → `sk_live_...` in production env
- [ ] Replace `pk_test_...` → `pk_live_...` in production env
- [ ] Register webhook endpoint in Stripe Dashboard:
  - URL: `https://exploremaltarentals.com/api/stripe/webhook`
  - Events: `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `refund.created`, `refund.updated`
- [ ] Copy the live webhook signing secret → `STRIPE_WEBHOOK_SECRET` in production env
- [ ] Set `NEXT_PUBLIC_APP_URL=https://exploremaltarentals.com`
- [ ] Run `prisma migrate deploy` (or confirm `db push` was applied) on production DB
- [ ] Test with a real card (small amount, then refund)
- [ ] Verify confirmation email arrives after payment
- [ ] Verify booking lookup shows correct payment status
- [ ] Confirm `PaymentAuditLog` is recording entries

---

## Quick Reference — Payment Status Lifecycle

```
Booking created
      │
      ▼
paymentStatus: PENDING
stripeStatus:  PENDING
      │
      ├──► Customer pays ──────────────────────────────────────► paymentStatus: PAID
      │                                                           stripeStatus: SUCCEEDED
      │
      ├──► Customer cancels / card declined ──────────────────► paymentStatus: FAILED
      │                                                           stripeStatus: FAILED / CANCELLED
      │                                                           VehicleUnit: AVAILABLE (released)
      │
      └──► After PAID ─► Admin full refund ──────────────────► paymentStatus: REFUNDED
                                                                 stripeStatus: REFUNDED
                                                                 refundStatus: FULL

                       ─► Admin partial refund ────────────► paymentStatus: PAID (unchanged)
                                                               stripeStatus: PARTIALLY_REFUNDED
                                                               refundStatus: PARTIAL

                       ─► Dispute raised by customer ──────► stripeStatus: DISPUTED
```
