/**
 * Pure reconcile-form policy tests (explicit purpose, evidence).
 *
 *   npm run test:stripe-reconcile-form
 */

import assert from "node:assert/strict";

import {
  areReconcileAllocationsComplete,
  buildReconcileAllocationsPayload,
  canSubmitHistoricalReconcile,
} from "../src/features/admin/lib/stripe-reconcile-form";
import { handleAdminReconcileRefunds } from "../src/app/api/admin/payments/[id]/reconcile-refunds/handle-admin-reconcile-refunds";
import { AdminUnauthorizedError } from "../src/lib/admin-auth/errors";
import type { AdminSessionRecord } from "../src/lib/admin-auth/types";
import type { ReconcileHistoricalRefundsResult } from "../src/lib/stripe/types";

function session(): AdminSessionRecord {
  return {
    id: "admin-1",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
    sessionId: "sess-1",
    expiresAt: new Date(Date.now() + 60_000),
  };
}

function testMissingPurposeBlocksSubmit() {
  assert.equal(
    areReconcileAllocationsComplete(["re_1"], { re_1: "" }),
    false,
  );
  assert.equal(
    canSubmitHistoricalReconcile({
      evidence: "Enough evidence text here",
      unmatchedRefundIds: ["re_1"],
      allocations: { re_1: "" },
    }),
    false,
  );
  assert.equal(
    buildReconcileAllocationsPayload(["re_1"], { re_1: "" }).ok,
    false,
  );
}

function testExplicitPurposeAndEvidenceAllowSubmit() {
  assert.equal(
    canSubmitHistoricalReconcile({
      evidence: "Matched to rental from Stripe dashboard",
      unmatchedRefundIds: ["re_1", "re_2"],
      allocations: { re_1: "RENTAL", re_2: "SECURITY_DEPOSIT" },
    }),
    true,
  );
  const built = buildReconcileAllocationsPayload(["re_1", "re_2"], {
    re_1: "RENTAL",
    re_2: "SECURITY_DEPOSIT",
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.allocations, [
    { stripeRefundId: "re_1", purpose: "RENTAL" },
    { stripeRefundId: "re_2", purpose: "SECURITY_DEPOSIT" },
  ]);
}

function testMissingEvidenceBlocksSubmit() {
  assert.equal(
    canSubmitHistoricalReconcile({
      evidence: "short",
      unmatchedRefundIds: ["re_1"],
      allocations: { re_1: "RENTAL" },
    }),
    false,
  );
}

function testDefaultRentalNotAssumed() {
  // Empty map / missing keys are incomplete — never treat as RENTAL.
  assert.equal(areReconcileAllocationsComplete(["re_1"], {}), false);
  assert.equal(areReconcileAllocationsComplete(["re_1"], { re_1: undefined }), false);
}

async function testApiRejectsMissingPurposeAndEvidence() {
  let calls = 0;
  const reconcileHistoricalRefunds = async (): Promise<ReconcileHistoricalRefundsResult> => {
    calls += 1;
    return { ok: true, reconciledCount: 1 };
  };

  const missingPurpose = await handleAdminReconcileRefunds(
    new Request("http://localhost/api/admin/payments/pay_1/reconcile-refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidence: "Valid evidence string here",
        allocations: [{ stripeRefundId: "re_1" }],
      }),
    }),
    "pay_1",
    { authorize: async () => session(), reconcileHistoricalRefunds },
  );
  assert.equal(missingPurpose.status, 400);
  assert.equal(calls, 0);

  const missingEvidence = await handleAdminReconcileRefunds(
    new Request("http://localhost/api/admin/payments/pay_1/reconcile-refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidence: "short",
        allocations: [{ stripeRefundId: "re_1", purpose: "RENTAL" }],
      }),
    }),
    "pay_1",
    { authorize: async () => session(), reconcileHistoricalRefunds },
  );
  assert.equal(missingEvidence.status, 400);
  assert.equal(calls, 0);

  const invalidIdPath = await handleAdminReconcileRefunds(
    new Request("http://localhost/api/admin/payments/pay_1/reconcile-refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidence: "Valid evidence string here",
        allocations: [{ stripeRefundId: "re_1", purpose: "RENTAL" }],
      }),
    }),
    "pay_1",
    {
      authorize: async () => session(),
      reconcileHistoricalRefunds: async () => ({
        ok: false,
        error: "Allocations must cover exactly the unmatched historical Stripe refund IDs",
        code: "incomplete_allocation",
      }),
    },
  );
  assert.equal(invalidIdPath.status, 409);
  assert.equal((await invalidIdPath.json()).code, "incomplete_allocation");

  const unauth = await handleAdminReconcileRefunds(
    new Request("http://localhost/api/admin/payments/pay_1/reconcile-refunds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        evidence: "Valid evidence string here",
        allocations: [{ stripeRefundId: "re_1", purpose: "RENTAL" }],
      }),
    }),
    "pay_1",
    {
      authorize: async () => {
        throw new AdminUnauthorizedError();
      },
      reconcileHistoricalRefunds,
    },
  );
  assert.equal(unauth.status, 401);
}

async function run() {
  testMissingPurposeBlocksSubmit();
  testExplicitPurposeAndEvidenceAllowSubmit();
  testMissingEvidenceBlocksSubmit();
  testDefaultRentalNotAssumed();
  await testApiRejectsMissingPurposeAndEvidence();
  console.log("test-stripe-reconcile-form: all passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
