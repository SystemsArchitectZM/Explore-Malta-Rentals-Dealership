/**
 * Cross-process checkout serialization without a schema migration.
 *
 * Uses an atomic compare-and-set on existing StripePayment.metadata.checkoutLock
 * (JSON). Lock is acquired and released around Stripe calls but does NOT hold an
 * open SQL transaction during network I/O.
 *
 * Guarantees: at most one holder of a non-expired lock token per bookingId at a
 * given instant; token-matched renew/persist/release. Does not by itself prove
 * Stripe-side uniqueness (idempotency + post-create fencing still required).
 */

export const CHECKOUT_LOCK_METADATA_KEY = "checkoutLock";
export const CHECKOUT_LOCK_TTL_MS = 45_000;

export type CheckoutLockRecord = {
  token: string;
  expiresAt: string;
};

export type CheckoutLockDeps = {
  /**
   * Atomically sets metadata.checkoutLock when absent or expired.
   * Returns true when this token now owns the lock.
   */
  trySetCheckoutLock: (input: {
    bookingId: string;
    token: string;
    expiresAtIso: string;
    nowIso: string;
  }) => Promise<boolean>;
  /**
   * Extends expiresAt only when the token still owns the lock.
   * Returns true when this token still owns the lock after the update.
   */
  renewCheckoutLockIfOwned: (input: {
    bookingId: string;
    token: string;
    expiresAtIso: string;
  }) => Promise<boolean>;
  /**
   * Clears metadata.checkoutLock only when the token matches.
   */
  clearCheckoutLock: (input: { bookingId: string; token: string }) => Promise<void>;
};

export function buildCheckoutLockRecord(token: string, ttlMs = CHECKOUT_LOCK_TTL_MS): CheckoutLockRecord {
  return {
    token,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

export async function acquireCheckoutOperationLock(
  deps: CheckoutLockDeps,
  bookingId: string,
  token: string,
  ttlMs = CHECKOUT_LOCK_TTL_MS,
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + ttlMs).toISOString();
  return deps.trySetCheckoutLock({ bookingId, token, expiresAtIso, nowIso });
}

/**
 * Atomic ownership proof + TTL renew. Call immediately before Stripe create
 * (and similar mutating work). A true result means this token owned the lock
 * at the instant of the UPDATE — not for the entire subsequent network call.
 */
export async function renewCheckoutOperationLockIfOwned(
  deps: CheckoutLockDeps,
  bookingId: string,
  token: string,
  ttlMs = CHECKOUT_LOCK_TTL_MS,
): Promise<boolean> {
  const expiresAtIso = new Date(Date.now() + ttlMs).toISOString();
  return deps.renewCheckoutLockIfOwned({ bookingId, token, expiresAtIso });
}

export async function releaseCheckoutOperationLock(
  deps: CheckoutLockDeps,
  bookingId: string,
  token: string,
): Promise<void> {
  await deps.clearCheckoutLock({ bookingId, token });
}

/**
 * Pure helper for tests: whether an existing lock blocks a new acquire.
 */
export function isCheckoutLockActive(
  lock: CheckoutLockRecord | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!lock?.token || !lock.expiresAt) {
    return false;
  }
  const expires = Date.parse(lock.expiresAt);
  if (!Number.isFinite(expires)) {
    return false;
  }
  return expires > nowMs;
}
