/**
 * createCheckoutSession race-safety + reuse/expiry with mocked Stripe/Prisma/lock.
 * No real Stripe network and no database queries.
 * Lock fencing tests mock renew/persist — they do not prove PostgreSQL CAS SQL.
 *
 *   npm run test:create-checkout-session-line-items
 */

import assert from "node:assert/strict";

import { SECURITY_DEPOSIT_EUR } from "../src/features/booking/lib/booking-schema";
import { allocateCombinedCheckoutAmounts } from "../src/lib/stripe/checkout-allocation";
import {
  buildCheckoutIdempotencyKey,
  CHECKOUT_FORMAT_VERSION,
  type RetrievedCheckoutSession,
} from "../src/lib/stripe/checkout-session-policy";
import {
  CHECKOUT_SESSION_AMBIGUOUS_ERROR,
  CHECKOUT_SESSION_FINALIZE_FAILED_ERROR,
  CHECKOUT_SESSION_IN_PROGRESS_ERROR,
} from "../src/lib/stripe/checkout-stripe-errors";

process.env.DATABASE_URL ??= "postgresql://localhost:5432/explore_malta_test_unused";
process.env.NEXT_PUBLIC_APP_URL ??= "http://localhost:3000";

async function main() {
  const { createCheckoutSession } = await import("../src/lib/stripe/payment-service");
  type CreateCheckoutSessionDeps = import("../src/lib/stripe/payment-service").CreateCheckoutSessionDeps;

  const rental = 175;
  const deposit = SECURITY_DEPOSIT_EUR;
  const allocation = allocateCombinedCheckoutAmounts({
    totalDueOnlineEur: rental + deposit,
    rentalSubtotalEur: rental,
    depositAmountEur: deposit,
    depositMethod: "ONLINE",
  });
  assert.equal(allocation.ok, true);
  if (!allocation.ok) throw new Error("allocation failed");

  const baseInput = {
    bookingId: "booking_1",
    bookingReference: "EMR-1",
    customerEmail: "a@example.com",
    customerName: "Ada",
    vehicleName: "Vespa",
    pickupDate: "01 Jun 2026",
    returnDate: "03 Jun 2026",
    amountEur: rental + deposit,
    rentalSubtotalEur: rental,
    depositAmountEur: deposit,
    depositMethod: "ONLINE" as const,
    locale: "en",
  };

  function matchingOpenSession(overrides: Partial<RetrievedCheckoutSession> = {}): RetrievedCheckoutSession {
    return {
      id: "cs_open_match",
      status: "open",
      url: "https://checkout.stripe.test/cs_open_match",
      currency: "eur",
      amountTotal: allocation.amountCents,
      paymentStatus: "unpaid",
      clientReferenceId: baseInput.bookingReference,
      metadata: {
        bookingId: baseInput.bookingId,
        checkoutVersion: CHECKOUT_FORMAT_VERSION,
        amountCents: String(allocation.amountCents),
        rentalAmountCents: String(allocation.rentalAmountCents),
        depositAmountCents: String(allocation.depositAmountCents),
      },
      lineItemsComplete: true,
      lineItems: [
        {
          amountTotal: allocation.rentalAmountCents,
          amountSubtotal: allocation.rentalAmountCents,
          quantity: 1,
          currency: "eur",
        },
        {
          amountTotal: allocation.depositAmountCents,
          amountSubtotal: allocation.depositAmountCents,
          quantity: 1,
          currency: "eur",
        },
      ],
      ...overrides,
    };
  }

  function createMockDeps(options?: {
    existing?: {
      stripeStatus: string;
      sessionId?: string | null;
      amountCents?: number | null;
      rentalAmountCents?: number | null;
      depositAmountCents?: number | null;
    } | null;
    lockAcquired?: boolean;
    renewOwned?: boolean | "throw";
    persistOwned?: boolean | "throw";
    auditThrows?: boolean;
    findPayment?: () => {
      id: string;
      stripeCheckoutSessionId: string | null;
      stripeStatus: string;
      amountCents: number;
      rentalAmountCents: number;
      depositAmountCents: number;
    } | null;
    retrieve?: (sessionId: string) => Promise<RetrievedCheckoutSession> | RetrievedCheckoutSession;
    retrieveError?: unknown;
    expireImpl?: (sessionId: string) => Promise<{ status: string | null }>;
    createImpl?: () => Promise<{ id: string; url: string | null; payment_intent: string | null }>;
  }) {
    const createdKeys: string[] = [];
    const createdLineItems: Array<{ unitAmountCents: number; name: string }> = [];
    const expireCalls: string[] = [];
    const persistCalls: Array<{ sessionId: string; lockToken: string }> = [];
    let auditCalls = 0;
    let lockAcquireCount = 0;
    let lockReleaseCount = 0;
    let renewCount = 0;
    let payment =
      options?.existing === null
        ? null
        : {
            id: "pay_1",
            stripeCheckoutSessionId:
              options?.existing?.sessionId === undefined
                ? "cs_existing"
                : options.existing.sessionId,
            stripeStatus: options?.existing?.stripeStatus ?? "PENDING",
            amountCents: options?.existing?.amountCents ?? allocation.amountCents,
            rentalAmountCents: options?.existing?.rentalAmountCents ?? allocation.rentalAmountCents,
            depositAmountCents:
              options?.existing?.depositAmountCents ?? allocation.depositAmountCents,
          };

    const deps: CreateCheckoutSessionDeps = {
      findPaymentByBookingId: async () => {
        if (options?.findPayment) {
          return options.findPayment();
        }
        return payment;
      },
      retrieveCheckoutSession: async (sessionId) => {
        if (options?.retrieveError) {
          throw options.retrieveError;
        }
        if (options?.retrieve) {
          return options.retrieve(sessionId);
        }
        if (sessionId === "cs_test_new") {
          return {
            id: sessionId,
            status: "open",
            url: "https://checkout.stripe.test/session",
            currency: "eur",
            amountTotal: allocation.amountCents,
            paymentStatus: "unpaid",
            clientReferenceId: baseInput.bookingReference,
            metadata: {},
            lineItemsComplete: true,
            lineItems: [],
          };
        }
        return {
          id: sessionId,
          status: "expired",
          url: null,
          currency: "eur",
          amountTotal: allocation.amountCents,
          paymentStatus: "unpaid",
          clientReferenceId: baseInput.bookingReference,
          metadata: {},
          lineItemsComplete: true,
          lineItems: [],
        };
      },
      expireCheckoutSession: async (sessionId) => {
        expireCalls.push(sessionId);
        if (options?.expireImpl) {
          return options.expireImpl(sessionId);
        }
        return { status: "expired" };
      },
      createStripeCheckoutSession: async (params) => {
        createdKeys.push(params.idempotencyKey);
        createdLineItems.push(
          ...params.lineItems.map((item) => ({
            unitAmountCents: item.unitAmountCents,
            name: item.name,
          })),
        );
        if (options?.createImpl) {
          return options.createImpl();
        }
        return {
          id: "cs_test_new",
          url: "https://checkout.stripe.test/session",
          payment_intent: "pi_test_1",
        };
      },
      upsertStripePayment: async ({ create }) => {
        if (!payment) {
          payment = {
            id: String(create.id ?? "pay_new"),
            stripeCheckoutSessionId: (create.stripeCheckoutSessionId as string | null) ?? null,
            stripeStatus: String(create.stripeStatus ?? "PENDING"),
            amountCents: Number(create.amountCents),
            rentalAmountCents: Number(create.rentalAmountCents),
            depositAmountCents: Number(create.depositAmountCents),
          };
        }
        return {};
      },
      persistCheckoutSessionIfOwned: async (args) => {
        persistCalls.push({ sessionId: args.stripeCheckoutSessionId, lockToken: args.lockToken });
        if (options?.persistOwned === "throw") {
          throw new Error("persist db error");
        }
        if (options?.persistOwned === false) {
          return false;
        }
        if (!payment) {
          return false;
        }
        payment = {
          ...payment,
          stripeCheckoutSessionId: args.stripeCheckoutSessionId,
          amountCents: args.amountCents,
          rentalAmountCents: args.rentalAmountCents,
          depositAmountCents: args.depositAmountCents,
          stripeStatus: "PENDING",
        };
        return true;
      },
      writeAuditLog: async () => {
        auditCalls += 1;
        if (options?.auditThrows) {
          throw new Error("audit log unavailable");
        }
        return {};
      },
      getBaseUrl: () => "http://localhost:3000",
      createLockToken: () => "lock-token-1",
      lock: {
        trySetCheckoutLock: async () => {
          lockAcquireCount += 1;
          return options?.lockAcquired ?? true;
        },
        renewCheckoutLockIfOwned: async () => {
          renewCount += 1;
          if (options?.renewOwned === "throw") {
            throw new Error("renew db error");
          }
          return options?.renewOwned ?? true;
        },
        clearCheckoutLock: async () => {
          lockReleaseCount += 1;
        },
      },
    };

    return {
      deps,
      createdKeys,
      createdLineItems,
      expireCalls,
      persistCalls,
      setPayment(next: typeof payment) {
        payment = next;
      },
      get payment() {
        return payment;
      },
      get auditCalls() {
        return auditCalls;
      },
      get lockAcquireCount() {
        return lockAcquireCount;
      },
      get lockReleaseCount() {
        return lockReleaseCount;
      },
      get renewCount() {
        return renewCount;
      },
    };
  }

  async function testCreatesTwoLineItems() {
    const mock = createMockDeps({ existing: null });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, true);
    assert.equal(mock.createdLineItems.length, 2);
    assert.equal(
      mock.createdKeys[0],
      buildCheckoutIdempotencyKey({ bookingId: baseInput.bookingId, allocation }),
    );
    assert.equal(mock.renewCount, 1);
    assert.equal(mock.persistCalls.length, 1);
    assert.equal(mock.lockReleaseCount, 1);
  }

  async function testReusesMatchingOpenSession() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_open_match",
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      },
      retrieve: () => matchingOpenSession(),
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sessionId, "cs_open_match");
    }
    assert.equal(mock.createdLineItems.length, 0);
    assert.equal(mock.expireCalls.length, 0);
    // Reuse path renews ownership before returning the URL.
    assert.equal(mock.renewCount, 1);
    assert.equal(mock.lockReleaseCount, 1);
  }

  async function testReuseAbortsWhenLockLost() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_open_match",
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      },
      renewOwned: false,
      retrieve: () => matchingOpenSession(),
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_IN_PROGRESS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 0);
  }

  async function testReuseAbortsWhenStoredSessionReplaced() {
    let finds = 0;
    const matchingPayment = {
      id: "pay_1",
      stripeCheckoutSessionId: "cs_open_match",
      stripeStatus: "PENDING",
      amountCents: allocation.amountCents,
      rentalAmountCents: allocation.rentalAmountCents,
      depositAmountCents: allocation.depositAmountCents,
    };
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_open_match",
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      },
      retrieve: () => matchingOpenSession(),
      findPayment: () => {
        finds += 1;
        // Calls 1–2: pre-lock + under-lock still show the reusable session.
        // Call 3: reuse revalidation sees a replacement session id.
        if (finds <= 2) {
          return matchingPayment;
        }
        return {
          ...matchingPayment,
          stripeCheckoutSessionId: "cs_replacement",
        };
      },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_IN_PROGRESS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 0);
  }

  async function testAuditFailureAfterPersistStillReturnsSuccess() {
    const mock = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      auditThrows: true,
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sessionId, "cs_test_new");
    }
    assert.equal(mock.persistCalls.length, 1);
    assert.equal(mock.auditCalls, 1);
    assert.equal(mock.createdLineItems.length, 2);
  }

  async function testIncompleteLineItemsNotReusedThenExpired() {
    let retrieves = 0;
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_incomplete",
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      },
      retrieve: (sessionId) => {
        retrieves += 1;
        if (sessionId === "cs_test_new") {
          return {
            id: "cs_test_new",
            status: "open",
            url: "https://checkout.stripe.test/session",
            currency: "eur",
            amountTotal: allocation.amountCents,
            paymentStatus: "unpaid",
            clientReferenceId: baseInput.bookingReference,
            metadata: {},
            lineItemsComplete: true,
            lineItems: [],
          };
        }
        if (retrieves === 1) {
          return matchingOpenSession({
            id: "cs_incomplete",
            lineItemsComplete: false,
          });
        }
        return matchingOpenSession({
          id: "cs_incomplete",
          status: "expired",
          url: null,
          lineItemsComplete: true,
          lineItems: [],
        });
      },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, true);
    assert.equal(mock.expireCalls[0], "cs_incomplete");
    assert.equal(mock.createdLineItems.length, 2);
  }

  async function testAmbiguousRetrieveDoesNotCreate() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_ambiguous",
      },
      retrieveError: { statusCode: 500, message: "server" },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_AMBIGUOUS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 0);
    assert.equal(mock.lockReleaseCount, 1);
  }

  async function testMissingSessionAllowsCreate() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_gone",
      },
      retrieveError: { statusCode: 404, code: "resource_missing" },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, true);
    assert.equal(mock.createdLineItems.length, 2);
  }

  async function testExpireFailureWhileOpenDoesNotCreate() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_stuck",
        amountCents: 0,
        rentalAmountCents: 0,
        depositAmountCents: 0,
      },
      retrieve: () =>
        matchingOpenSession({
          id: "cs_stuck",
          metadata: { bookingId: baseInput.bookingId, checkoutVersion: "legacy" },
          lineItems: [
            {
              amountTotal: allocation.amountCents,
              amountSubtotal: allocation.amountCents,
              quantity: 1,
              currency: "eur",
            },
          ],
        }),
      expireImpl: async () => {
        throw new Error("expire failed");
      },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    assert.equal(mock.createdLineItems.length, 0);
    assert.equal(mock.lockReleaseCount, 1);
  }

  async function testLockBusyFailsClosed() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: null,
      },
      lockAcquired: false,
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_IN_PROGRESS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 0);
  }

  async function testConcurrentSecondRequestSeesBusyLock() {
    // Deterministic serialization proof at the lock boundary: first acquires,
    // second is denied before Stripe create. Does not prove DB CAS SQL itself.
    const first = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      lockAcquired: true,
    });
    const second = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      lockAcquired: false,
    });

    const [a, b] = await Promise.all([
      createCheckoutSession(baseInput, first.deps),
      createCheckoutSession(baseInput, second.deps),
    ]);

    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    if (!b.ok) {
      assert.equal(b.error, CHECKOUT_SESSION_IN_PROGRESS_ERROR);
    }
    assert.equal(second.createdLineItems.length, 0);
  }

  async function testSucceededStillBlocked() {
    const mock = createMockDeps({
      existing: { stripeStatus: "SUCCEEDED", sessionId: "cs_paid" },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    assert.equal(mock.createdLineItems.length, 0);
  }

  async function testPaidStripeSessionDoesNotCreateReplacement() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_stripe_paid",
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      },
      retrieve: () =>
        matchingOpenSession({
          id: "cs_stripe_paid",
          status: "complete",
          paymentStatus: "paid",
          url: null,
        }),
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "This booking has already been paid");
    }
    assert.equal(mock.createdLineItems.length, 0);
    assert.equal(mock.expireCalls.length, 0);
  }

  async function testUnexpectedExtraLineItemNotReused() {
    let phase = 0;
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_extra",
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      },
      retrieve: (sessionId) => {
        if (sessionId === "cs_test_new") {
          return {
            id: "cs_test_new",
            status: "open",
            url: "https://checkout.stripe.test/session",
            currency: "eur",
            amountTotal: allocation.amountCents,
            paymentStatus: "unpaid",
            clientReferenceId: baseInput.bookingReference,
            metadata: {},
            lineItemsComplete: true,
            lineItems: [],
          };
        }
        phase += 1;
        if (phase === 1) {
          return matchingOpenSession({
            id: "cs_extra",
            lineItems: [
              ...matchingOpenSession().lineItems,
              {
                amountTotal: 500,
                amountSubtotal: 500,
                quantity: 1,
                currency: "eur",
              },
            ],
          });
        }
        return matchingOpenSession({
          id: "cs_extra",
          status: "expired",
          url: null,
          lineItems: [],
        });
      },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, true);
    assert.equal(mock.expireCalls[0], "cs_extra");
    assert.equal(mock.createdLineItems.length, 2);
  }

  async function testPaginationFailureOnRetrieveFailsClosed() {
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_page_fail",
      },
      retrieveError: new Error("Incomplete checkout line-item pagination"),
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_AMBIGUOUS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 0);
  }

  async function testOwnershipLostBeforeCreateSkipsStripeCreate() {
    const mock = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      renewOwned: false,
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_IN_PROGRESS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 0);
    assert.equal(mock.persistCalls.length, 0);
    assert.equal(mock.renewCount, 1);
  }

  async function testOwnershipCheckDbErrorFailsClosed() {
    const mock = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      renewOwned: "throw",
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_AMBIGUOUS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 0);
  }

  async function testOwnershipLostAfterCreateDoesNotOverwriteAndCompensates() {
    const priorSessionId = "cs_newer_holder";
    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: priorSessionId,
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      },
      // Existing session is already non-open so we proceed to create.
      retrieve: (sessionId) => {
        if (sessionId === "cs_test_new") {
          return {
            id: "cs_test_new",
            status: "open",
            url: "https://checkout.stripe.test/session",
            currency: "eur",
            amountTotal: allocation.amountCents,
            paymentStatus: "unpaid",
            clientReferenceId: baseInput.bookingReference,
            metadata: {},
            lineItemsComplete: true,
            lineItems: [],
          };
        }
        return {
          id: sessionId,
          status: "expired",
          url: null,
          currency: "eur",
          amountTotal: allocation.amountCents,
          paymentStatus: "unpaid",
          clientReferenceId: baseInput.bookingReference,
          metadata: {},
          lineItemsComplete: true,
          lineItems: [],
        };
      },
      persistOwned: false,
      expireImpl: async (sessionId) => {
        assert.equal(sessionId, "cs_test_new");
        return { status: "expired" };
      },
    });

    // After expire of orphan, retrieve must show non-open for compensation success.
    let orphanRetrieves = 0;
    mock.deps.retrieveCheckoutSession = async (sessionId) => {
      if (sessionId === priorSessionId) {
        return {
          id: priorSessionId,
          status: "expired",
          url: null,
          currency: "eur",
          amountTotal: allocation.amountCents,
          paymentStatus: "unpaid",
          clientReferenceId: baseInput.bookingReference,
          metadata: {},
          lineItemsComplete: true,
          lineItems: [],
        };
      }
      orphanRetrieves += 1;
      return {
        id: "cs_test_new",
        status: orphanRetrieves === 1 ? "open" : "expired",
        url: orphanRetrieves === 1 ? "https://checkout.stripe.test/session" : null,
        currency: "eur",
        amountTotal: allocation.amountCents,
        paymentStatus: "unpaid",
        clientReferenceId: baseInput.bookingReference,
        metadata: {},
        lineItemsComplete: true,
        lineItems: [],
      };
    };

    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_IN_PROGRESS_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 2);
    assert.equal(mock.payment?.stripeCheckoutSessionId, priorSessionId);
    assert.ok(mock.expireCalls.includes("cs_test_new"));
    assert.ok(!mock.expireCalls.includes(priorSessionId));
  }

  async function testCompensationFailureFailsClosedWithoutFalseSuccess() {
    const mock = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      persistOwned: false,
      expireImpl: async () => {
        throw new Error("expire failed");
      },
    });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_FINALIZE_FAILED_ERROR);
    }
    assert.equal(mock.createdLineItems.length, 2);
  }

  async function testPersistDbErrorFailsClosed() {
    const mock = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      persistOwned: "throw",
    });
    // Compensation: retrieve open then expire then retrieve expired.
    let orphanRetrieves = 0;
    mock.deps.retrieveCheckoutSession = async () => {
      orphanRetrieves += 1;
      return {
        id: "cs_test_new",
        status: orphanRetrieves === 1 ? "open" : "expired",
        url: orphanRetrieves === 1 ? "https://checkout.stripe.test/session" : null,
        currency: "eur",
        amountTotal: allocation.amountCents,
        paymentStatus: "unpaid",
        clientReferenceId: baseInput.bookingReference,
        metadata: {},
        lineItemsComplete: true,
        lineItems: [],
      };
    };
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_AMBIGUOUS_ERROR);
    }
    assert.ok(mock.expireCalls.includes("cs_test_new"));
  }

  async function testNeverExpiresPaidOrphan() {
    const mock = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
      persistOwned: false,
    });
    mock.deps.retrieveCheckoutSession = async () =>
      matchingOpenSession({
        id: "cs_test_new",
        status: "complete",
        paymentStatus: "paid",
        url: null,
      });
    const result = await createCheckoutSession(baseInput, mock.deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, CHECKOUT_SESSION_FINALIZE_FAILED_ERROR);
    }
    assert.equal(mock.expireCalls.length, 0);
  }

  async function testCreatesDepositOnlyLineItemAndPersistsZeroRental() {
    const depositOnlyAllocation = allocateCombinedCheckoutAmounts({
      totalDueOnlineEur: SECURITY_DEPOSIT_EUR,
      rentalSubtotalEur: 0,
      depositAmountEur: SECURITY_DEPOSIT_EUR,
      depositMethod: "ONLINE",
    });
    assert.equal(depositOnlyAllocation.ok, true);
    if (!depositOnlyAllocation.ok) throw new Error("deposit-only allocation failed");

    const depositOnlyInput = {
      ...baseInput,
      amountEur: SECURITY_DEPOSIT_EUR,
      rentalSubtotalEur: 0,
      depositAmountEur: SECURITY_DEPOSIT_EUR,
    };

    const createdLineItems: Array<{ unitAmountCents: number; name: string }> = [];
    let persistedAllocation: {
      amountCents: number;
      rentalAmountCents: number;
      depositAmountCents: number;
    } | null = null;

    const mock = createMockDeps({
      existing: { stripeStatus: "PENDING", sessionId: null },
    });
    mock.deps.createStripeCheckoutSession = async (params) => {
      createdLineItems.push(
        ...params.lineItems.map((item) => ({
          unitAmountCents: item.unitAmountCents,
          name: item.name,
        })),
      );
      assert.equal(
        params.idempotencyKey,
        buildCheckoutIdempotencyKey({
          bookingId: depositOnlyInput.bookingId,
          allocation: depositOnlyAllocation,
        }),
      );
      return {
        id: "cs_deposit_only",
        url: "https://checkout.stripe.test/deposit-only",
        payment_intent: "pi_deposit_only",
      };
    };
    mock.deps.persistCheckoutSessionIfOwned = async (args) => {
      persistedAllocation = {
        amountCents: args.amountCents,
        rentalAmountCents: args.rentalAmountCents,
        depositAmountCents: args.depositAmountCents,
      };
      return true;
    };

    const result = await createCheckoutSession(depositOnlyInput, mock.deps);
    assert.equal(result.ok, true);
    assert.equal(createdLineItems.length, 1);
    assert.equal(createdLineItems[0]?.unitAmountCents, depositOnlyAllocation.depositAmountCents);
    assert.equal(createdLineItems[0]?.name, "Security Deposit");
    assert.equal(
      createdLineItems.some((item) => item.unitAmountCents === 0 || /rental/i.test(item.name)),
      false,
    );
    assert.deepEqual(persistedAllocation, {
      amountCents: 25000,
      rentalAmountCents: 0,
      depositAmountCents: 25000,
    });
  }

  async function testReusesMatchingDepositOnlyOpenSession() {
    const depositOnlyAllocation = allocateCombinedCheckoutAmounts({
      totalDueOnlineEur: SECURITY_DEPOSIT_EUR,
      rentalSubtotalEur: 0,
      depositAmountEur: SECURITY_DEPOSIT_EUR,
      depositMethod: "ONLINE",
    });
    assert.equal(depositOnlyAllocation.ok, true);
    if (!depositOnlyAllocation.ok) throw new Error("deposit-only allocation failed");

    const depositOnlyInput = {
      ...baseInput,
      amountEur: SECURITY_DEPOSIT_EUR,
      rentalSubtotalEur: 0,
      depositAmountEur: SECURITY_DEPOSIT_EUR,
    };

    const mock = createMockDeps({
      existing: {
        stripeStatus: "PENDING",
        sessionId: "cs_dep_open",
        amountCents: depositOnlyAllocation.amountCents,
        rentalAmountCents: 0,
        depositAmountCents: depositOnlyAllocation.depositAmountCents,
      },
      retrieve: () => ({
        id: "cs_dep_open",
        status: "open",
        url: "https://checkout.stripe.test/cs_dep_open",
        currency: "eur",
        amountTotal: depositOnlyAllocation.amountCents,
        paymentStatus: "unpaid",
        clientReferenceId: depositOnlyInput.bookingReference,
        metadata: {
          bookingId: depositOnlyInput.bookingId,
          checkoutVersion: CHECKOUT_FORMAT_VERSION,
          amountCents: String(depositOnlyAllocation.amountCents),
          rentalAmountCents: "0",
          depositAmountCents: String(depositOnlyAllocation.depositAmountCents),
        },
        lineItemsComplete: true,
        lineItems: [
          {
            amountTotal: depositOnlyAllocation.depositAmountCents,
            amountSubtotal: depositOnlyAllocation.depositAmountCents,
            quantity: 1,
            currency: "eur",
          },
        ],
      }),
    });

    const result = await createCheckoutSession(depositOnlyInput, mock.deps);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.sessionId, "cs_dep_open");
      assert.equal(result.checkoutUrl, "https://checkout.stripe.test/cs_dep_open");
    }
    assert.equal(mock.createdKeys.length, 0);
  }

  await testCreatesTwoLineItems();
  await testCreatesDepositOnlyLineItemAndPersistsZeroRental();
  await testReusesMatchingOpenSession();
  await testReusesMatchingDepositOnlyOpenSession();
  await testReuseAbortsWhenLockLost();
  await testReuseAbortsWhenStoredSessionReplaced();
  await testAuditFailureAfterPersistStillReturnsSuccess();
  await testIncompleteLineItemsNotReusedThenExpired();
  await testAmbiguousRetrieveDoesNotCreate();
  await testMissingSessionAllowsCreate();
  await testExpireFailureWhileOpenDoesNotCreate();
  await testLockBusyFailsClosed();
  await testConcurrentSecondRequestSeesBusyLock();
  await testSucceededStillBlocked();
  await testPaidStripeSessionDoesNotCreateReplacement();
  await testUnexpectedExtraLineItemNotReused();
  await testPaginationFailureOnRetrieveFailsClosed();
  await testOwnershipLostBeforeCreateSkipsStripeCreate();
  await testOwnershipCheckDbErrorFailsClosed();
  await testOwnershipLostAfterCreateDoesNotOverwriteAndCompensates();
  await testCompensationFailureFailsClosedWithoutFalseSuccess();
  await testPersistDbErrorFailsClosed();
  await testNeverExpiresPaidOrphan();
  console.log("test-create-checkout-session-line-items: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
