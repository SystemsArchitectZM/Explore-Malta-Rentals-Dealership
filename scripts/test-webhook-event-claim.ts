/**
 * Mocked webhook claim / lease / fencing / outcome tests (no DB, no Stripe network).
 *
 *   npm run test:webhook-event-claim
 *
 * IMPORTANT — what this file does and does NOT prove:
 *   The InMemoryWebhookStore below models the WebhookEventStore CONTRACT with a
 *   synchronous compare-and-swap. JavaScript is single-threaded, so these tests
 *   verify the state machine, fencing rules, typed outcomes, and idempotent handler
 *   composition. They do NOT prove PostgreSQL row-lock / READ COMMITTED behaviour of
 *   the real conditional UPDATE in webhook-event-store.ts. Real-PostgreSQL
 *   concurrency cases are specified (not implemented) in
 *   docs/stripe-webhook-reliability.md under "Real PostgreSQL integration tests".
 *
 * Every test is labelled MOCK. None requires a database.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  claimWebhookEvent,
  MIN_WEBHOOK_MAX_ATTEMPTS,
  resolveWebhookClaimConfig,
  type WebhookClaim,
  type WebhookClaimConfig,
  type WebhookEventRecordInput,
  type WebhookEventState,
  type WebhookEventStore,
  type WebhookDeadLetterRecord,
  type WebhookFailureRecord,
} from "../src/lib/stripe/webhook-event-claim";
import { WebhookPermanentError } from "../src/lib/stripe/webhook-errors";
import {
  processWebhookEventWithDeps,
  type WebhookDispatchResult,
  type WebhookProcessingDeps,
} from "../src/lib/stripe/webhook-processing";
import {
  reconcileRefundWebhookEvent,
  type RefundWebhookDeps,
  type RefundWebhookPaymentRow,
  type RefundWebhookRequestRow,
} from "../src/lib/stripe/refund-webhook-reconciliation";
import type { CreateRefundInput, WebhookEventStatusValue } from "../src/lib/stripe/types";

process.env.DATABASE_URL ??= "postgresql://localhost:5432/explore_malta_test_unused";

// ─── In-memory store (contract model only) ─────────────────────────────────────

type Row = {
  id: string;
  stripeEventId: string;
  eventType: string;
  processed: boolean;
  processedAtMs: number | null;
  status: WebhookEventStatusValue;
  claimToken: string | null;
  claimExpiresAtMs: number | null;
  claimGeneration: number;
  attemptCount: number;
  lastErrorCode: string | null;
  error: string | null;
  deadLetterReason: string | null;
  lastAttemptAtMs: number | null;
  createdAtMs: number;
};

type Clock = { nowMs: number };

function dbDown(): Error {
  return Object.assign(new Error("connection refused"), { code: "P1001" });
}

class InMemoryWebhookStore implements WebhookEventStore {
  rows = new Map<string, Row>();
  faults = {
    ensure: false,
    tryClaim: false,
    markProcessedOnce: false,
    markDeadLetter: false,
    release: false,
  };
  claimCalls = 0;

  constructor(private readonly clock: Clock) {}

  async ensureRecord(event: WebhookEventRecordInput): Promise<void> {
    if (this.faults.ensure) throw dbDown();
    if (!this.rows.has(event.id)) {
      this.rows.set(event.id, {
        id: `row_${event.id}`,
        stripeEventId: event.id,
        eventType: event.type,
        processed: false,
        processedAtMs: null,
        status: "RECEIVED",
        claimToken: null,
        claimExpiresAtMs: null,
        claimGeneration: 0,
        attemptCount: 0,
        lastErrorCode: null,
        error: null,
        deadLetterReason: null,
        lastAttemptAtMs: null,
        createdAtMs: this.clock.nowMs,
      });
    }
  }

  /** Synchronous body == atomic compare-and-swap in this mock. */
  async tryClaim(input: {
    stripeEventId: string;
    claimToken: string;
    leaseSeconds: number;
  }): Promise<WebhookClaim | null> {
    this.claimCalls += 1;
    if (this.faults.tryClaim) throw dbDown();
    const row = this.rows.get(input.stripeEventId);
    if (!row || row.processed) return null;
    const leaseExpired =
      row.claimExpiresAtMs === null || row.claimExpiresAtMs <= this.clock.nowMs;
    const claimable =
      row.status === "RECEIVED" ||
      row.status === "RETRYABLE_FAILED" ||
      (row.status === "PROCESSING" && leaseExpired);
    if (!claimable) return null;

    const previousStatus = row.status;
    row.status = "PROCESSING";
    row.claimToken = input.claimToken;
    row.claimExpiresAtMs = this.clock.nowMs + input.leaseSeconds * 1000;
    row.claimGeneration += 1;
    row.attemptCount += 1;
    row.lastAttemptAtMs = this.clock.nowMs;
    return {
      eventRowId: row.id,
      stripeEventId: row.stripeEventId,
      claimToken: input.claimToken,
      claimGeneration: row.claimGeneration,
      attemptCount: row.attemptCount,
      previousStatus,
    };
  }

  async readState(stripeEventId: string): Promise<WebhookEventState | null> {
    const row = this.rows.get(stripeEventId);
    if (!row) return null;
    return {
      status: row.status,
      processed: row.processed,
      leaseActive:
        row.claimExpiresAtMs !== null && row.claimExpiresAtMs > this.clock.nowMs,
    };
  }

  private fenced(claim: WebhookClaim): Row | null {
    const row = this.rows.get(claim.stripeEventId);
    if (
      !row ||
      row.status !== "PROCESSING" ||
      row.claimToken !== claim.claimToken ||
      row.claimGeneration !== claim.claimGeneration
    ) {
      return null;
    }
    return row;
  }

  async markProcessed(claim: WebhookClaim): Promise<boolean> {
    if (this.faults.markProcessedOnce) {
      this.faults.markProcessedOnce = false;
      throw dbDown();
    }
    const row = this.fenced(claim);
    if (!row) return false;
    row.status = "PROCESSED";
    row.processed = true;
    row.processedAtMs = this.clock.nowMs;
    row.claimToken = null;
    row.claimExpiresAtMs = null;
    return true;
  }

  async releaseForRetry(claim: WebhookClaim, failure: WebhookFailureRecord): Promise<boolean> {
    if (this.faults.release) throw dbDown();
    const row = this.fenced(claim);
    if (!row) return false;
    row.status = "RETRYABLE_FAILED";
    row.error = failure.message;
    row.lastErrorCode = failure.code;
    row.claimToken = null;
    row.claimExpiresAtMs = null;
    return true;
  }

  /** Mirrors the SQL: COALESCE keeps existing evidence when none is supplied. */
  async markDeadLetter(claim: WebhookClaim, record: WebhookDeadLetterRecord): Promise<boolean> {
    if (this.faults.markDeadLetter) throw dbDown();
    const row = this.fenced(claim);
    if (!row) return false;
    row.status = "DEAD_LETTER";
    row.error = record.message ?? row.error;
    row.lastErrorCode = record.lastErrorCode ?? row.lastErrorCode;
    row.deadLetterReason = record.reason;
    row.claimToken = null;
    row.claimExpiresAtMs = null;
    return true;
  }

  get(id: string): Row {
    const row = this.rows.get(id);
    assert.ok(row, `missing row ${id}`);
    return row;
  }
}

// ─── Harness ───────────────────────────────────────────────────────────────────

type TestEvent = {
  id: string;
  type: string;
  data?: { refundId: string; amountCents: number; status: string; metadata: Record<string, string> };
};

const defaultConfig: WebhookClaimConfig = { leaseSeconds: 300, maxAttempts: 8 };
let tokenSeq = 0;

function event(id = "evt_1", type = "payment_intent.succeeded"): TestEvent {
  return { id, type };
}

function makeDeps(
  store: InMemoryWebhookStore,
  dispatch: (e: TestEvent) => Promise<WebhookDispatchResult>,
  options: { config?: WebhookClaimConfig; auditThrows?: boolean } = {},
) {
  const audits: string[] = [];
  const logs: string[] = [];
  const deps: WebhookProcessingDeps<TestEvent> = {
    store,
    config: options.config ?? defaultConfig,
    dispatch,
    audit: async (args) => {
      if (options.auditThrows) throw new Error("audit down");
      audits.push(args.action);
    },
    log: (name) => {
      logs.push(name);
    },
    newClaimToken: () => `tok_${(tokenSeq += 1)}`,
  };
  return { deps, audits, logs };
}

function newStore(): { store: InMemoryWebhookStore; clock: Clock } {
  const clock: Clock = { nowMs: 1_000_000 };
  return { store: new InMemoryWebhookStore(clock), clock };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function countingDispatch(action = "ok") {
  const state = { calls: 0 };
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    state.calls += 1;
    return { handled: true, action };
  };
  return { state, dispatch };
}

// ─── Refund world (shared by duplicate + concurrency tests) ────────────────────

type CreateRefundDeps = import("../src/lib/stripe/refund-service").CreateRefundDeps;
type PaymentLockContext = import("../src/lib/stripe/refund-service").PaymentLockContext;
type CreateRefundFn = typeof import("../src/lib/stripe/refund-service").createRefund;
type LockRequest = PaymentLockContext["requests"][number];

function createMutex() {
  let tail: Promise<void> = Promise.resolve();
  return async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

function createRefundWorld(options: { requests?: LockRequest[] } = {}) {
  const payment = {
    id: "pay_1",
    bookingId: "booking_1",
    stripePaymentIntentId: "pi_1",
    stripeStatus: "SUCCEEDED",
    refundStatus: "NONE",
    amountCents: 43000,
    rentalAmountCents: 18000,
    depositAmountCents: 25000,
    refundedAmountCents: 0,
    rentalRefundedCents: 0,
    depositRefundedCents: 0,
  };
  const requests: LockRequest[] = [...(options.requests ?? [])];
  const stripeRefunds: Array<{ stripeRefundId: string; amountCents: number }> = [];
  const booking = {
    status: "COMPLETED",
    depositMethod: "ONLINE",
    pickupDateTime: new Date("2026-06-10T10:00:00.000Z"),
    paymentProofUploadPath: null as string | null,
    totalDueOnline: 430,
    cancelledAt: null as Date | null,
    statusBeforeCancel: null as string | null,
  };
  // Models the payment-row FOR UPDATE: all lock sections are serialized.
  const exclusive = createMutex();
  const audits: string[] = [];
  let idSeq = 1;

  const setCounters = async (input: {
    rentalRefundedCents: number;
    depositRefundedCents: number;
    refundedAmountCents: number;
  }) => {
    payment.rentalRefundedCents = input.rentalRefundedCents;
    payment.depositRefundedCents = input.depositRefundedCents;
    payment.refundedAmountCents = input.refundedAmountCents;
  };

  const webhookDeps: RefundWebhookDeps = {
    findPaymentByPaymentIntentId: async () => payment as RefundWebhookPaymentRow,
    withPaymentLock: (_id, fn) =>
      exclusive(() =>
        fn({
          payment: payment as RefundWebhookPaymentRow,
          requests: requests as unknown as RefundWebhookRequestRow[],
          stripeRefunds,
          upsertMirror: async (input) => {
            if (!stripeRefunds.some((r) => r.stripeRefundId === input.stripeRefundId)) {
              stripeRefunds.push({
                stripeRefundId: input.stripeRefundId,
                amountCents: input.amountCents,
              });
            }
          },
          updateRequest: async (id, data) => {
            const row = requests.find((r) => r.id === id);
            assert.ok(row);
            Object.assign(row, data);
          },
          setCountersAbsolute: setCounters,
        }),
      ),
    writeAuditLog: async (args) => {
      audits.push(args.action);
    },
  };

  let stripeCalls = 0;
  const webhookResults: string[] = [];
  const createRefundDeps: CreateRefundDeps = {
    findPaymentByBookingId: async () => payment,
    loadBookingEvidence: async () => booking,
    withPaymentLock: (_id, fn) =>
      exclusive(() =>
        fn({
          payment,
          booking,
          requests,
          stripeRefunds,
          createRequest: async (row) => {
            const created: LockRequest = {
              id: row.id ?? `req_${idSeq++}`,
              stripePaymentId: row.stripePaymentId,
              clientRequestId: row.clientRequestId,
              purpose: row.purpose,
              amountCents: row.amountCents,
              status: row.status,
              stripeRefundId: row.stripeRefundId,
              initiatedBy: row.initiatedBy,
              notes: row.notes,
              metadata: row.metadata,
            };
            requests.push(created);
            return created;
          },
          updateRequest: async (id, data) => {
            const row = requests.find((r) => r.id === id);
            assert.ok(row);
            Object.assign(row, data);
            return row;
          },
          setCountersAbsolute: async (input) => {
            await setCounters(input);
          },
        }),
      ),
    createStripeRefund: async (input) => {
      stripeCalls += 1;
      const refund = { id: `re_${stripeCalls}`, status: "succeeded" };
      // Webhook for this refund arrives BEFORE createRefund persists its final state.
      // No payment lock is held by createRefund during the Stripe call.
      await tick();
      webhookResults.push(
        await reconcileRefundWebhookEvent(
          {
            stripeRefundId: refund.id,
            amountCents: input.amountCents,
            status: "succeeded",
            reason: "REQUESTED_BY_CUSTOMER",
            paymentIntentId: "pi_1",
            metadata: input.metadata,
          },
          webhookDeps,
        ),
      );
      return refund;
    },
    upsertStripeRefundMirror: async () => undefined,
    writeAuditLog: async (args) => {
      audits.push(args.action);
    },
  };

  return {
    payment,
    requests,
    webhookDeps,
    createRefundDeps,
    audits,
    getStripeCalls: () => stripeCalls,
    webhookResults,
  };
}

function refundDispatch(world: ReturnType<typeof createRefundWorld>) {
  const state = { calls: 0, actions: [] as string[] };
  const dispatch = async (e: TestEvent): Promise<WebhookDispatchResult> => {
    state.calls += 1;
    assert.ok(e.data);
    const action = await reconcileRefundWebhookEvent(
      {
        stripeRefundId: e.data.refundId,
        amountCents: e.data.amountCents,
        status: e.data.status,
        reason: "REQUESTED_BY_CUSTOMER",
        paymentIntentId: "pi_1",
        metadata: e.data.metadata,
      },
      world.webhookDeps,
    );
    state.actions.push(action);
    return { handled: true, action };
  };
  return { state, dispatch };
}

function pendingRentalRequest(): LockRequest {
  return {
    id: "req_1",
    stripePaymentId: "pay_1",
    clientRequestId: "client-1",
    purpose: "RENTAL",
    amountCents: 5000,
    status: "PENDING",
    stripeRefundId: null,
    initiatedBy: "admin:1",
    notes: null,
    metadata: { reason: "requested_by_customer" },
  };
}

function refundEvent(id: string): TestEvent {
  return {
    id,
    type: "refund.updated",
    data: {
      refundId: "re_1",
      amountCents: 5000,
      status: "succeeded",
      metadata: { clientRequestId: "client-1", purpose: "RENTAL" },
    },
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

/** 1. MOCK — first worker acquires the claim. */
async function testFirstWorkerAcquiresClaim() {
  const { store } = newStore();
  await store.ensureRecord({ id: "evt_1", type: "x", payload: {} });
  const result = await claimWebhookEvent(store, "evt_1", defaultConfig, () => "tok_a");
  assert.equal(result.kind, "acquired");
  if (result.kind !== "acquired") return;
  assert.equal(result.claim.claimGeneration, 1);
  assert.equal(result.claim.attemptCount, 1);
  assert.equal(result.claim.previousStatus, "RECEIVED");
  assert.equal(store.get("evt_1").status, "PROCESSING");
}

/** 2. MOCK — second worker cannot acquire a valid claim (contract-level race model). */
async function testSecondWorkerCannotAcquireValidClaim() {
  const { store } = newStore();
  const state = { calls: 0 };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blockingDispatch = async (): Promise<WebhookDispatchResult> => {
    state.calls += 1;
    await gate;
    return { handled: true, action: "ok" };
  };
  const a = makeDeps(store, blockingDispatch);
  const b = makeDeps(store, blockingDispatch);

  const pA = processWebhookEventWithDeps(event(), a.deps);
  await tick();
  const resultB = await processWebhookEventWithDeps(event(), b.deps);
  assert.deepEqual(resultB, { outcome: "in_flight" });
  assert.equal(state.calls, 1, "handler must not run twice while lease is valid");
  assert.ok(b.audits.includes("webhook_in_flight_skipped"));

  release();
  const resultA = await pA;
  assert.equal(resultA.outcome, "processed");
  assert.equal(store.get("evt_1").status, "PROCESSED");
}

/** 2b. MOCK — truly simultaneous start still yields exactly one handler run. */
async function testSimultaneousStartSingleWinner() {
  const { store } = newStore();
  const { state, dispatch } = countingDispatch();
  const a = makeDeps(store, dispatch);
  const b = makeDeps(store, dispatch);
  const [ra, rb] = await Promise.all([
    processWebhookEventWithDeps(event(), a.deps),
    processWebhookEventWithDeps(event(), b.deps),
  ]);
  const outcomes = [ra.outcome, rb.outcome].sort();
  // One processes; the other is in_flight or (if scheduled after completion) already_processed.
  assert.equal(outcomes.filter((o) => o === "processed").length, 1);
  assert.ok(outcomes.includes("in_flight") || outcomes.includes("already_processed"));
  assert.equal(state.calls, 1);
}

/** 3. MOCK — already processed events are skipped without invoking the handler. */
async function testAlreadyProcessedSkipped() {
  const { store } = newStore();
  const { state, dispatch } = countingDispatch();
  const { deps, audits } = makeDeps(store, dispatch);
  const first = await processWebhookEventWithDeps(event(), deps);
  assert.equal(first.outcome, "processed");
  const second = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(second, { outcome: "already_processed" });
  assert.equal(state.calls, 1);
  assert.ok(audits.includes("webhook_duplicate"));
  assert.equal(store.get("evt_1").attemptCount, 1);
}

/** 3b. MOCK — legacy rows with processed=true but stale status are still skipped. */
async function testLegacyProcessedWithStaleStatusSkipped() {
  const { store } = newStore();
  await store.ensureRecord({ id: "evt_1", type: "x", payload: {} });
  const row = store.get("evt_1");
  row.processed = true; // old code path set only `processed`
  row.status = "RECEIVED";
  const { state, dispatch } = countingDispatch();
  const { deps } = makeDeps(store, dispatch);
  const result = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(result, { outcome: "already_processed" });
  assert.equal(state.calls, 0);
}

/** 4 + 5. MOCK — worker crashes after claim; expired lease is reclaimed and generation increments. */
async function testExpiredClaimReclaimedAndGenerationIncrements() {
  const { store, clock } = newStore();
  await store.ensureRecord({ id: "evt_1", type: "x", payload: {} });
  const crashed = await claimWebhookEvent(store, "evt_1", defaultConfig, () => "tok_crashed");
  assert.equal(crashed.kind, "acquired"); // ...worker then "crashes": nothing else happens.

  const { state, dispatch } = countingDispatch();
  const { deps, logs, audits } = makeDeps(store, dispatch);

  // Before expiry: in flight, no handler.
  const early = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(early, { outcome: "in_flight" });
  assert.equal(state.calls, 0);

  // After expiry: reclaimed.
  clock.nowMs += defaultConfig.leaseSeconds * 1000 + 1;
  const reclaimed = await processWebhookEventWithDeps(event(), deps);
  assert.equal(reclaimed.outcome, "processed");
  assert.equal(state.calls, 1);
  const row = store.get("evt_1");
  assert.equal(row.claimGeneration, 2, "generation increments on reclaim");
  assert.equal(row.attemptCount, 2);
  assert.equal(row.status, "PROCESSED");
  assert.ok(logs.includes("webhook.expired_claim_reclaimed"));
  assert.ok(audits.includes("webhook_claim_reclaimed"));
}

/** 6a. MOCK — stale worker cannot finalize after a newer claim completed. */
async function testStaleWorkerCannotFinalizeAfterNewerClaim() {
  const { store, clock } = newStore();
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let calls = 0;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    calls += 1;
    if (calls === 1) await gateA; // worker A is slow past its lease
    return { handled: true, action: "ok" };
  };
  const a = makeDeps(store, dispatch);
  const b = makeDeps(store, dispatch);

  const pA = processWebhookEventWithDeps(event(), a.deps);
  await tick();
  clock.nowMs += defaultConfig.leaseSeconds * 1000 + 1;

  const resultB = await processWebhookEventWithDeps(event(), b.deps);
  assert.equal(resultB.outcome, "processed");
  assert.equal(store.get("evt_1").claimGeneration, 2);

  releaseA();
  const resultA = await pA;
  assert.deepEqual(resultA, {
    outcome: "retryable_failure",
    code: "CLAIM_SUPERSEDED",
    handlerCompleted: true,
  });
  const row = store.get("evt_1");
  assert.equal(row.status, "PROCESSED", "stale worker must not alter B's completion");
  assert.equal(row.claimGeneration, 2);
  assert.ok(a.logs.includes("webhook.stale_finalization_rejected"));
  assert.ok(a.audits.includes("webhook_stale_finalization_rejected"));
  // Documented limitation: the handler ran twice. Fencing protects the event row only;
  // financial idempotency is what keeps the duplicate run safe (see refund tests below).
  assert.equal(calls, 2);
}

/** 6b. MOCK — stale worker failure must not overwrite a newer owner's PROCESSING state. */
async function testStaleWorkerFailureDoesNotOverwriteNewerOwner() {
  const { store, clock } = newStore();
  let releaseA!: () => void;
  const gateA = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  let calls = 0;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    calls += 1;
    if (calls === 1) {
      await gateA;
      throw new Error("late failure in stale worker");
    }
    await gateB;
    return { handled: true, action: "ok" };
  };
  const a = makeDeps(store, dispatch);
  const b = makeDeps(store, dispatch);

  const pA = processWebhookEventWithDeps(event(), a.deps);
  await tick();
  clock.nowMs += defaultConfig.leaseSeconds * 1000 + 1;
  const pB = processWebhookEventWithDeps(event(), b.deps);
  await tick();

  releaseA();
  const resultA = await pA;
  assert.equal(resultA.outcome, "retryable_failure");
  const mid = store.get("evt_1");
  assert.equal(mid.status, "PROCESSING", "A's release must be fenced out");
  assert.equal(mid.claimGeneration, 2);
  assert.equal(mid.error, null, "A must not write its error over B's claim");

  releaseB();
  const resultB = await pB;
  assert.equal(resultB.outcome, "processed");
  assert.equal(store.get("evt_1").status, "PROCESSED");
}

/** 7. MOCK — retryable failures stay recoverable; no permanent claim. */
async function testRetryableFailureRemainsRecoverable() {
  const { store } = newStore();
  let calls = 0;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    calls += 1;
    if (calls === 1) throw new Error("something unexpected");
    return { handled: true, action: "ok" };
  };
  const { deps, logs } = makeDeps(store, dispatch);
  const first = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(first, {
    outcome: "retryable_failure",
    code: "HANDLER_ERROR",
    handlerCompleted: false,
  });
  const row = store.get("evt_1");
  assert.equal(row.status, "RETRYABLE_FAILED");
  assert.equal(row.claimToken, null);
  assert.equal(row.claimExpiresAtMs, null);
  assert.equal(row.lastErrorCode, "HANDLER_ERROR");
  assert.ok(logs.includes("webhook.retryable_failure"));

  const second = await processWebhookEventWithDeps(event(), deps);
  assert.equal(second.outcome, "processed");
  assert.equal(store.get("evt_1").attemptCount, 2);
  assert.ok(logs.includes("webhook.retry_attempt_started"));
}

/** 7b. MOCK — structured transient DB error is labelled DB_TRANSIENT and remains retryable. */
async function testTransientDbErrorLabelledAndRetryable() {
  const { store } = newStore();
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    throw dbDown();
  };
  const { deps } = makeDeps(store, dispatch);
  const result = await processWebhookEventWithDeps(event(), deps);
  assert.equal(result.outcome, "retryable_failure");
  if (result.outcome !== "retryable_failure") return;
  assert.equal(result.code, "DB_TRANSIENT");
  assert.equal(store.get("evt_1").status, "RETRYABLE_FAILED");
}

/** 8. MOCK — permanent failures are durably dead-lettered and not re-run. */
async function testPermanentFailureDeadLettered() {
  const { store } = newStore();
  let calls = 0;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    calls += 1;
    throw new WebhookPermanentError("EVENT_METADATA_MISSING", "missing metadata");
  };
  const { deps, audits, logs } = makeDeps(store, dispatch);
  const first = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(first, {
    outcome: "permanent_failure",
    code: "EVENT_METADATA_MISSING",
    deadLettered: true,
  });
  const row = store.get("evt_1");
  assert.equal(row.status, "DEAD_LETTER");
  assert.equal(row.processed, false);
  assert.equal(row.lastErrorCode, "EVENT_METADATA_MISSING");
  assert.ok(audits.includes("webhook_dead_lettered"));
  assert.ok(logs.includes("webhook.permanent_failure_dead_lettered"));

  const second = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(second, {
    outcome: "permanent_failure",
    code: "EVENT_DEAD_LETTERED",
    deadLettered: true,
  });
  assert.equal(calls, 1, "dead-lettered event must not be re-run automatically");
  assert.ok(logs.includes("webhook.duplicate_dead_lettered"));
}

/** 8b. MOCK — if the dead-letter write fails, the terminal decision is NOT claimed. */
async function testDeadLetterPersistFailureIsRetryable() {
  const { store } = newStore();
  store.faults.markDeadLetter = true;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    throw new WebhookPermanentError("EVENT_METADATA_MISSING", "missing");
  };
  const { deps } = makeDeps(store, dispatch);
  const result = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(result, {
    outcome: "retryable_failure",
    code: "DEAD_LETTER_PERSIST_FAILED",
    handlerCompleted: false,
  });
  // Never claimed as terminal. The failure evidence is saved via the fenced release and
  // the lease is freed, so the event is recoverable (never permanently stuck).
  const row = store.get("evt_1");
  assert.equal(row.status, "RETRYABLE_FAILED");
  assert.equal(row.lastErrorCode, "EVENT_METADATA_MISSING");
  assert.equal(row.deadLetterReason, null, "no dead-letter reason recorded: write failed");
}

/** 8b'. MOCK — if both dead-letter and release writes fail, the lease expiry still recovers. */
async function testDeadLetterAndReleaseFailureRecoversByLeaseExpiry() {
  const { store, clock } = newStore();
  store.faults.markDeadLetter = true;
  store.faults.release = true;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    throw new WebhookPermanentError("EVENT_METADATA_MISSING", "missing");
  };
  const { deps } = makeDeps(store, dispatch);
  const result = await processWebhookEventWithDeps(event(), deps);
  assert.equal(result.outcome, "retryable_failure");
  assert.equal(store.get("evt_1").status, "PROCESSING");
  // Faults cleared and lease expired: a new claim is permitted and dead-letters it.
  store.faults.markDeadLetter = false;
  store.faults.release = false;
  clock.nowMs += defaultConfig.leaseSeconds * 1000 + 1;
  const retried = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(retried, { outcome: "permanent_failure", code: "EVENT_METADATA_MISSING", deadLettered: true });
  assert.equal(store.get("evt_1").status, "DEAD_LETTER");
}

/** 8c'. MOCK — retry-limit dead-letter keeps the ORIGINAL failure evidence (F10). */
async function testRetryLimitPreservesOriginalEvidence() {
  const { store } = newStore();
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    throw new Error("original handler boom");
  };
  const { deps } = makeDeps(store, dispatch, { config: { leaseSeconds: 300, maxAttempts: 2 } });
  await processWebhookEventWithDeps(event(), deps);
  const second = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(second, { outcome: "permanent_failure", code: "RETRY_LIMIT_EXCEEDED", deadLettered: true });
  const row = store.get("evt_1");
  assert.equal(row.status, "DEAD_LETTER");
  assert.equal(row.deadLetterReason, "RETRY_LIMIT_EXCEEDED");
  assert.equal(row.lastErrorCode, "HANDLER_ERROR", "original code kept, not replaced by RETRY_LIMIT_EXCEEDED");
  assert.match(row.error ?? "", /original handler boom/);
}

/** 8c''. MOCK — limit reached at claim time (no handler run) preserves earlier evidence. */
async function testCapAtClaimPreservesEvidenceAndSkipsHandler() {
  const { store } = newStore();
  let calls = 0;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    calls += 1;
    if (calls === 1) throw new Error("first failure");
    return { handled: true, action: "ok" };
  };
  const { deps } = makeDeps(store, dispatch, { config: { leaseSeconds: 300, maxAttempts: 2 } });
  await processWebhookEventWithDeps(event(), deps); // attempt 1: HANDLER_ERROR, released
  store.faults.markProcessedOnce = true;
  const second = await processWebhookEventWithDeps(event(), deps); // attempt 2: handler ok, finalize fails
  assert.deepEqual(second, { outcome: "retryable_failure", code: "FINALIZE_FAILED", handlerCompleted: true });
  assert.equal(store.get("evt_1").lastErrorCode, "FINALIZE_FAILED");
  const third = await processWebhookEventWithDeps(event(), deps); // attempt 3 > max: no handler
  assert.deepEqual(third, { outcome: "permanent_failure", code: "RETRY_LIMIT_EXCEEDED", deadLettered: true });
  assert.equal(calls, 2, "handler must not run once the attempt limit is exceeded");
  const row = store.get("evt_1");
  assert.equal(row.deadLetterReason, "RETRY_LIMIT_EXCEEDED");
  assert.equal(row.lastErrorCode, "FINALIZE_FAILED", "evidence from the last failure preserved untouched");
  assert.ok(row.error && row.error.length > 0);
}

/** 8c. MOCK — attempt cap: repeated retryable failures dead-letter instead of looping. */
async function testAttemptCapDeadLetters() {
  const { store } = newStore();
  let calls = 0;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    calls += 1;
    throw new Error("always failing");
  };
  const { deps } = makeDeps(store, dispatch, { config: { leaseSeconds: 300, maxAttempts: 2 } });
  const first = await processWebhookEventWithDeps(event(), deps);
  assert.equal(first.outcome, "retryable_failure");
  const second = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(second, {
    outcome: "permanent_failure",
    code: "RETRY_LIMIT_EXCEEDED",
    deadLettered: true,
  });
  assert.equal(store.get("evt_1").status, "DEAD_LETTER");
  const third = await processWebhookEventWithDeps(event(), deps);
  assert.equal(third.outcome, "permanent_failure");
  assert.equal(calls, 2);
}

/** 8d. MOCK — crash loops are capped: attempt beyond the cap dead-letters without a handler run. */
async function testCrashLoopCappedBeforeHandler() {
  const { store, clock } = newStore();
  const config: WebhookClaimConfig = { leaseSeconds: 300, maxAttempts: 1 };
  await store.ensureRecord({ id: "evt_1", type: "x", payload: {} });
  await claimWebhookEvent(store, "evt_1", config, () => "tok_crash_1"); // attempt 1, then crash
  clock.nowMs += config.leaseSeconds * 1000 + 1;
  const { state, dispatch } = countingDispatch();
  const { deps } = makeDeps(store, dispatch, { config });
  const result = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(result, {
    outcome: "permanent_failure",
    code: "RETRY_LIMIT_EXCEEDED",
    deadLettered: true,
  });
  assert.equal(state.calls, 0);
  assert.equal(store.get("evt_1").status, "DEAD_LETTER");
}

/** 9. MOCK — failure to mark processed returns a retryable outcome and stays recoverable. */
async function testFinalizeFailureIsRetryable() {
  const { store } = newStore();
  store.faults.markProcessedOnce = true;
  const { state, dispatch } = countingDispatch();
  const { deps, logs, audits } = makeDeps(store, dispatch);
  const result = await processWebhookEventWithDeps(event(), deps);
  assert.deepEqual(result, {
    outcome: "retryable_failure",
    code: "FINALIZE_FAILED",
    handlerCompleted: true,
  });
  const row = store.get("evt_1");
  assert.equal(row.processed, false);
  assert.equal(row.status, "RETRYABLE_FAILED", "lease released best-effort");
  assert.ok(logs.includes("webhook.handler_succeeded_finalize_failed"));
  assert.ok(audits.includes("webhook_finalize_failed"));
  assert.equal(state.calls, 1);

  const retry = await processWebhookEventWithDeps(event(), deps);
  assert.equal(retry.outcome, "processed");
  assert.equal(state.calls, 2, "handler re-runs after finalize failure; must be idempotent");
}

/** 9b. MOCK — if release also fails, the lease expiry still recovers the event. */
async function testFinalizeAndReleaseFailureRecoversByLeaseExpiry() {
  const { store, clock } = newStore();
  store.faults.markProcessedOnce = true;
  store.faults.release = true;
  const { dispatch } = countingDispatch();
  const { deps } = makeDeps(store, dispatch);
  const first = await processWebhookEventWithDeps(event(), deps);
  assert.equal(first.outcome, "retryable_failure");
  assert.equal(store.get("evt_1").status, "PROCESSING");
  store.faults.release = false;
  clock.nowMs += defaultConfig.leaseSeconds * 1000 + 1;
  const retry = await processWebhookEventWithDeps(event(), deps);
  assert.equal(retry.outcome, "processed");
}

/** 10a. MOCK — duplicate delivery of the same event id never re-runs the refund handler. */
async function testDuplicateEventDoesNotDoubleCountRefund() {
  const world = createRefundWorld({ requests: [pendingRentalRequest()] });
  const { store } = newStore();
  const { state, dispatch } = refundDispatch(world);
  const { deps } = makeDeps(store, dispatch);

  const first = await processWebhookEventWithDeps(refundEvent("evt_a"), deps);
  assert.equal(first.outcome, "processed");
  assert.equal(world.payment.rentalRefundedCents, 5000);

  const second = await processWebhookEventWithDeps(refundEvent("evt_a"), deps);
  assert.deepEqual(second, { outcome: "already_processed" });
  assert.equal(state.calls, 1);
  assert.equal(world.payment.rentalRefundedCents, 5000);
  assert.equal(world.payment.refundedAmountCents, 5000);
}

/** 10b. MOCK — two distinct event ids for the same refund converge via absolute recompute. */
async function testDistinctEventIdsSameRefundDoNotDoubleCount() {
  const world = createRefundWorld({ requests: [pendingRentalRequest()] });
  const { store } = newStore();
  const { state, dispatch } = refundDispatch(world);
  const { deps } = makeDeps(store, dispatch);

  await processWebhookEventWithDeps(refundEvent("evt_created"), deps);
  await processWebhookEventWithDeps(refundEvent("evt_updated"), deps);
  assert.equal(state.calls, 2, "event-level claims are per event id");
  assert.deepEqual(state.actions, ["refund_marked_succeeded", "refund_already_succeeded"]);
  assert.equal(world.payment.rentalRefundedCents, 5000, "refund-level idempotency is independent");
  assert.equal(world.payment.refundedAmountCents, 5000);
}

/** 10c. MOCK — handler commits, finalize fails, redelivery cannot duplicate refund effects. */
async function testFinalizeFailureThenRedeliveryDoesNotDuplicateRefund() {
  const world = createRefundWorld({ requests: [pendingRentalRequest()] });
  const { store } = newStore();
  store.faults.markProcessedOnce = true;
  const { state, dispatch } = refundDispatch(world);
  const { deps } = makeDeps(store, dispatch);

  const first = await processWebhookEventWithDeps(refundEvent("evt_a"), deps);
  assert.equal(first.outcome, "retryable_failure");
  assert.equal(world.payment.rentalRefundedCents, 5000);

  const second = await processWebhookEventWithDeps(refundEvent("evt_a"), deps);
  assert.equal(second.outcome, "processed");
  assert.equal(state.calls, 2);
  assert.deepEqual(state.actions, ["refund_marked_succeeded", "refund_already_succeeded"]);
  assert.equal(world.payment.rentalRefundedCents, 5000);
  assert.equal(world.payment.refundedAmountCents, 5000);
}

/**
 * 11. MOCK — concurrent createRefund requests plus the refund webhook preserve caps.
 * The mutex models payment-row FOR UPDATE serialization only; the real lock is
 * UNVERIFIED here and requires the PostgreSQL integration test in the docs.
 */
async function testConcurrentCreateRefundAndWebhookPreserveCaps(createRefund: CreateRefundFn) {
  const world = createRefundWorld();
  const base: Omit<CreateRefundInput, "clientRequestId"> = {
    bookingId: "booking_1",
    purpose: "RENTAL",
    reason: "requested_by_customer",
    initiatedBy: "admin:1",
    amountEur: 100,
  };

  // Rental allocation is 180 EUR: two concurrent 100 EUR requests cannot both fit.
  const [a, b] = await Promise.all([
    createRefund({ ...base, clientRequestId: "client-A" }, world.createRefundDeps),
    createRefund({ ...base, clientRequestId: "client-B" }, world.createRefundDeps),
  ]);

  const oks = [a, b].filter((r) => r.ok);
  const rejected = [a, b].filter((r) => !r.ok);
  assert.equal(oks.length, 1, "exactly one of the concurrent refunds may reserve capacity");
  assert.equal(rejected.length, 1);
  const rejection = rejected[0];
  assert.ok(rejection && !rejection.ok);
  assert.equal(rejection.code, "no_capacity");
  assert.equal(world.getStripeCalls(), 1, "no Stripe refund for the rejected reservation");

  assert.deepEqual(world.webhookResults, ["refund_marked_succeeded"]);
  assert.equal(world.payment.rentalRefundedCents, 10000);
  assert.equal(world.payment.refundedAmountCents, 10000);
  assert.ok(world.payment.rentalRefundedCents <= world.payment.rentalAmountCents);
  const succeeded = world.requests.filter((r) => r.status === "SUCCEEDED");
  assert.equal(succeeded.length, 1);

  // A later duplicate webhook for the same refund (different event id) changes nothing.
  const replay = await reconcileRefundWebhookEvent(
    {
      stripeRefundId: "re_1",
      amountCents: 10000,
      status: "succeeded",
      reason: "REQUESTED_BY_CUSTOMER",
      paymentIntentId: "pi_1",
      metadata: { clientRequestId: succeeded[0]?.clientRequestId ?? "", purpose: "RENTAL" },
    },
    world.webhookDeps,
  );
  assert.equal(replay, "refund_already_succeeded");
  assert.equal(world.payment.rentalRefundedCents, 10000);
}

/** 13. MOCK — unsupported event types follow the documented terminal policy. */
async function testUnsupportedEventTerminalPolicy() {
  const { store } = newStore();
  let calls = 0;
  const dispatch = async (): Promise<WebhookDispatchResult> => {
    calls += 1;
    return { handled: false };
  };
  const { deps, logs } = makeDeps(store, dispatch);
  const first = await processWebhookEventWithDeps(event("evt_u", "customer.created"), deps);
  assert.deepEqual(first, { outcome: "ignored", action: "unhandled", attemptCount: 1 });
  const row = store.get("evt_u");
  assert.equal(row.status, "PROCESSED", "terminal decision is recorded before acknowledging");
  assert.equal(row.processed, true);
  assert.ok(logs.includes("webhook.event_ignored_unsupported"));

  const second = await processWebhookEventWithDeps(event("evt_u", "customer.created"), deps);
  assert.deepEqual(second, { outcome: "already_processed" });
  assert.equal(calls, 1);
}

/** 13b. MOCK — if the ignored decision cannot be recorded, it is not acknowledged. */
async function testIgnoredNotAcknowledgedWhenFinalizeFails() {
  const { store } = newStore();
  store.faults.markProcessedOnce = true;
  const dispatch = async (): Promise<WebhookDispatchResult> => ({ handled: false });
  const { deps } = makeDeps(store, dispatch);
  const result = await processWebhookEventWithDeps(event("evt_u", "customer.created"), deps);
  assert.equal(result.outcome, "retryable_failure");
}

/** MOCK — database outage before durable classification is retryable, never "handled". */
async function testEnsureAndClaimOutagesAreRetryable() {
  const a = newStore();
  a.store.faults.ensure = true;
  const da = countingDispatch();
  const depsA = makeDeps(a.store, da.dispatch).deps;
  const ra = await processWebhookEventWithDeps(event(), depsA);
  assert.deepEqual(ra, {
    outcome: "retryable_failure",
    code: "DB_TRANSIENT",
    handlerCompleted: false,
  });
  assert.equal(da.state.calls, 0);

  const b = newStore();
  b.store.faults.tryClaim = true;
  const db = countingDispatch();
  const depsB = makeDeps(b.store, db.dispatch).deps;
  const rb = await processWebhookEventWithDeps(event(), depsB);
  assert.equal(rb.outcome, "retryable_failure");
  assert.equal(db.state.calls, 0);
}

/** MOCK — audit/log failures never flip a completed handler into a failure. */
async function testAuditFailureDoesNotChangeOutcome() {
  const { store } = newStore();
  const { state, dispatch } = countingDispatch();
  const { deps } = makeDeps(store, dispatch, { auditThrows: true });
  const result = await processWebhookEventWithDeps(event(), deps);
  assert.equal(result.outcome, "processed");
  assert.equal(state.calls, 1);
  assert.equal(store.get("evt_1").status, "PROCESSED");
}

/** MOCK — lease configuration is bounded and falls back safely. */
function testLeaseConfigBounded() {
  assert.deepEqual(resolveWebhookClaimConfig({}), { leaseSeconds: 300, maxAttempts: 8 });
  assert.equal(resolveWebhookClaimConfig({ STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS: "5" }).leaseSeconds, 60);
  assert.equal(
    resolveWebhookClaimConfig({ STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS: "999999" }).leaseSeconds,
    1800,
  );
  assert.equal(
    resolveWebhookClaimConfig({ STRIPE_WEBHOOK_CLAIM_LEASE_SECONDS: "abc" }).leaseSeconds,
    300,
  );
  // Stage 3.21: an unsafe limit (0/1/2) can no longer disable retries.
  for (const unsafe of ["0", "1", "2", "-5"]) {
    assert.equal(
      resolveWebhookClaimConfig({ STRIPE_WEBHOOK_MAX_ATTEMPTS: unsafe }).maxAttempts,
      MIN_WEBHOOK_MAX_ATTEMPTS,
      `max attempts "${unsafe}" must clamp to the safe minimum`,
    );
  }
  assert.equal(MIN_WEBHOOK_MAX_ATTEMPTS, 3);
  assert.equal(resolveWebhookClaimConfig({ STRIPE_WEBHOOK_MAX_ATTEMPTS: "7" }).maxAttempts, 7);
  assert.equal(resolveWebhookClaimConfig({ STRIPE_WEBHOOK_MAX_ATTEMPTS: "999" }).maxAttempts, 50);
}

/** 14. STATIC — existing sequential refund webhook regression remains wired in. */
function testExistingRefundWebhookRegressionRemainsRepresented() {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    pkg.scripts["test:refund-webhook-reconciliation"],
    "tsx scripts/test-refund-webhook-reconciliation.ts",
  );
  const text = fs.readFileSync(
    path.join(root, "scripts/test-refund-webhook-reconciliation.ts"),
    "utf8",
  );
  assert.match(text, /testDuplicateWebhookDoesNotDoubleCount/);
}

async function main() {
  const { createRefund } = await import("../src/lib/stripe/refund-service");

  const tests: Array<[string, () => void | Promise<void>]> = [
    ["MOCK first worker acquires claim", testFirstWorkerAcquiresClaim],
    ["MOCK second worker cannot acquire valid claim", testSecondWorkerCannotAcquireValidClaim],
    ["MOCK simultaneous start single winner", testSimultaneousStartSingleWinner],
    ["MOCK already processed skipped", testAlreadyProcessedSkipped],
    ["MOCK legacy processed with stale status skipped", testLegacyProcessedWithStaleStatusSkipped],
    ["MOCK expired claim reclaimed + generation increments", testExpiredClaimReclaimedAndGenerationIncrements],
    ["MOCK stale worker cannot finalize after newer claim", testStaleWorkerCannotFinalizeAfterNewerClaim],
    ["MOCK stale worker failure cannot overwrite newer owner", testStaleWorkerFailureDoesNotOverwriteNewerOwner],
    ["MOCK retryable failure remains recoverable", testRetryableFailureRemainsRecoverable],
    ["MOCK transient DB error labelled and retryable", testTransientDbErrorLabelledAndRetryable],
    ["MOCK permanent failure dead-lettered", testPermanentFailureDeadLettered],
    ["MOCK dead-letter persist failure retryable", testDeadLetterPersistFailureIsRetryable],
    ["MOCK dead-letter + release failure recovers by lease expiry", testDeadLetterAndReleaseFailureRecoversByLeaseExpiry],
    ["MOCK retry limit preserves original evidence", testRetryLimitPreservesOriginalEvidence],
    ["MOCK cap at claim preserves evidence and skips handler", testCapAtClaimPreservesEvidenceAndSkipsHandler],
    ["MOCK attempt cap dead-letters", testAttemptCapDeadLetters],
    ["MOCK crash loop capped before handler", testCrashLoopCappedBeforeHandler],
    ["MOCK finalize failure retryable", testFinalizeFailureIsRetryable],
    ["MOCK finalize+release failure recovers by lease expiry", testFinalizeAndReleaseFailureRecoversByLeaseExpiry],
    ["MOCK duplicate event does not double-count refund", testDuplicateEventDoesNotDoubleCountRefund],
    ["MOCK distinct event ids same refund do not double-count", testDistinctEventIdsSameRefundDoNotDoubleCount],
    ["MOCK finalize failure then redelivery does not duplicate refund", testFinalizeFailureThenRedeliveryDoesNotDuplicateRefund],
    ["MOCK concurrent createRefund + webhook preserve caps", () => testConcurrentCreateRefundAndWebhookPreserveCaps(createRefund)],
    ["MOCK unsupported event terminal policy", testUnsupportedEventTerminalPolicy],
    ["MOCK ignored not acknowledged when finalize fails", testIgnoredNotAcknowledgedWhenFinalizeFails],
    ["MOCK ensure/claim outage retryable", testEnsureAndClaimOutagesAreRetryable],
    ["MOCK audit failure does not change outcome", testAuditFailureDoesNotChangeOutcome],
    ["MOCK lease config bounded", testLeaseConfigBounded],
    ["STATIC existing refund webhook regression represented", testExistingRefundWebhookRegressionRemainsRepresented],
  ];

  for (const [name, fn] of tests) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} mocked webhook claim tests defined (PostgreSQL concurrency NOT covered).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
