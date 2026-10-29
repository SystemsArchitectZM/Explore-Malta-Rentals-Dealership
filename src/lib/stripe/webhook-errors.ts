/**
 * Typed webhook failure classification.
 *
 * Policy (fail closed):
 *   - A handler may declare a definitive business rejection ONLY by throwing
 *     WebhookPermanentError with a documented code. These are dead-lettered.
 *   - EVERY other thrown value is treated as incomplete processing (retryable).
 *   - Infrastructure errors are additionally labelled DB_TRANSIENT using structured
 *     error codes (Prisma / PostgreSQL SQLSTATE / Node errno) — never message text.
 *     The label only improves observability; it does not change retryability.
 *
 * This module is dependency-free so it can be unit-tested without Prisma/Stripe.
 */

import type { WebhookFailureCode } from "./types";

/** Codes a handler is allowed to declare as permanent. */
export type WebhookPermanentCode = Extract<
  WebhookFailureCode,
  | "EVENT_METADATA_MISSING"
  | "BOOKING_CANCELLED_PAYMENT_RECEIVED"
  | "EVENT_PAYLOAD_INVALID"
  | "PAYMENT_INTEGRITY_MISMATCH"
>;

/**
 * Documented permanent classifications:
 *  - EVENT_METADATA_MISSING: the Stripe object lacks the booking identifiers this
 *    application always attaches; redelivery of the same payload can never succeed.
 *  - BOOKING_CANCELLED_PAYMENT_RECEIVED: money was captured for a booking that is
 *    CANCELLED. The handler transaction rolled back; automatic retry cannot fix this
 *    and a human must decide (refund / reinstate). Dead-letter makes it reviewable.
 *  - EVENT_PAYLOAD_INVALID: a stored payload (replayed by operator recovery) lacks a
 *    usable `data.object`. Stripe-delivered events always have one, so this only
 *    arises from a corrupt stored row; retrying the same stored bytes cannot help.
 *  - PAYMENT_INTEGRITY_MISMATCH: Checkout Session / PaymentIntent amount, currency,
 *    or object id does not match the stored StripePayment expectation.
 */
export class WebhookPermanentError extends Error {
  readonly code: WebhookPermanentCode;

  constructor(code: WebhookPermanentCode, message: string) {
    super(message);
    this.name = "WebhookPermanentError";
    this.code = code;
  }
}

/** Server misconfiguration (e.g. signing secret absent). Never a client error. */
export class WebhookConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigurationError";
  }
}

export type WebhookFailureClassification =
  | { retryable: true; code: Extract<WebhookFailureCode, "DB_TRANSIENT" | "HANDLER_ERROR"> }
  | { retryable: false; code: WebhookPermanentCode };

const TRANSIENT_PRISMA_CODES = new Set([
  "P1001", // cannot reach database server
  "P1002", // database server timed out
  "P1008", // operations timed out
  "P1017", // server closed the connection
  "P2024", // timed out fetching a connection from the pool
  "P2028", // transaction API error (e.g. expired interactive transaction)
  "P2034", // write conflict / deadlock
]);

const TRANSIENT_NODE_ERRNO = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/** PostgreSQL SQLSTATE values (exact) that indicate a retryable condition. */
const TRANSIENT_SQLSTATE_EXACT = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled (e.g. statement timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

/** PostgreSQL SQLSTATE class prefixes: 08 connection exception, 53 insufficient resources. */
const TRANSIENT_SQLSTATE_CLASSES = ["08", "53"];

const MAX_CAUSE_DEPTH = 6;

function readString(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * True when the error (or a nested cause) carries a structured code recognised as a
 * transient infrastructure failure. Uses codes/names only, never message substrings.
 */
export function isTransientInfrastructureError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    const name = readString(current, "name");
    if (name === "PrismaClientInitializationError") return true;

    const candidates = [readString(current, "code"), readString(current, "originalCode")];
    for (const code of candidates) {
      if (!code) continue;
      if (TRANSIENT_PRISMA_CODES.has(code)) return true;
      if (TRANSIENT_NODE_ERRNO.has(code)) return true;
      if (TRANSIENT_SQLSTATE_EXACT.has(code)) return true;
      if (
        code.length === 5 &&
        TRANSIENT_SQLSTATE_CLASSES.some((prefix) => code.startsWith(prefix))
      ) {
        return true;
      }
    }

    current =
      typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export function classifyWebhookFailure(error: unknown): WebhookFailureClassification {
  if (error instanceof WebhookPermanentError) {
    return { retryable: false, code: error.code };
  }
  if (isTransientInfrastructureError(error)) {
    return { retryable: true, code: "DB_TRANSIENT" };
  }
  return { retryable: true, code: "HANDLER_ERROR" };
}

const MAX_STORED_ERROR_CHARS = 500;

/**
 * Bounded single-line summary for the WebhookEvent.error column (server-side only;
 * never returned over HTTP). No stack trace is included.
 */
export function summarizeErrorForStorage(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const singleLine = raw.replace(/\s+/g, " ").trim();
  return singleLine.length > MAX_STORED_ERROR_CHARS
    ? `${singleLine.slice(0, MAX_STORED_ERROR_CHARS - 1)}…`
    : singleLine;
}
