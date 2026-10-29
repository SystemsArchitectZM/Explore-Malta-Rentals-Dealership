/**
 * Authorization tests for POST /api/admin/payments/[id]/recover-terminal-refund.
 *
 *   npm run test:admin-recover-terminal-refund-auth
 */

import assert from "node:assert/strict";

import { AdminForbiddenError, AdminUnauthorizedError } from "../src/lib/admin-auth/errors";
import type { AdminSessionRecord } from "../src/lib/admin-auth/types";
import { handleAdminRecoverTerminalRefund } from "../src/app/api/admin/payments/[id]/recover-terminal-refund/handle-admin-recover-terminal-refund";
import type { RecoverTerminalRefundResult } from "../src/lib/stripe/types";

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
  const recoverTerminalRefundRequest = async (): Promise<RecoverTerminalRefundResult> => {
    calls += 1;
    return {
      ok: true,
      requestId: "req_1",
      stripeRefundId: "re_1",
      purpose: "RENTAL",
      amountCents: 5000,
      idempotent: false,
      mirrorRepaired: false,
    };
  };

  const body = {
    requestId: "req_1",
    stripeRefundId: "re_1",
    evidence: "Stripe dashboard confirms succeeded refund after local FAILED",
  };

  const request = () =>
    new Request("http://localhost/api/admin/payments/pay_1/recover-terminal-refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const unauth = await handleAdminRecoverTerminalRefund(request(), "pay_1", {
    authorize: async () => {
      throw new AdminUnauthorizedError();
    },
    recoverTerminalRefundRequest,
  });
  assert.equal(unauth.status, 401);
  assert.equal(calls, 0);

  const staff = await handleAdminRecoverTerminalRefund(request(), "pay_1", {
    authorize: async () => {
      throw new AdminForbiddenError();
    },
    recoverTerminalRefundRequest,
  });
  assert.equal(staff.status, 403);
  assert.equal(calls, 0);

  const shortEvidence = await handleAdminRecoverTerminalRefund(
    new Request("http://localhost/api/admin/payments/pay_1/recover-terminal-refund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, evidence: "short" }),
    }),
    "pay_1",
    {
      authorize: async () => session("ADMIN"),
      recoverTerminalRefundRequest,
    },
  );
  assert.equal(shortEvidence.status, 400);
  assert.equal(calls, 0);

  const admin = await handleAdminRecoverTerminalRefund(request(), "pay_1", {
    authorize: async () => session("ADMIN", "admin-9"),
    recoverTerminalRefundRequest,
  });
  assert.equal(admin.status, 200);
  assert.equal(calls, 1);
  const json = await admin.json();
  assert.equal(json.success, true);
  assert.equal(json.requestId, "req_1");
  assert.equal(json.idempotent, false);

  console.log("Admin recover-terminal-refund authorization checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
