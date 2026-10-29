/**
 * Classifies Stripe (or Stripe-like) errors for checkout session lookup/expiry.
 * Only a confirmed missing resource may be treated as "session gone".
 */

export type CheckoutSessionErrorKind = "missing" | "ambiguous";

function readErrorField(error: unknown, key: string): unknown {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  return (error as Record<string, unknown>)[key];
}

/**
 * Returns `missing` only for confirmed resource-not-found responses.
 * Network/timeouts/rate limits/auth/5xx are `ambiguous` (fail closed).
 */
export function classifyCheckoutSessionError(error: unknown): CheckoutSessionErrorKind {
  const statusCode = readErrorField(error, "statusCode");
  const code = readErrorField(error, "code");
  const type = readErrorField(error, "type");
  const raw = readErrorField(error, "raw");

  const rawCode =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).code : undefined;
  const rawStatus =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).statusCode : undefined;

  const resolvedCode = typeof code === "string" ? code : typeof rawCode === "string" ? rawCode : null;
  const resolvedStatus =
    typeof statusCode === "number"
      ? statusCode
      : typeof rawStatus === "number"
        ? rawStatus
        : null;

  if (resolvedStatus === 404 || resolvedCode === "resource_missing") {
    return "missing";
  }

  // Stripe often uses type "invalid_request_error" with resource_missing; without
  // that code, treat as ambiguous.
  if (type === "invalid_request_error" && resolvedCode === "resource_missing") {
    return "missing";
  }

  return "ambiguous";
}

/** Safe operator-facing message; never includes upstream payloads or secrets. */
export const CHECKOUT_SESSION_AMBIGUOUS_ERROR =
  "Unable to verify the existing checkout session; please try again shortly";

export const CHECKOUT_SESSION_IN_PROGRESS_ERROR =
  "A checkout session is already being prepared for this booking; please try again shortly";

/** Ownership lost or finalize/compensation could not be confirmed. */
export const CHECKOUT_SESSION_FINALIZE_FAILED_ERROR =
  "Unable to finalize the checkout session; please try again shortly";
