import { format } from "date-fns";
import { stripe } from "./stripe-client";
import { prisma } from "@/lib/prisma";
import { writePaymentAuditLog } from "./audit-service";
import {
  shouldSyncPaidBookingForStripeStatus,
  syncPaidBookingAndSendConfirmation,
} from "./confirm-paid-booking";
import {
  allocateCombinedCheckoutAmounts,
  buildCombinedCheckoutLineItems,
  checkoutLineItemsMatchAllocation,
} from "./checkout-allocation";
import {
  buildCheckoutIdempotencyKey,
  canReuseOpenCheckoutSession,
  CHECKOUT_FORMAT_VERSION,
  isCheckoutSessionConfirmedNotOpen,
  isCheckoutSessionPaidOrComplete,
  type RetrievedCheckoutSession,
  type StoredStripePaymentForReuse,
} from "./checkout-session-policy";
import {
  acquireCheckoutOperationLock,
  CHECKOUT_LOCK_TTL_MS,
  releaseCheckoutOperationLock,
  renewCheckoutOperationLockIfOwned,
  type CheckoutLockDeps,
} from "./checkout-operation-lock";
import {
  CHECKOUT_SESSION_AMBIGUOUS_ERROR,
  CHECKOUT_SESSION_FINALIZE_FAILED_ERROR,
  CHECKOUT_SESSION_IN_PROGRESS_ERROR,
  classifyCheckoutSessionError,
} from "./checkout-stripe-errors";
import { listAllCheckoutLineItems } from "./checkout-line-items";
import type { CreateCheckoutSessionInput, CreateCheckoutSessionResult } from "./types";

const CURRENCY = "eur";

function getAppBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!url) {
    throw new Error("NEXT_PUBLIC_APP_URL environment variable is not set");
  }
  return url;
}

export type CreateCheckoutSessionDeps = {
  findPaymentByBookingId: (bookingId: string) => Promise<StoredStripePaymentForReuse | null>;
  /**
   * Must return complete line items (`lineItemsComplete: true`) or throw.
   * Confirmed missing sessions should reject with a Stripe-like resource_missing/404 error.
   */
  retrieveCheckoutSession: (sessionId: string) => Promise<RetrievedCheckoutSession>;
  expireCheckoutSession: (sessionId: string) => Promise<{ status: string | null }>;
  createStripeCheckoutSession: (params: {
    lineItems: Array<{
      name: string;
      description: string;
      unitAmountCents: number;
      quantity: number;
      metadata?: Record<string, string>;
    }>;
    customerEmail: string;
    bookingId: string;
    bookingReference: string;
    customerName: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
    sessionMetadata: Record<string, string>;
  }) => Promise<{ id: string; url: string | null; payment_intent: string | null }>;
  upsertStripePayment: (args: {
    bookingId: string;
    create: Record<string, unknown>;
    update: Record<string, unknown>;
  }) => Promise<unknown>;
  /**
   * Atomically persists the new Checkout Session only while `lockToken` still
   * owns metadata.checkoutLock and the payment is not SUCCEEDED.
   * Returns true when the row was updated.
   */
  persistCheckoutSessionIfOwned: (args: {
    bookingId: string;
    lockToken: string;
    stripeCheckoutSessionId: string;
    stripePaymentIntentId: string | null;
    amountCents: number;
    rentalAmountCents: number;
    depositAmountCents: number;
  }) => Promise<boolean>;
  writeAuditLog: (args: {
    bookingId: string;
    action: string;
    actor: string;
    newValue: Record<string, unknown>;
  }) => Promise<unknown>;
  getBaseUrl: () => string;
  lock: CheckoutLockDeps;
  createLockToken?: () => string;
};

function defaultCreateCheckoutSessionDeps(): CreateCheckoutSessionDeps {
  return {
    findPaymentByBookingId: async (bookingId) =>
      prisma.stripePayment.findUnique({
        where: { bookingId },
        select: {
          id: true,
          stripeCheckoutSessionId: true,
          stripeStatus: true,
          amountCents: true,
          rentalAmountCents: true,
          depositAmountCents: true,
        },
      }),
    retrieveCheckoutSession: async (sessionId) => {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // Never use expanded session.line_items alone — paginate via list API.
      const lineItems = await listAllCheckoutLineItems(sessionId, async ({ startingAfter, limit }) => {
        const page = await stripe.checkout.sessions.listLineItems(sessionId, {
          limit,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
        return {
          data: page.data.map((item) => ({
            id: item.id,
            amount_total: item.amount_total,
            amount_subtotal: item.amount_subtotal,
            quantity: item.quantity,
            currency: item.currency,
          })),
          has_more: page.has_more,
        };
      });
      return {
        id: session.id,
        status: session.status,
        url: session.url,
        currency: session.currency,
        amountTotal: session.amount_total,
        paymentStatus: session.payment_status,
        clientReferenceId: session.client_reference_id,
        metadata: (session.metadata ?? null) as Record<string, string> | null,
        lineItemsComplete: true,
        lineItems,
      };
    },
    expireCheckoutSession: async (sessionId) => {
      const session = await stripe.checkout.sessions.expire(sessionId);
      return { status: session.status };
    },
    createStripeCheckoutSession: async (params) => {
      const session = await stripe.checkout.sessions.create(
        {
          payment_method_types: ["card"],
          mode: "payment",
          customer_email: params.customerEmail,
          client_reference_id: params.bookingReference,
          line_items: params.lineItems.map((item) => ({
            price_data: {
              currency: CURRENCY,
              product_data: {
                name: item.name,
                description: item.description,
                metadata: item.metadata,
              },
              unit_amount: item.unitAmountCents,
            },
            quantity: item.quantity,
          })),
          metadata: params.sessionMetadata,
          success_url: params.successUrl,
          cancel_url: params.cancelUrl,
          expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
          payment_intent_data: {
            metadata: {
              bookingId: params.bookingId,
              bookingReference: params.bookingReference,
            },
            description: `Explore Malta Rentals — ${params.bookingReference}`,
            receipt_email: params.customerEmail,
          },
          locale: "en",
          allow_promotion_codes: false,
        },
        { idempotencyKey: params.idempotencyKey },
      );

      return {
        id: session.id,
        url: session.url,
        payment_intent:
          typeof session.payment_intent === "string" ? session.payment_intent : null,
      };
    },
    upsertStripePayment: async ({ bookingId, create, update }) =>
      prisma.stripePayment.upsert({
        where: { bookingId },
        create: create as never,
        update: update as never,
      }),
    persistCheckoutSessionIfOwned: async ({
      bookingId,
      lockToken,
      stripeCheckoutSessionId,
      stripePaymentIntentId,
      amountCents,
      rentalAmountCents,
      depositAmountCents,
    }) => {
      const updated = await prisma.$executeRaw`
        UPDATE "StripePayment"
        SET
          "stripeCheckoutSessionId" = ${stripeCheckoutSessionId},
          "stripePaymentIntentId" = ${stripePaymentIntentId},
          "amountCents" = ${amountCents},
          "rentalAmountCents" = ${rentalAmountCents},
          "depositAmountCents" = ${depositAmountCents},
          "stripeStatus" = CAST('PENDING' AS "StripePaymentStatus"),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "bookingId" = ${bookingId}
          AND metadata->'checkoutLock'->>'token' = ${lockToken}
          AND "stripeStatus" <> CAST('SUCCEEDED' AS "StripePaymentStatus")
      `;
      return Number(updated) === 1;
    },
    writeAuditLog: async (args) =>
      writePaymentAuditLog({
        bookingId: args.bookingId,
        action: args.action as "checkout_session_created",
        actor: args.actor,
        newValue: args.newValue,
      }),
    getBaseUrl: getAppBaseUrl,
    lock: {
      trySetCheckoutLock: async ({ bookingId, token, expiresAtIso, nowIso }) => {
        // Atomic CAS on metadata.checkoutLock without holding a long transaction.
        const updated = await prisma.$executeRaw`
          UPDATE "StripePayment"
          SET
            metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{checkoutLock}',
              jsonb_build_object('token', ${token}::text, 'expiresAt', ${expiresAtIso}::text),
              true
            ),
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "bookingId" = ${bookingId}
            AND (
              metadata->'checkoutLock' IS NULL
              OR COALESCE(metadata->'checkoutLock'->>'expiresAt', '') = ''
              OR (metadata->'checkoutLock'->>'expiresAt') < ${nowIso}
            )
        `;
        return Number(updated) === 1;
      },
      renewCheckoutLockIfOwned: async ({ bookingId, token, expiresAtIso }) => {
        const updated = await prisma.$executeRaw`
          UPDATE "StripePayment"
          SET
            metadata = jsonb_set(
              COALESCE(metadata, '{}'::jsonb),
              '{checkoutLock}',
              jsonb_build_object('token', ${token}::text, 'expiresAt', ${expiresAtIso}::text),
              true
            ),
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "bookingId" = ${bookingId}
            AND metadata->'checkoutLock'->>'token' = ${token}
        `;
        return Number(updated) === 1;
      },
      clearCheckoutLock: async ({ bookingId, token }) => {
        await prisma.$executeRaw`
          UPDATE "StripePayment"
          SET
            metadata = COALESCE(metadata, '{}'::jsonb) - 'checkoutLock',
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE "bookingId" = ${bookingId}
            AND metadata->'checkoutLock'->>'token' = ${token}
        `;
      },
    },
  };
}

/**
 * Expire an orphan Checkout Session created after lock ownership was lost.
 * Never expires paid/complete sessions. Only targets the session id we created.
 */
async function compensateOrphanCheckoutSession(
  deps: Pick<CreateCheckoutSessionDeps, "retrieveCheckoutSession" | "expireCheckoutSession">,
  bookingId: string,
  orphanSessionId: string,
): Promise<"expired" | "already_non_payable" | "failed"> {
  let session: RetrievedCheckoutSession;
  try {
    session = await deps.retrieveCheckoutSession(orphanSessionId);
  } catch (error) {
    if (classifyCheckoutSessionError(error) === "missing") {
      return "already_non_payable";
    }
    console.error("[payment-service] Ambiguous orphan session retrieve during compensation", {
      bookingId,
      sessionId: orphanSessionId,
    });
    return "failed";
  }

  if (isCheckoutSessionPaidOrComplete(session)) {
    console.error("[payment-service] Orphan checkout session is paid/complete; will not expire", {
      bookingId,
      sessionId: orphanSessionId,
    });
    return "failed";
  }

  if (session.status !== "open") {
    return "already_non_payable";
  }

  try {
    await deps.expireCheckoutSession(orphanSessionId);
  } catch {
    console.error("[payment-service] Failed to expire orphan checkout session", {
      bookingId,
      sessionId: orphanSessionId,
    });
    return "failed";
  }

  let after: RetrievedCheckoutSession;
  try {
    after = await deps.retrieveCheckoutSession(orphanSessionId);
  } catch (error) {
    if (classifyCheckoutSessionError(error) === "missing") {
      return "expired";
    }
    console.error("[payment-service] Ambiguous state after orphan expire", {
      bookingId,
      sessionId: orphanSessionId,
    });
    return "failed";
  }

  if (isCheckoutSessionPaidOrComplete(after)) {
    console.error("[payment-service] Orphan session became paid during compensation", {
      bookingId,
      sessionId: orphanSessionId,
    });
    return "failed";
  }

  if (after.status === "open") {
    console.error("[payment-service] Orphan session still open after expire attempt", {
      bookingId,
      sessionId: orphanSessionId,
    });
    return "failed";
  }

  if (!isCheckoutSessionConfirmedNotOpen(after)) {
    return "failed";
  }

  return "expired";
}

/**
 * Creates a Stripe Checkout Session for a booking and stores a StripePayment record.
 * Idempotent: if a pending checkout session already exists for this booking, returns the existing URL.
 * Standard checkouts use rental + fixed security deposit line items (or deposit-only
 * when loyalty covers the rental) and matching DB allocations.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionInput,
  deps: CreateCheckoutSessionDeps = defaultCreateCheckoutSessionDeps(),
): Promise<CreateCheckoutSessionResult> {
  const {
    bookingId,
    bookingReference,
    customerEmail,
    customerName,
    vehicleName,
    pickupDate,
    returnDate,
    amountEur,
    rentalSubtotalEur,
    depositAmountEur,
    depositMethod,
    locale = "en",
  } = input;

  const allocation = allocateCombinedCheckoutAmounts({
    totalDueOnlineEur: amountEur,
    rentalSubtotalEur,
    depositAmountEur,
    depositMethod,
  });

  if (!allocation.ok) {
    return { ok: false, error: allocation.error };
  }

  const lineItems = buildCombinedCheckoutLineItems({
    allocation,
    vehicleName,
    bookingId,
    bookingReference,
    pickupDate,
    returnDate,
  });

  if (!checkoutLineItemsMatchAllocation(lineItems, allocation)) {
    return { ok: false, error: "Checkout line items failed allocation integrity check" };
  }

  const baseUrl = deps.getBaseUrl();
  let existing = await deps.findPaymentByBookingId(bookingId);

  if (existing?.stripeStatus === "SUCCEEDED") {
    return { ok: false, error: "This booking has already been paid" };
  }

  const sessionMetadata = {
    bookingId,
    bookingReference,
    customerName,
    checkoutVersion: CHECKOUT_FORMAT_VERSION,
    amountCents: String(allocation.amountCents),
    rentalAmountCents: String(allocation.rentalAmountCents),
    depositAmountCents: String(allocation.depositAmountCents),
  };

  // Ensure a payment row exists so the metadata CAS lock can serialize concurrent
  // first-time and retry checkouts across app processes (no schema migration).
  if (!existing) {
    await deps.upsertStripePayment({
      bookingId,
      create: {
        id: crypto.randomUUID(),
        bookingId,
        stripeCheckoutSessionId: null,
        stripePaymentIntentId: null,
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
        currency: CURRENCY,
        stripeStatus: "PENDING",
        refundStatus: "NONE",
        updatedAt: new Date(),
        metadata: {
          customerEmail,
          customerName,
          vehicleName,
          pickupDate,
          returnDate,
          checkoutVersion: CHECKOUT_FORMAT_VERSION,
        },
      },
      update: {},
    });
    existing = await deps.findPaymentByBookingId(bookingId);
    if (!existing) {
      return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
    }
    if (existing.stripeStatus === "SUCCEEDED") {
      return { ok: false, error: "This booking has already been paid" };
    }
  }

  const lockToken = deps.createLockToken?.() ?? crypto.randomUUID();
  const locked = await acquireCheckoutOperationLock(
    deps.lock,
    bookingId,
    lockToken,
    CHECKOUT_LOCK_TTL_MS,
  );
  if (!locked) {
    return { ok: false, error: CHECKOUT_SESSION_IN_PROGRESS_ERROR };
  }

  try {
    // Re-read under lock so we observe the latest session id / SUCCEEDED state.
    existing = await deps.findPaymentByBookingId(bookingId);
    if (!existing) {
      return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
    }
    if (existing.stripeStatus === "SUCCEEDED") {
      return { ok: false, error: "This booking has already been paid" };
    }

    if (existing.stripeCheckoutSessionId && existing.stripeStatus === "PENDING") {
      let session: RetrievedCheckoutSession | null;
      try {
        session = await deps.retrieveCheckoutSession(existing.stripeCheckoutSessionId);
      } catch (retrieveError) {
        if (classifyCheckoutSessionError(retrieveError) === "missing") {
          session = null;
        } else {
          console.error("[payment-service] Ambiguous checkout session retrieve", {
            bookingId,
            error: retrieveError,
          });
          return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
        }
      }

      if (session) {
        if (isCheckoutSessionPaidOrComplete(session)) {
          return { ok: false, error: "This booking has already been paid" };
        }

        if (
          canReuseOpenCheckoutSession({
            session,
            bookingId,
            bookingReference,
            allocation,
            storedPayment: existing,
          })
        ) {
          // Revalidate ownership + stored session before returning a URL.
          // Renew proves ownership only at the UPDATE instant — not race-free
          // for the remainder of this request.
          let ownedForReuse: boolean;
          try {
            ownedForReuse = await renewCheckoutOperationLockIfOwned(
              deps.lock,
              bookingId,
              lockToken,
              CHECKOUT_LOCK_TTL_MS,
            );
          } catch (renewError) {
            console.error("[payment-service] Checkout lock renew failed during reuse", {
              bookingId,
              error: renewError,
            });
            return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
          }
          if (!ownedForReuse) {
            return { ok: false, error: CHECKOUT_SESSION_IN_PROGRESS_ERROR };
          }

          let latestPayment: StoredStripePaymentForReuse | null;
          try {
            latestPayment = await deps.findPaymentByBookingId(bookingId);
          } catch (lookupError) {
            console.error("[payment-service] Payment re-read failed during reuse", {
              bookingId,
              error: lookupError,
            });
            return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
          }
          if (!latestPayment) {
            return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
          }
          if (latestPayment.stripeStatus === "SUCCEEDED") {
            return { ok: false, error: "This booking has already been paid" };
          }
          if (latestPayment.stripeCheckoutSessionId !== session.id) {
            // Another request replaced the stored session — never return the stale URL.
            return { ok: false, error: CHECKOUT_SESSION_IN_PROGRESS_ERROR };
          }

          let freshSession: RetrievedCheckoutSession | null;
          try {
            freshSession = await deps.retrieveCheckoutSession(session.id);
          } catch (freshError) {
            if (classifyCheckoutSessionError(freshError) === "missing") {
              freshSession = null;
            } else {
              console.error("[payment-service] Ambiguous re-retrieve during reuse", {
                bookingId,
                error: freshError,
              });
              return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
            }
          }

          if (!freshSession) {
            session = null;
          } else if (isCheckoutSessionPaidOrComplete(freshSession)) {
            return { ok: false, error: "This booking has already been paid" };
          } else if (
            canReuseOpenCheckoutSession({
              session: freshSession,
              bookingId,
              bookingReference,
              allocation,
              storedPayment: latestPayment,
            })
          ) {
            return {
              ok: true,
              checkoutUrl: freshSession.url!,
              sessionId: freshSession.id,
            };
          } else {
            // No longer reusable — continue with the fresh snapshot for expire/replace.
            session = freshSession;
            existing = latestPayment;
          }
        }

        if (session && session.status === "open") {
          try {
            await deps.expireCheckoutSession(session.id);
          } catch (expireError) {
            let latest: RetrievedCheckoutSession | null;
            try {
              latest = await deps.retrieveCheckoutSession(session.id);
            } catch (latestError) {
              if (classifyCheckoutSessionError(latestError) === "missing") {
                latest = null;
              } else {
                console.error("[payment-service] Ambiguous state after expire failure", {
                  bookingId,
                  error: latestError,
                });
                return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
              }
            }

            if (latest) {
              if (isCheckoutSessionPaidOrComplete(latest)) {
                return { ok: false, error: "This booking has already been paid" };
              }
              if (latest.status === "open") {
                console.error("[payment-service] Failed to expire stale checkout session", {
                  bookingId,
                  sessionId: session.id,
                  error: expireError,
                });
                return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
              }
              if (!isCheckoutSessionConfirmedNotOpen(latest)) {
                return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
              }
            }
          }

          let afterExpire: RetrievedCheckoutSession | null;
          try {
            afterExpire = await deps.retrieveCheckoutSession(session.id);
          } catch (afterError) {
            if (classifyCheckoutSessionError(afterError) === "missing") {
              afterExpire = null;
            } else {
              return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
            }
          }

          if (afterExpire) {
            if (isCheckoutSessionPaidOrComplete(afterExpire)) {
              return { ok: false, error: "This booking has already been paid" };
            }
            if (afterExpire.status === "open") {
              return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
            }
            if (!isCheckoutSessionConfirmedNotOpen(afterExpire)) {
              return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
            }
          }
        } else if (session && !isCheckoutSessionConfirmedNotOpen(session)) {
          return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
        }
      }
    }

    const idempotencyKey = buildCheckoutIdempotencyKey({ bookingId, allocation });

    // Fence immediately before Stripe create. A true result proves ownership at
    // the UPDATE instant only — lease can still expire during the network call.
    let ownedBeforeCreate: boolean;
    try {
      ownedBeforeCreate = await renewCheckoutOperationLockIfOwned(
        deps.lock,
        bookingId,
        lockToken,
        CHECKOUT_LOCK_TTL_MS,
      );
    } catch (renewError) {
      console.error("[payment-service] Checkout lock ownership check failed", {
        bookingId,
        error: renewError,
      });
      return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
    }
    if (!ownedBeforeCreate) {
      return { ok: false, error: CHECKOUT_SESSION_IN_PROGRESS_ERROR };
    }

    let session: { id: string; url: string | null; payment_intent: string | null };
    try {
      session = await deps.createStripeCheckoutSession({
        lineItems,
        customerEmail,
        bookingId,
        bookingReference,
        customerName,
        successUrl: `${baseUrl}/${locale}/booking/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${baseUrl}/${locale}/booking/payment/cancel?ref=${encodeURIComponent(bookingReference)}`,
        idempotencyKey,
        sessionMetadata,
      });
    } catch (createError) {
      // Do not assume Stripe did not create a session on network/timeout errors.
      console.error("[payment-service] Stripe checkout create failed or was ambiguous", {
        bookingId,
        error: createError,
      });
      return { ok: false, error: "Payment session creation failed" };
    }

    if (!session.url) {
      // Session may exist without a URL — attempt safe compensation when possible.
      const compensation = await compensateOrphanCheckoutSession(deps, bookingId, session.id);
      if (compensation === "failed") {
        return { ok: false, error: CHECKOUT_SESSION_FINALIZE_FAILED_ERROR };
      }
      return { ok: false, error: "Stripe did not return a checkout URL" };
    }

    let persisted: boolean;
    try {
      persisted = await deps.persistCheckoutSessionIfOwned({
        bookingId,
        lockToken,
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.payment_intent,
        amountCents: allocation.amountCents,
        rentalAmountCents: allocation.rentalAmountCents,
        depositAmountCents: allocation.depositAmountCents,
      });
    } catch (persistError) {
      console.error("[payment-service] Failed to persist checkout session under lock", {
        bookingId,
        error: persistError,
      });
      const compensation = await compensateOrphanCheckoutSession(deps, bookingId, session.id);
      if (compensation === "failed") {
        return { ok: false, error: CHECKOUT_SESSION_FINALIZE_FAILED_ERROR };
      }
      return { ok: false, error: CHECKOUT_SESSION_AMBIGUOUS_ERROR };
    }

    if (!persisted) {
      // Ownership lost (or SUCCEEDED) — never overwrite the current session/allocations.
      // Only expire the session id we just created, never the stored newer session.
      const compensation = await compensateOrphanCheckoutSession(deps, bookingId, session.id);
      if (compensation === "failed") {
        return { ok: false, error: CHECKOUT_SESSION_FINALIZE_FAILED_ERROR };
      }
      return { ok: false, error: CHECKOUT_SESSION_IN_PROGRESS_ERROR };
    }

    try {
      await deps.writeAuditLog({
        bookingId,
        action: "checkout_session_created",
        actor: customerEmail,
        newValue: {
          sessionId: session.id,
          amountEur,
          rentalSubtotalEur,
          depositAmountEur,
          rentalAmountCents: allocation.rentalAmountCents,
          depositAmountCents: allocation.depositAmountCents,
          checkoutVersion: CHECKOUT_FORMAT_VERSION,
          idempotencyKey,
          currency: CURRENCY,
        },
      });
    } catch (auditError) {
      // Session is already persisted under the lock fence — do not report create
      // failure or issue compensating Stripe creates. Surface for ops; retries
      // can reuse the stored session.
      console.error("[payment-service] Checkout session persisted but audit log failed", {
        bookingId,
        sessionId: session.id,
      });
    }

    return { ok: true, checkoutUrl: session.url, sessionId: session.id };
  } catch (error) {
    console.error("[payment-service] Failed to create checkout session", { bookingId, error });
    return { ok: false, error: "Payment session creation failed" };
  } finally {
    try {
      await releaseCheckoutOperationLock(deps.lock, bookingId, lockToken);
    } catch (releaseError) {
      console.error("[payment-service] Failed to release checkout lock", {
        bookingId,
        error: releaseError,
      });
    }
  }
}

/**
 * Retrieves the StripePayment record for a booking, including payment intent status.
 */
export async function getPaymentByBookingId(bookingId: string) {
  return prisma.stripePayment.findUnique({
    where: { bookingId },
    include: {
      StripeTransaction: { orderBy: { createdAt: "desc" } },
      StripeRefund: { orderBy: { createdAt: "desc" } },
    },
  });
}

/**
 * Retrieves a StripePayment record by checkout session ID.
 */
export async function getPaymentByCheckoutSessionId(sessionId: string) {
  return prisma.stripePayment.findUnique({
    where: { stripeCheckoutSessionId: sessionId },
    include: { Booking: { select: { bookingReference: true, customerEmail: true, totalDueOnline: true } } },
  });
}

export type VerifiedPaymentData = {
  bookingReference: string;
  customerName: string;
  customerEmail: string;
  vehicleName: string;
  vehicleType: string;
  pickupDateTime: Date;
  returnDateTime: Date;
  billableDays: number;
  pickupOption: string;
  pickupAddress: string | null;
  dropoffOption: string;
  dropoffAddress: string | null;
  amountEur: number;
  depositAmountEur: number;
  depositMethod: string;
  paymentStatus: "paid" | "pending" | "unpaid";
  stripeReceiptUrl: string | null;
  paidAt: Date | null;
};

/**
 * Verifies a checkout session and returns rich booking info for the success page.
 * Checks Stripe directly so it works even before the webhook arrives.
 */
export async function verifyCheckoutSession(sessionId: string): Promise<
  | { ok: true; data: VerifiedPaymentData }
  | { ok: false; error: string }
> {
  try {
    const [session, payment] = await Promise.all([
      stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["payment_intent.latest_charge"],
      }),
      prisma.stripePayment.findUnique({
        where: { stripeCheckoutSessionId: sessionId },
        include: {
          Booking: {
            select: {
              bookingReference: true,
              customerFullName: true,
              customerEmail: true,
              vehicleNameSnapshot: true,
              vehicleTypeSnapshot: true,
              pickupDateTime: true,
              returnDateTime: true,
              billableDays: true,
              pickupOption: true,
              pickupAddress: true,
              dropoffOption: true,
              dropoffAddress: true,
              depositAmount: true,
              depositMethod: true,
              paymentStatus: true,
            },
          },
        },
      }),
    ]);

    if (!payment?.Booking) {
      return { ok: false, error: "Payment record not found" };
    }

    const booking = payment.Booking;

    // Determine payment status from Stripe (authoritative) then fall back to DB.
    // Paid-lineage DB statuses (incl. partial/full refund and dispute) also count as paid
    // for the public response without exposing internal dispute/refund details.
    const stripePaymentStatus = session.payment_status;
    const isPaid =
      stripePaymentStatus === "paid" ||
      payment.stripeStatus === "SUCCEEDED" ||
      payment.stripeStatus === "PARTIALLY_REFUNDED" ||
      payment.stripeStatus === "REFUNDED" ||
      payment.stripeStatus === "DISPUTED";

    // If Stripe already collected payment but the webhook never arrived, persist
    // PAID status and send the confirmation email from this verifier.
    // Skip for REFUNDED / DISPUTED — Stripe still reports payment_status=paid after refunds.
    if (
      stripePaymentStatus === "paid" &&
      shouldSyncPaidBookingForStripeStatus(payment.stripeStatus)
    ) {
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent && typeof session.payment_intent === "object"
            ? session.payment_intent.id
            : null;
      try {
        await syncPaidBookingAndSendConfirmation({
          bookingId: payment.bookingId,
          paymentIntentId,
          checkoutSessionId: sessionId,
          integrity: {
            source: "checkout_session",
            session: {
              id: session.id,
              payment_status: session.payment_status,
              amount_total: session.amount_total,
              currency: session.currency,
            },
          },
        });
      } catch (syncError) {
        console.error("[payment-service] Failed to persist paid booking or send confirmation", {
          sessionId,
          bookingId: payment.bookingId,
          error: syncError,
        });
      }
    }

    // Extract receipt URL from the charge object if available
    let receiptUrl: string | null = null;
    if (session.payment_intent && typeof session.payment_intent === "object") {
      const intent = session.payment_intent as import("stripe").Stripe.PaymentIntent & {
        latest_charge?: import("stripe").Stripe.Charge;
      };
      receiptUrl = intent.latest_charge?.receipt_url ?? null;
    }

    // Estimate paid-at time from the payment intent's created timestamp
    let paidAt: Date | null = null;
    if (isPaid && session.payment_intent && typeof session.payment_intent === "object") {
      const intent = session.payment_intent as import("stripe").Stripe.PaymentIntent;
      paidAt = new Date((intent.created ?? 0) * 1000);
    }

    return {
      ok: true,
      data: {
        bookingReference: booking.bookingReference,
        customerName: booking.customerFullName,
        customerEmail: booking.customerEmail,
        vehicleName: booking.vehicleNameSnapshot ?? "Vehicle",
        vehicleType: booking.vehicleTypeSnapshot ?? "Vehicle",
        pickupDateTime: booking.pickupDateTime,
        returnDateTime: booking.returnDateTime,
        billableDays: booking.billableDays,
        pickupOption: booking.pickupOption,
        pickupAddress: booking.pickupAddress,
        dropoffOption: booking.dropoffOption,
        dropoffAddress: booking.dropoffAddress,
        amountEur: payment.amountCents / 100,
        depositAmountEur: booking.depositAmount.toNumber(),
        depositMethod: booking.depositMethod,
        paymentStatus: isPaid ? "paid" : stripePaymentStatus === "unpaid" ? "unpaid" : "pending",
        stripeReceiptUrl: receiptUrl,
        paidAt,
      },
    };
  } catch (error) {
    console.error("[payment-service] Failed to verify checkout session", { sessionId, error });
    return { ok: false, error: "Could not verify payment status" };
  }
}

/** Formats a date string for display in the Stripe line item */
export function formatDateForStripe(dateStr: string): string {
  try {
    return format(new Date(dateStr), "dd MMM yyyy");
  } catch {
    return dateStr;
  }
}
