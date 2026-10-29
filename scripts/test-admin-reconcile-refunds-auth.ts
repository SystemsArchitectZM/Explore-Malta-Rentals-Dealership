/**
 * Authorization tests for POST /api/admin/payments/[id]/reconcile-refunds.
 *
 *   npm run test:admin-reconcile-refunds-auth
 */

import assert from "node:assert/strict";

import { AdminForbiddenError, AdminUnauthorizedError } from "../src/lib/admin-auth/errors";
import type { AdminSessionRecord } from "../src/lib/admin-auth/types";
import { handleAdminReconcileRefunds } from "../src/app/api/admin/payments/[id]/reconcile-refunds/handle-admin-reconcile-refunds";
import type { ReconcileHistoricalRefundsResult } from "../src/lib/stripe/types";

function session(role: "ADMIN" | "STAFF", id = "user-1"): AdminSessionRecord {
  return {
    id,
    name: "Test User",
    email: `${role.toLowerCase()}@test.local`,
    role,
    sessionId: "sess-1",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

async function run() {
  let calls = 0;
  const reconcileHistoricalRefunds = async (): Promise<ReconcileHistoricalRefundsResult> => {
    calls += 1;
    return { ok: true, reconciledCount: 1 };
  };

  const body = {
    evidence: "Matched to rental from Stripe dashboard notes 2025-01",
    allocations: [{ stripeRefundId: "re_old", purpose: "RENTAL" as const }],
  };

  const request = () =>
    new Request("http://localhost/api/admin/payments/pay_1/reconcile-refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const unauth = await handleAdminReconcileRefunds(request(), "pay_1", {
    authorize: async () => {
      throw new AdminUnauthorizedError();
    },
    reconcileHistoricalRefunds,
  });
  assert.equal(unauth.status, 401);
  assert.equal(calls, 0);

  const staff = await handleAdminReconcileRefunds(request(), "pay_1", {
    authorize: async () => {
      throw new AdminForbiddenError();
    },
    reconcileHistoricalRefunds,
  });
  assert.equal(staff.status, 403);
  assert.equal(calls, 0);

  const admin = await handleAdminReconcileRefunds(request(), "pay_1", {
    authorize: async () => session("ADMIN", "admin-7"),
    reconcileHistoricalRefunds,
  });
  assert.equal(admin.status, 200);
  assert.equal(calls, 1);
  assert.deepEqual(await admin.json(), {
    success: true,
    reconciledCount: 1,
    message: "Reconciled 1 historical refund allocation(s)",
  });

  console.log("Admin reconcile refunds authorization checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
