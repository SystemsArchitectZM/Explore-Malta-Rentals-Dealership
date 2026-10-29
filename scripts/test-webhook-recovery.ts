/**
 * Webhook durable-recovery tests (Stage 3.21). NOT EXECUTED by the authoring stage.
 *
 *   npm run test:webhook-recovery
 *
 * Labels (read before trusting any result):
 *   MOCK   - runs the real recovery module and the real orchestrator against an
 *            in-memory store that models the WebhookEventStore CONTRACT with a
 *            synchronous compare-and-swap. JavaScript is single-threaded, so MOCK
 *            "concurrency" tests verify the state machine and the use of the claim
 *            contract. They do NOT prove PostgreSQL row-lock / READ COMMITTED
 *            behaviour, and the in-memory candidate filter below is a MODEL of the SQL
 *            in webhook-recovery-store.ts (the SQL itself is only checked statically).
 *   FAKE   - runs the real store query functions against a fake client that records
 *            SQL text and returns canned rows (no database).
 *   STATIC - source/doc text assertions.
 *
 * Real-PostgreSQL integration tests are SPECIFIED (not implemented) in
 * docs/stripe-webhook-reliability.md under "Real PostgreSQL integration tests".
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import type {
  WebhookClaim,
  WebhookClaimConfig,
  WebhookDeadLetterRecord,
  WebhookEventRecordInput,
  WebhookEventState,
  WebhookEventStore,
  WebhookFailureRecord,
  WebhookRecoveryClaimOptions,
} from "../src/lib/stripe/webhook-event-claim";
import {
  RECOVERY_EXCLUDED_EVENT_TYPES,
  isRecoveryExcludedCandidate,
  isRecoveryExcludedEventType,
  resolveClaimProtocolCutover,
  resolveRecoveryBudgetMs,
  resolveWebhookRecoveryConfig,
} from "../src/lib/stripe/webhook-recovery-policy";
import { WebhookPermanentError } from "../src/lib/stripe/webhook-errors";
import {
  processWebhookEventWithDeps,
  type WebhookDispatchResult,
  type WebhookProcessingDeps,
} from "../src/lib/stripe/webhook-processing";
import {
  buildEventFromCandidate,
  normalizeRecoveryRunInput,
  RECOVERY_DEFAULT_BATCH_SIZE,
  RECOVERY_DEFAULT_MAX_DURATION_MS,
  RECOVERY_MAX_BATCH_SIZE,
  runWebhookRecovery,
  WebhookRecoveryLookupError,
  type RecoveryEvent,
  type WebhookRecoveryCandidate,
  type WebhookRecoveryDeps,
} from "../src/lib/stripe/webhook-recovery";
import type { WebhookEventStatusValue } from "../src/lib/stripe/types";

process.env.DATABASE_URL ??= "postgresql://localhost:5432/explore_malta_test_unused";

const root = process.cwd();
function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

// ─── In-memory store (contract model only) ─────────────────────────────────────

type Row = {
  id: string;
  stripeEventId: string;
  eventType: string;
  payload: unknown;
  processed: boolean;
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
  faults = { markDeadLetter: false, release: false };
  writes = 0;

  constructor(private readonly clock: Clock) {}

  seed(partial: Partial<Row> & { stripeEventId: string }): Row {
    const row: Row = {
      id: `row_${partial.stripeEventId}`,
      eventType: "payment_intent.succeeded",
      payload: { data: { object: { id: "pi_1" } } },
      processed: false,
      status: "RETRYABLE_FAILED",
      claimToken: null,
      claimExpiresAtMs: null,
      claimGeneration: 1,
      attemptCount: 1,
      lastErrorCode: "HANDLER_ERROR",
      error: "earlier failure",
      deadLetterReason: null,
      lastAttemptAtMs: this.clock.nowMs - 3_600_000,
      createdAtMs: this.clock.nowMs - 7_200_000,
      ...partial,
    };
    this.rows.set(row.stripeEventId, row);
    return row;
  }

  async ensureRecord(event: WebhookEventRecordInput): Promise<void> {
    if (!this.rows.has(event.id)) {
      this.writes += 1;
      this.seed({
        stripeEventId: event.id,
        eventType: event.type,
        payload: event.payload,
        status: "RECEIVED",
        claimGeneration: 0,
        attemptCount: 0,
        lastErrorCode: null,
        error: null,
        lastAttemptAtMs: null,
        createdAtMs: this.clock.nowMs,
      });
    }
  }

  claimCalls: Array<{ stripeEventId: string; recovery: boolean }> = [];

  async tryClaim(input: {
    stripeEventId: string;
    claimToken: string;
    leaseSeconds: number;
    recovery?: WebhookRecoveryClaimOptions;
  }): Promise<WebhookClaim | null> {
    this.claimCalls.push({ stripeEventId: input.stripeEventId, recovery: input.recovery !== undefined });
    const row = this.rows.get(input.stripeEventId);
    if (!row || row.processed) return null;
    const leaseExpired = row.claimExpiresAtMs === null || row.claimExpiresAtMs <= this.clock.nowMs;
    const claimable =
      row.status === "RECEIVED" ||
      row.status === "RETRYABLE_FAILED" ||
      (row.status === "PROCESSING" && leaseExpired);
    if (!claimable) return null;
    // Recovery-only narrowing: mirrors the atomic predicate in claimForRecovery (SQL is
    // only checked statically). A refusal leaves the row completely untouched.
    if (input.recovery && !modelRecoveryEligible(row, input.recovery, this.clock.nowMs)) return null;
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
      leaseActive: row.claimExpiresAtMs !== null && row.claimExpiresAtMs > this.clock.nowMs,
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
    const row = this.fenced(claim);
    if (!row) return false;
    row.status = "PROCESSED";
    row.processed = true;
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

/**
 * MODEL of the candidate SELECT in webhook-recovery-store.ts (same predicates). It
 * exists so MOCK tests can drive recovery from "durable state"; it does not prove the
 * SQL. The SQL predicates are asserted statically further down.
 */
function modelRecoveryEligible(
  row: Row,
  options: WebhookRecoveryClaimOptions,
  nowMs: number,
): boolean {
  if (row.processed) return false;
  if (isRecoveryExcludedEventType(row.eventType)) return false;
  const payloadType =
    typeof row.payload === "object" && row.payload !== null && !Array.isArray(row.payload)
      ? (row.payload as Record<string, unknown>).type
      : undefined;
  if (isRecoveryExcludedEventType(payloadType)) return false;
  const minAgeMs = options.minRetryAgeSeconds * 1000;
  if (row.status === "PROCESSING") {
    return (
      row.claimGeneration >= 1 &&
      (row.claimExpiresAtMs === null || row.claimExpiresAtMs <= nowMs)
    );
  }
  if (row.status === "RETRYABLE_FAILED") {
    return (
      row.claimGeneration >= 1 &&
      (row.lastAttemptAtMs === null || row.lastAttemptAtMs <= nowMs - minAgeMs)
    );
  }
  if (row.status === "RECEIVED") {
    if (options.claimProtocolCutoverIso === null || row.claimGeneration !== 0) return false;
    return (
      row.createdAtMs >= Date.parse(options.claimProtocolCutoverIso) &&
      row.createdAtMs <= nowMs - minAgeMs
    );
  }
  return false;
}

function modelListCandidates(store: InMemoryWebhookStore, clock: Clock) {
  return async (input: {
    limit: number;
    minRetryAgeSeconds: number;
    claimProtocolCutoverIso?: string | null;
  }): Promise<WebhookRecoveryCandidate[]> => {
    const options: WebhookRecoveryClaimOptions = {
      minRetryAgeSeconds: input.minRetryAgeSeconds,
      claimProtocolCutoverIso: input.claimProtocolCutoverIso ?? null,
    };
    const rows = [...store.rows.values()].filter((row) => modelRecoveryEligible(row, options, clock.nowMs));
    rows.sort((a, b) => (a.lastAttemptAtMs ?? -Infinity) - (b.lastAttemptAtMs ?? -Infinity));
    return rows.slice(0, input.limit).map((row) => ({
      stripeEventId: row.stripeEventId,
      eventType: row.eventType,
      status:
        row.status === "PROCESSING"
          ? ("PROCESSING" as const)
          : row.status === "RECEIVED"
            ? ("RECEIVED" as const)
            : ("RETRYABLE_FAILED" as const),
      attemptCount: row.attemptCount,
      payload: row.payload,
    }));
  };
}

// ─── Harness ───────────────────────────────────────────────────────────────────

const defaultConfig: WebhookClaimConfig = { leaseSeconds: 300, maxAttempts: 8 };
let tokenSeq = 0;

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function newWorld(config: WebhookClaimConfig = defaultConfig) {
  const clock: Clock = { nowMs: 10_000_000 };
  const store = new InMemoryWebhookStore(clock);
  const handler = { calls: [] as string[], impl: async (_e: RecoveryEvent): Promise<WebhookDispatchResult> => ({ handled: true, action: "ok" }) };
  // Processing-layer (orchestrator) ops-log events, kept separate from recovery-layer `logs`.
  const processingLogs: string[] = [];
  const orchestratorDeps: WebhookProcessingDeps<RecoveryEvent> = {
    store,
    config,
    dispatch: async (event) => {
      handler.calls.push(event.id);
      return handler.impl(event);
    },
    audit: async () => undefined,
    log: (name) => {
      processingLogs.push(name);
    },
    newClaimToken: () => `tok_${(tokenSeq += 1)}`,
  };
  const audits: Array<{ action: string; actor: string; newValue: Record<string, unknown> }> = [];
  const logs: string[] = [];
  const recoveryDeps = (overrides: Partial<WebhookRecoveryDeps> = {}): WebhookRecoveryDeps => ({
    listCandidates: modelListCandidates(store, clock),
    processEvent: (event, recovery) => processWebhookEventWithDeps(event, orchestratorDeps, recovery),
    audit: async (args) => {
      audits.push(args);
    },
    log: (name) => {
      logs.push(name);
    },
    now: () => clock.nowMs,
    ...overrides,
  });
  return { clock, store, handler, audits, logs, processingLogs, recoveryDeps, orchestratorDeps };
}

const ACTOR = "admin:test-1";

// ─── Tests ─────────────────────────────────────────────────────────────────────

/** MOCK — an ACTIVE lease is never stolen: not listed, and even if forced, claim refuses. */
async function testActiveLeaseNeverStolen() {
  const w = newWorld();
  const row = w.store.seed({
    stripeEventId: "evt_active",
    status: "PROCESSING",
    claimToken: "owner_tok",
    claimExpiresAtMs: w.clock.nowMs + 120_000,
    claimGeneration: 3,
    attemptCount: 3,
  });

  const normal = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(normal.scanned, 0, "active lease is not a recovery candidate");

  // Force the candidate through anyway (bypassing the lister): the claim must refuse.
  const forced = await runWebhookRecovery(
    {},
    ACTOR,
    w.recoveryDeps({
      listCandidates: async () => [
        { stripeEventId: "evt_active", eventType: row.eventType, status: "PROCESSING", attemptCount: 3, payload: row.payload },
      ],
    }),
  );
  assert.equal(forced.skippedInFlight, 1);
  assert.equal(forced.recovered, 0);
  assert.equal(w.handler.calls.length, 0, "handler must not run for an event another worker owns");
  assert.equal(row.claimToken, "owner_tok", "owner's token untouched");
  assert.equal(row.claimGeneration, 3, "generation not advanced");
  assert.equal(row.status, "PROCESSING");
}

/** MOCK — an EXPIRED lease may be reclaimed, only via the normal claim contract. */
async function testExpiredLeaseReclaimedViaClaim() {
  const w = newWorld();
  const row = w.store.seed({
    stripeEventId: "evt_expired",
    status: "PROCESSING",
    claimToken: "dead_owner",
    claimExpiresAtMs: w.clock.nowMs - 1,
    claimGeneration: 2,
    attemptCount: 2,
  });
  const result = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(result.scanned, 1);
  assert.equal(result.recovered, 1);
  assert.deepEqual(w.handler.calls, ["evt_expired"]);
  assert.equal(row.status, "PROCESSED");
  assert.equal(row.processed, true);
  assert.equal(row.claimGeneration, 3, "reclaim goes through tryClaim and advances the fencing generation");
  assert.equal(row.attemptCount, 3);
}

/** MOCK — a stale owner cannot finalize after recovery reclaimed the event. */
async function testStaleOwnerFencedAfterRecoveryReclaim() {
  const w = newWorld();
  const row = w.store.seed({
    stripeEventId: "evt_stale",
    status: "PROCESSING",
    claimToken: "old_tok",
    claimExpiresAtMs: w.clock.nowMs - 1,
    claimGeneration: 1,
    attemptCount: 1,
  });
  const staleClaim: WebhookClaim = {
    eventRowId: row.id,
    stripeEventId: "evt_stale",
    claimToken: "old_tok",
    claimGeneration: 1,
    attemptCount: 1,
    previousStatus: "RECEIVED",
  };
  await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(row.status, "PROCESSED");
  assert.equal(await w.store.markProcessed(staleClaim), false, "stale claim rejected by fencing");
  assert.equal(await w.store.releaseForRetry(staleClaim, { code: "X", message: "y" }), false);
  assert.equal(await w.store.markDeadLetter(staleClaim, { reason: "X" }), false);
  assert.equal(row.status, "PROCESSED");
}

/** MOCK — aged RETRYABLE_FAILED events are eligible; fresh ones and unclaimed/legacy rows are not. */
async function testRetryableEligibilityAndExclusions() {
  const w = newWorld();
  w.store.seed({ stripeEventId: "evt_aged", status: "RETRYABLE_FAILED" });
  w.store.seed({
    stripeEventId: "evt_fresh",
    status: "RETRYABLE_FAILED",
    lastAttemptAtMs: w.clock.nowMs - 10_000,
  });
  w.store.seed({
    stripeEventId: "evt_legacy",
    status: "RETRYABLE_FAILED",
    claimGeneration: 0,
    lastErrorCode: "LEGACY_UNCLASSIFIED_ERROR",
  });
  w.store.seed({ stripeEventId: "evt_received", status: "RECEIVED", claimGeneration: 0, attemptCount: 0 });
  const result = await runWebhookRecovery({ minRetryAgeSeconds: 300 }, ACTOR, w.recoveryDeps());
  assert.deepEqual(w.handler.calls, ["evt_aged"]);
  assert.equal(result.recovered, 1);
  assert.equal(w.store.get("evt_fresh").status, "RETRYABLE_FAILED");
  assert.equal(w.store.get("evt_legacy").attemptCount, 1, "legacy row untouched (needs operator review)");
  assert.equal(w.store.get("evt_received").status, "RECEIVED");
}

/** MOCK — PROCESSED and DEAD_LETTER events are never auto-replayed. */
async function testProcessedAndDeadLetterNotReplayed() {
  const w = newWorld();
  w.store.seed({ stripeEventId: "evt_done", status: "PROCESSED", processed: true });
  w.store.seed({
    stripeEventId: "evt_dead",
    status: "DEAD_LETTER",
    deadLetterReason: "BOOKING_CANCELLED_PAYMENT_RECEIVED",
    lastErrorCode: "BOOKING_CANCELLED_PAYMENT_RECEIVED",
  });
  const listed = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(listed.scanned, 0);

  // Forced through (race): the claim contract still refuses to replay.
  const forceBoth = (): WebhookRecoveryDeps =>
    w.recoveryDeps({
      listCandidates: async () =>
        ["evt_done", "evt_dead"].map((id) => ({
          stripeEventId: id,
          eventType: "payment_intent.succeeded",
          status: "RETRYABLE_FAILED" as const,
          attemptCount: 1,
          payload: {},
        })),
    });
  const forced = await runWebhookRecovery({}, ACTOR, forceBoth());
  assert.equal(forced.alreadyProcessed, 1);
  assert.equal(forced.alreadyDeadLettered, 1);
  assert.equal(forced.deadLettered, 0, "a pre-existing dead letter is not re-counted as a new one");
  assert.equal(forced.recovered, 0);
  assert.equal(w.handler.calls.length, 0);
  assert.equal(w.store.get("evt_dead").status, "DEAD_LETTER");
}

/** MOCK — work per invocation is bounded; remaining work is reported, not silently run. */
async function testBatchBounded() {
  const w = newWorld();
  for (let i = 0; i < 30; i += 1) {
    w.store.seed({ stripeEventId: `evt_${i}`, lastAttemptAtMs: w.clock.nowMs - 3_600_000 + i });
  }
  const limits: number[] = [];
  const result = await runWebhookRecovery(
    { batchSize: 5 },
    ACTOR,
    w.recoveryDeps({
      listCandidates: async (input) => {
        limits.push(input.limit);
        return modelListCandidates(w.store, w.clock)(input);
      },
    }),
  );
  assert.deepEqual(limits, [6], "asks for batchSize + 1 to detect hasMore");
  assert.equal(result.attempted, 5);
  assert.equal(result.scanned, 5);
  assert.equal(result.hasMore, true);
  assert.equal(w.handler.calls.length, 5);

  // Defensive input clamping for direct callers.
  assert.equal(normalizeRecoveryRunInput({ batchSize: 10_000 }).batchSize, RECOVERY_MAX_BATCH_SIZE);
  assert.equal(normalizeRecoveryRunInput({ batchSize: 0 }).batchSize, 1);
  assert.equal(normalizeRecoveryRunInput({ batchSize: 2.5 }).batchSize, RECOVERY_DEFAULT_BATCH_SIZE);
  assert.equal(RECOVERY_DEFAULT_BATCH_SIZE, 5, "Stage 3.23: default batch lowered from 25-era 10 to 5");
  assert.equal(normalizeRecoveryRunInput({}).batchSize, 5);
  assert.equal(RECOVERY_MAX_BATCH_SIZE, 25, "maximum unchanged");
  assert.equal(normalizeRecoveryRunInput({ minRetryAgeSeconds: 1 }).minRetryAgeSeconds, 60);
  assert.equal(normalizeRecoveryRunInput({ minRetryAgeSeconds: 10 ** 9 }).minRetryAgeSeconds, 86_400);
}

/** MOCK — the per-invocation time budget stops the run early. */
async function testTimeBudgetStopsRun() {
  const w = newWorld();
  for (let i = 0; i < 5; i += 1) w.store.seed({ stripeEventId: `evt_t${i}` });
  let t = 0;
  const result = await runWebhookRecovery(
    { batchSize: 5 },
    ACTOR,
    w.recoveryDeps({ now: () => (t += 6_000), maxDurationMs: 10_000 }),
  );
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.hasMore, true);
  assert.ok(result.attempted < result.scanned);
}

/** MOCK — retry exhaustion via recovery: dead-letter preserves evidence; no unbounded loop. */
async function testRetryExhaustionPreservesEvidenceAndStops() {
  const w = newWorld({ leaseSeconds: 300, maxAttempts: 3 });
  const row = w.store.seed({
    stripeEventId: "evt_exhausted",
    status: "RETRYABLE_FAILED",
    attemptCount: 3,
    lastErrorCode: "DB_TRANSIENT",
    error: "original transient failure",
  });
  const first = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(first.deadLettered, 1);
  assert.equal(first.events[0]?.code, "RETRY_LIMIT_EXCEEDED");
  assert.equal(w.handler.calls.length, 0, "handler is not run once the limit is exceeded");
  assert.equal(row.status, "DEAD_LETTER");
  assert.equal(row.deadLetterReason, "RETRY_LIMIT_EXCEEDED");
  assert.equal(row.lastErrorCode, "DB_TRANSIENT", "original evidence preserved");
  assert.equal(row.error, "original transient failure");

  const second = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(second.scanned, 0, "dead-lettered events are not selected again (no loop)");
}

/** MOCK — below the limit an event stays recoverable across repeated runs, then terminates. */
async function testRepeatedRecoveryTerminates() {
  const w = newWorld({ leaseSeconds: 300, maxAttempts: 3 });
  w.handler.impl = async () => {
    throw new Error("still broken");
  };
  const row = w.store.seed({ stripeEventId: "evt_loop", attemptCount: 0, claimGeneration: 1 });
  let runs = 0;
  for (; runs < 10; runs += 1) {
    w.clock.nowMs += 400_000; // beyond the minimum retry age
    const r = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
    if (r.scanned === 0) break;
  }
  assert.equal(row.status, "DEAD_LETTER");
  assert.equal(row.deadLetterReason, "RETRY_LIMIT_EXCEEDED");
  assert.ok(runs <= 4, `bounded by the attempt limit (ran ${runs} recovery passes)`);
  assert.ok(w.handler.calls.length <= 3, "handler never exceeds maxAttempts");
  assert.equal(row.lastErrorCode, "HANDLER_ERROR");
}

/** MOCK — failed terminal persistence is never reported as success or as dead-lettered. */
async function testFailedTerminalWriteIsNotSuccess() {
  const w = newWorld();
  w.store.faults.markDeadLetter = true;
  w.handler.impl = async () => {
    throw new WebhookPermanentError("EVENT_METADATA_MISSING", "missing");
  };
  const row = w.store.seed({ stripeEventId: "evt_perm" });
  const result = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(result.recovered, 0);
  assert.equal(result.deadLettered, 0, "terminal state was not persisted, so not counted");
  assert.equal(result.stillRetryable, 1);
  assert.equal(result.events[0]?.code, "DEAD_LETTER_PERSIST_FAILED");
  assert.notEqual(row.status, "DEAD_LETTER");
  assert.notEqual(row.status, "PROCESSED");
}

/** MOCK — a handler that completed but could not be finalized is not counted as recovered. */
async function testFinalizeFailureNotCountedAsRecovered() {
  const w = newWorld();
  const row = w.store.seed({ stripeEventId: "evt_fin" });
  const realMarkProcessed = w.store.markProcessed.bind(w.store);
  w.store.markProcessed = async () => {
    throw dbDown();
  };
  const result = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(result.recovered, 0);
  assert.equal(result.stillRetryable, 1);
  assert.equal(result.events[0]?.code, "FINALIZE_FAILED");
  assert.equal(row.processed, false);
  w.store.markProcessed = realMarkProcessed;
}

/** MOCK — concurrent recovery invocations cannot both own an event (contract model only). */
async function testConcurrentInvocationsSingleOwner() {
  const w = newWorld();
  w.handler.impl = async () => {
    await tick();
    await tick();
    return { handled: true, action: "ok" };
  };
  for (let i = 0; i < 6; i += 1) w.store.seed({ stripeEventId: `evt_c${i}` });
  const [a, b] = await Promise.all([
    runWebhookRecovery({ batchSize: 6 }, "admin:a", w.recoveryDeps()),
    runWebhookRecovery({ batchSize: 6 }, "admin:b", w.recoveryDeps()),
  ]);
  const counts = new Map<string, number>();
  for (const id of w.handler.calls) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(counts.get(`evt_c${i}`), 1, `evt_c${i} handled exactly once`);
  }
  assert.equal(a.recovered + b.recovered, 6);
  assert.ok(a.skippedInFlight + b.skippedInFlight + a.alreadyProcessed + b.alreadyProcessed >= 6);
  for (let i = 0; i < 6; i += 1) {
    assert.equal(w.store.get(`evt_c${i}`).claimGeneration, 2, "exactly one new claim won each event");
  }
}

/** MOCK — recovery is never reported as success when the orchestrator throws unexpectedly. */
async function testUnexpectedProcessThrowIsErrorNotSuccess() {
  const w = newWorld();
  w.store.seed({ stripeEventId: "evt_a" });
  w.store.seed({ stripeEventId: "evt_b", lastAttemptAtMs: w.clock.nowMs - 3_500_000 });
  let n = 0;
  const result = await runWebhookRecovery(
    {},
    ACTOR,
    w.recoveryDeps({
      processEvent: async (event) => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return processWebhookEventWithDeps(event, w.orchestratorDeps);
      },
    }),
  );
  assert.equal(result.errors, 1);
  assert.equal(result.recovered, 1, "the batch continued after one unexpected error");
  assert.ok(result.events.some((e) => e.outcome === "error" && e.code === "RECOVERY_DISPATCH_ERROR"));
}

/** MOCK — candidate lookup failure attempts nothing and surfaces a typed error. */
async function testLookupFailureAttemptsNothing() {
  const w = newWorld();
  let processed = 0;
  await assert.rejects(
    () =>
      runWebhookRecovery(
        {},
        ACTOR,
        w.recoveryDeps({
          listCandidates: async () => {
            throw dbDown();
          },
          processEvent: async () => {
            processed += 1;
            return { outcome: "already_processed" };
          },
        }),
      ),
    (error: unknown) => error instanceof WebhookRecoveryLookupError && error.code === "RECOVERY_LOOKUP_FAILED",
  );
  assert.equal(processed, 0);
}

/** MOCK — run-level audit has counts and ids only; audit failure does not change the result. */
async function testAuditContentAndFailureIsolation() {
  const w = newWorld();
  w.store.seed({ stripeEventId: "evt_audit", payload: { data: { object: { secret: "card_4242" } } } });
  const result = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(w.audits.length, 1);
  assert.equal(w.audits[0]?.action, "webhook_recovery_run");
  assert.equal(w.audits[0]?.actor, ACTOR);
  const serialized = JSON.stringify(w.audits[0]);
  assert.doesNotMatch(serialized, /card_4242|payload|secret/);
  assert.equal(w.audits[0]?.newValue.recovered, 1);

  const w2 = newWorld();
  w2.store.seed({ stripeEventId: "evt_audit2" });
  const after = await runWebhookRecovery(
    {},
    ACTOR,
    w2.recoveryDeps({
      audit: async () => {
        throw new Error("audit down");
      },
    }),
  );
  assert.equal(after.recovered, 1, "a failing audit write does not change the recovery result");
  assert.equal(result.recovered, 1);
}

/** MOCK — ops log lines carry no payload and distinguish recovery outcomes. */
async function testOpsLogDistinguishesOutcomes() {
  const w = newWorld({ leaseSeconds: 300, maxAttempts: 3 });
  w.store.seed({ stripeEventId: "evt_ex", attemptCount: 3 });
  w.store.seed({ stripeEventId: "evt_ok", lastAttemptAtMs: w.clock.nowMs - 3_500_000 });
  await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.ok(w.logs.includes("webhook.recovery_run_started"));
  assert.ok(w.logs.includes("webhook.recovery_run_completed"));
  assert.ok(w.logs.includes("webhook.recovery_candidate_dead_lettered"));
}

/** PURE — event reconstruction: row id/type win; corrupt payloads yield no data object. */
function testBuildEventFromCandidate() {
  const event = buildEventFromCandidate({
    stripeEventId: "evt_row",
    eventType: "refund.updated",
    status: "RETRYABLE_FAILED",
    attemptCount: 1,
    payload: { id: "evt_other", type: "other", data: { object: { id: "re_1" } }, livemode: false },
  });
  assert.equal(event.id, "evt_row");
  assert.equal(event.type, "refund.updated");
  assert.deepEqual(event.data, { object: { id: "re_1" } });

  for (const bad of [null, "str", 42, [1, 2]]) {
    const e = buildEventFromCandidate({
      stripeEventId: "evt_bad",
      eventType: "refund.updated",
      status: "RETRYABLE_FAILED",
      attemptCount: 1,
      payload: bad,
    });
    assert.equal(e.id, "evt_bad");
    assert.equal(e.data, undefined);
  }
}

// ─── FAKE-client query tests ───────────────────────────────────────────────────

async function fakeClientTests() {
  const { createWebhookRecoveryCandidateLister, createWebhookRecoveryReporter } = await import(
    "../src/lib/stripe/webhook-recovery-store"
  );
  const captured: string[] = [];
  const queue: unknown[][] = [];
  const client = {
    $queryRaw: async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      captured.push(strings.join("?"));
      return queue.shift() ?? [];
    },
    // Any attempt to write through this client is a test failure.
    $executeRaw: () => {
      throw new Error("diagnostics/recovery selection must not write");
    },
  } as unknown as Parameters<typeof createWebhookRecoveryReporter>[0];

  // Candidate lister
  queue.push([
    {
      stripeEventId: "evt_1",
      eventType: "refund.updated",
      status: "PROCESSING",
      attemptCount: BigInt(2),
      payload: { id: "evt_1" },
    },
  ]);
  const candidates = await createWebhookRecoveryCandidateLister(client)({
    limit: 5,
    minRetryAgeSeconds: 300,
    claimProtocolCutoverIso: null,
  });
  assert.equal(candidates[0]?.status, "PROCESSING");
  assert.equal(candidates[0]?.attemptCount, 2);

  // Reporter: counts then samples; BigInt counts normalised, payload never surfaced.
  queue.push([
    {
      activeClaims: BigInt(1),
      expiredClaims: BigInt(2),
      retryableFailed: BigInt(3),
      retryableFailedEligibleNow: BigInt(2),
      nearRetryLimit: BigInt(1),
      atRetryLimit: BigInt(1),
      legacyRetryable: BigInt(4),
      legacyUnclaimed: BigInt(8),
      receivedClaimEraEligible: BigInt(9),
      excludedEventTypePending: BigInt(10),
      deadLetterRetryLimit: BigInt(6),
      deadLetterPermanent: BigInt(7),
    },
  ]);
  queue.push([
    {
      stripeEventId: "evt_dead",
      eventType: "checkout.session.completed",
      status: "DEAD_LETTER",
      category: "DEAD_LETTER_PERMANENT",
      attemptCount: 1,
      claimGeneration: 1,
      lastErrorCode: "BOOKING_CANCELLED_PAYMENT_RECEIVED",
      deadLetterReason: "BOOKING_CANCELLED_PAYMENT_RECEIVED",
      createdAt: new Date("2026-10-01T00:00:00Z"),
      lastAttemptAt: new Date("2026-10-01T00:01:00Z"),
      claimExpiresAt: null,
      payload: { secret: "must-not-leak" },
    },
  ]);
  const report = await createWebhookRecoveryReporter(client)({
    maxAttempts: 8,
    minRetryAgeSeconds: 300,
    sampleLimit: 10,
    claimProtocolCutover: { status: "unset", value: null },
  });
  assert.equal(report.counts.deadLetterPermanent, 7);
  assert.equal(report.counts.legacyRetryable, 4);
  assert.equal(report.counts.legacyUnclaimed, 8, "legacy/unclaimed distinguishable from eligible");
  assert.equal(report.counts.receivedClaimEraEligible, 9);
  assert.equal(report.counts.excludedEventTypePending, 10, "excluded types have their own count");
  assert.deepEqual(report.claimProtocolCutover, { status: "unset", value: null });
  assert.equal(report.samples[0]?.category, "DEAD_LETTER_PERMANENT");
  assert.equal(report.samples[0]?.createdAt, "2026-10-01T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(report), /must-not-leak|payload/);

  // Every statement issued was a SELECT with no mutating keyword (FAKE: read-only check).
  assert.equal(captured.length, 3);
  for (const sql of captured) {
    const stripped = sql.replace(/--.*$/gm, "").trim();
    assert.match(stripped, /^SELECT\b/i);
    assert.doesNotMatch(stripped, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    assert.doesNotMatch(stripped, /FOR\s+UPDATE/i);
  }
}

// ─── STATIC tests ──────────────────────────────────────────────────────────────

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** STATIC — recovery candidate/report SQL is SELECT-only and uses the DB clock. */
function testRecoveryStoreIsReadOnly() {
  const store = stripComments(read("src/lib/stripe/webhook-recovery-store.ts"));
  assert.doesNotMatch(store, /\$executeRaw|\$transaction|\$queryRawUnsafe|\.create\(|\.update\(|\.delete\(/);
  const sqlBlocks = [...store.matchAll(/\$queryRaw<[^>]*>`([\s\S]*?)`/g)].map((m) => m[1]);
  assert.ok(sqlBlocks.length >= 3);
  for (const sql of sqlBlocks) {
    assert.match(sql.trim(), /^SELECT\b/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/);
    assert.doesNotMatch(sql, /FOR\s+UPDATE/);
  }
  assert.match(store, /NOW\(\) AT TIME ZONE 'UTC'/);
}

/** STATIC — candidate predicates match the contract (the MODEL above mirrors these). */
function testCandidateSqlPredicates() {
  const store = read("src/lib/stripe/webhook-recovery-store.ts");
  const candidateSql = store.match(/export function createWebhookRecoveryCandidateLister[\s\S]*?LIMIT \$\{input\.limit\}::int/);
  assert.ok(candidateSql);
  const sql = candidateSql![0];
  assert.match(sql, /"processed" = false/);
  assert.match(sql, /"claimGeneration" >= 1/);
  assert.match(sql, /'PROCESSING'::"WebhookEventStatus"[\s\S]*"claimExpiresAt" <= \(NOW\(\) AT TIME ZONE 'UTC'\)/);
  assert.match(sql, /'RETRYABLE_FAILED'::"WebhookEventStatus"[\s\S]*"lastAttemptAt"/);
  assert.doesNotMatch(sql, /'DEAD_LETTER'|'PROCESSED'::/, "terminal states never selected");
  // RECEIVED is only selectable when claimGeneration = 0 AND a valid cutover proves claim era.
  const receivedBranch = sql.match(/OR \(\s*\$\{claimProtocolCutoverIso\}::text IS NOT NULL[\s\S]*?\)\s*\)\s*\/\* recovery-eligibility:end/);
  assert.ok(receivedBranch, "RECEIVED branch is guarded by the cutover");
  assert.match(receivedBranch![0], /"claimGeneration" = 0/);
  assert.match(receivedBranch![0], /"createdAt" >= \(\(\$\{claimProtocolCutoverIso\}::text\)::timestamptz AT TIME ZONE 'UTC'\)/);
  assert.equal((sql.match(/'RECEIVED'::"WebhookEventStatus"/g) ?? []).length, 1, "RECEIVED appears only in the cutover branch");
  assert.match(sql, /LIMIT \$\{input\.limit\}::int/, "bounded and cast (F6)");
}

/** STATIC — F6: every bound LIMIT parameter is explicitly cast, in recovery SQL. */
function testLimitParametersAreCast() {
  const store = read("src/lib/stripe/webhook-recovery-store.ts");
  const limits = [...store.matchAll(/LIMIT\s+\$\{[^}]+\}(::\w+)?/g)];
  assert.equal(limits.length, 2, "candidate + report sample LIMIT clauses");
  for (const m of limits) assert.equal(m[1], "::int", `uncast LIMIT parameter: ${m[0]}`);
  assert.doesNotMatch(store, /LIMIT\s+\d/, "parameters stay bound, never inlined");
}

function eligibilityBlock(text: string): string {
  const m = text.match(/\/\* recovery-eligibility:start \*\/([\s\S]*?)\/\* recovery-eligibility:end \*\//);
  assert.ok(m, "recovery-eligibility markers present");
  return m![1]!.replace(/\s+/g, " ").trim();
}

/** STATIC — the advisory list and the atomic claim use the identical eligibility predicate. */
function testListerAndClaimShareEligibilityPredicate() {
  const listerPredicate = eligibilityBlock(read("src/lib/stripe/webhook-recovery-store.ts").split("export function createWebhookRecoveryReporter")[0]!);
  const claimPredicate = eligibilityBlock(read("src/lib/stripe/webhook-event-store.ts"));
  assert.equal(listerPredicate, claimPredicate, "predicate text drifted between lister and claim");
  // When the exclusion list is non-empty, report SQL must embed the same literals.
  const report = read("src/lib/stripe/webhook-recovery-store.ts");
  for (const t of RECOVERY_EXCLUDED_EVENT_TYPES) {
    assert.ok(report.includes(`'${t}'`), `${t} present in recovery SQL`);
  }
}

/** STATIC — F1: exclusion list and SQL stay in sync (empty list => no type IN-lists / FALSE isExcluded). */
function testExcludedTypeLiteralsInSync() {
  const expected = [...RECOVERY_EXCLUDED_EVENT_TYPES].sort();
  assert.deepEqual(expected, [], "Step 13: PI failed/canceled no longer excluded from recovery");
  for (const rel of ["src/lib/stripe/webhook-recovery-store.ts", "src/lib/stripe/webhook-event-store.ts"]) {
    const text = read(rel);
    const lists = [...text.matchAll(/IN \(('[a-z_.]+'(?:, '[a-z_.]+')*)\)/g)]
      .map((m) => m[1]!.split(", ").map((s) => s.replace(/'/g, "")).sort())
      .filter((l) => l.some((t) => t.startsWith("payment_intent.")));
    assert.equal(lists.length, 0, `${rel}: no payment_intent exclusion IN-lists when list empty`);
  }
  const report = stripComments(read("src/lib/stripe/webhook-recovery-store.ts"));
  assert.equal((report.match(/FALSE AS "isExcluded"/g) ?? []).length, 2, "counts + sample use FALSE isExcluded");
  assert.doesNotMatch(report, /"payload"->>'type'/, "no exclusion payload.type check while list empty");
}

/** STATIC — live (non-recovery) claim SQL is unchanged by recovery options. */
function testLiveClaimSqlUntouched() {
  const eventStore = read("src/lib/stripe/webhook-event-store.ts");
  const live = eventStore.match(/async tryClaim\([\s\S]*?const row = rows\[0\];/);
  assert.ok(live);
  const liveSql = live![0];
  assert.match(liveSql, /if \(recovery\) \{\s*return claimForRecovery/);
  const afterRecoveryBranch = liveSql.split("return claimForRecovery(client, { stripeEventId, claimToken, leaseSeconds, recovery });")[1]!;
  assert.doesNotMatch(afterRecoveryBranch, /recovery|payment_intent|minRetryAge|cutover/i, "live claim statement has no recovery conditions");
  assert.match(afterRecoveryBranch, /"claimExpiresAt" IS NULL OR "claimExpiresAt" <= \(NOW\(\) AT TIME ZONE 'UTC'\)/);
  // Live deliveries never pass the recovery option.
  const live2 = stripComments(read("src/lib/stripe/webhook-service.ts"));
  const liveFn = live2.match(/export async function processWebhookEvent\(event[\s\S]*?\n\}/);
  assert.ok(liveFn);
  assert.doesNotMatch(liveFn![0], /recovery/i);
  const route = stripComments(read("src/app/api/stripe/webhook/route.ts"));
  assert.doesNotMatch(route, /ForRecovery|recovery/i);
}

/** STATIC — recovery claim keeps fencing columns, DB clock, increments, and never touches terminal rows. */
function testRecoveryClaimKeepsClaimInvariants() {
  const eventStore = read("src/lib/stripe/webhook-event-store.ts");
  const fn = eventStore.match(/async function claimForRecovery[\s\S]*?\n\}\n/);
  assert.ok(fn);
  const sql = fn![0];
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /"processed" = false/);
  assert.match(sql, /"claimGeneration" = w\."claimGeneration" \+ 1/);
  assert.match(sql, /"attemptCount"\s+= w\."attemptCount" \+ 1/);
  assert.match(sql, /"claimExpiresAt"\s+= \(NOW\(\) AT TIME ZONE 'UTC'\) \+ make_interval/);
  assert.doesNotMatch(sql, /'DEAD_LETTER'|'PROCESSED'::/);
  assert.match(sql, /\$\{minRetryAgeSeconds\}::double precision/);
}

/** STATIC — recovery reuses the production orchestrator and has no financial/Stripe code of its own. */
function testRecoveryReusesOrchestratorAndTouchesNoFinancialCode() {
  const service = read("src/lib/stripe/webhook-recovery-service.ts");
  assert.match(
    service,
    /processWebhookEventForRecovery\(/,
    "wired to the production orchestrator entry point (recovery-narrowed claim)",
  );
  const webhookService = read("src/lib/stripe/webhook-service.ts");
  assert.match(
    webhookService,
    /processWebhookEventWithDeps\(event, buildProductionWebhookDeps\(\), recovery\)/,
    "recovery entry point is the same orchestrator, not a second implementation",
  );
  const pure = stripComments(read("src/lib/stripe/webhook-recovery.ts"));
  const storeText = stripComments(read("src/lib/stripe/webhook-recovery-store.ts"));
  for (const text of [pure, storeText, stripComments(service)]) {
    // Case-sensitive on purpose: the service legitimately mentions the `Stripe.Event` TYPE.
    assert.doesNotMatch(text, /refund-service|createRefund|stripePayment|stripe-client|\bstripe\./);
    assert.doesNotMatch(text, /tryClaim|markProcessed|releaseForRetry|markDeadLetter|ensureRecord/);
    assert.doesNotMatch(text, /status\s*[:=]\s*["']RECEIVED["']/, "never resets to RECEIVED");
  }
  const route = read("src/app/api/admin/webhooks/recovery/route.ts");
  assert.match(route, /requireAdminApiRole\(\["ADMIN"\]\)/);
  assert.doesNotMatch(route, /STAFF/);
}

/** STATIC — in_flight/dead-letter decisions only use fenced updates; no unfenced WebhookEvent writes. */
function testNoUnfencedWebhookEventWrites() {
  const files = [
    "src/lib/stripe/webhook-recovery.ts",
    "src/lib/stripe/webhook-recovery-service.ts",
    "src/app/api/admin/webhooks/recovery/handle-admin-webhook-recovery.ts",
    "src/app/api/admin/webhooks/recovery/route.ts",
  ];
  for (const rel of files) {
    const text = stripComments(read(rel));
    assert.doesNotMatch(text, /webhookEvent\.(update|updateMany|upsert|create|delete)/);
    assert.doesNotMatch(text, /UPDATE\s+"WebhookEvent"/);
  }
  const eventStore = read("src/lib/stripe/webhook-event-store.ts");
  // Dead-letter update stays fenced and now keeps evidence it was not given.
  const dead = eventStore.match(/async markDeadLetter[\s\S]*?return affected === 1;/);
  assert.ok(dead);
  assert.match(dead![0], /"claimToken" = \$\{claim\.claimToken\}/);
  assert.match(dead![0], /"claimGeneration" = \$\{claim\.claimGeneration\}/);
  assert.match(dead![0], /COALESCE\(\$\{message\}::text, "error"\)/);
  assert.match(dead![0], /COALESCE\(\$\{lastErrorCode\}::text, "lastErrorCode"\)/);
  assert.match(dead![0], /"deadLetterReason" = \$\{record\.reason\}/);
}

/** STATIC — the new migration is additive; earlier migrations are referenced, not edited. */
function testStage321MigrationAdditive() {
  const dir = "prisma/migrations/20261023140000_webhook_recovery_dead_letter_columns";
  const sql = read(`${dir}/migration.sql`);
  const code = sql.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b|ALTER COLUMN|RENAME/i);
  assert.match(code, /ADD COLUMN "deadLetterReason" TEXT/);
  assert.match(code, /ADD COLUMN "deadLetteredAt"\s+TIMESTAMP\(3\)/);
  assert.match(code, /CREATE INDEX "WebhookEvent_status_lastAttemptAt_idx"/);
  // Backfill is limited to rows already DEAD_LETTER and only writes the new columns.
  const updates = [...code.matchAll(/UPDATE "WebhookEvent"[\s\S]*?;/g)].map((m) => m[0]);
  assert.equal(updates.length, 1);
  assert.match(updates[0]!, /WHERE "status" = 'DEAD_LETTER'/);
  assert.doesNotMatch(updates[0]!.split("WHERE")[0]!, /"status"\s*=|"processed"\s*=|"payload"\s*=|"error"\s*=/);

  const prior = fs.readdirSync(path.join(root, "prisma/migrations")).sort();
  const idx = prior.indexOf("20261023140000_webhook_recovery_dead_letter_columns");
  assert.ok(idx > prior.indexOf("20261023130000_webhook_event_claim_leases"), "ordered after Stage 3.19");

  const schema = read("prisma/schema.prisma");
  const model = schema.match(/model WebhookEvent \{[\s\S]*?\n\}/)![0];
  assert.match(model, /deadLetterReason\s+String\?/);
  assert.match(model, /deadLetteredAt\s+DateTime\?/);
  assert.match(model, /@@index\(\[status, lastAttemptAt\]\)/);
}

/** STATIC — operator docs: legacy diagnostics are SELECT-only and recovery limits are documented. */
function testDocsDiagnosticsAreReadOnly() {
  const doc = read("docs/stripe-webhook-reliability.md");
  const section = doc.split(/^## Read-only diagnostics/m)[1];
  assert.ok(section, "docs contain a 'Read-only diagnostics' section");
  const body = section!.split(/^## /m)[0]!;
  const blocks = [...body.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
  assert.ok(blocks.length >= 4, "legacy / aged / expired / dead-letter queries documented");
  for (const sql of blocks) {
    const stripped = sql.replace(/--.*$/gm, "").trim();
    assert.match(stripped, /^SELECT\b/i);
    assert.doesNotMatch(stripped, /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i);
    assert.doesNotMatch(stripped, /"payload"/, "diagnostics must not select payloads");
  }
  assert.match(doc, /in_flight[\s\S]{0,200}503/);
  assert.match(doc, /CRON_SECRET/);
  assert.match(doc, /api\/cron\/stripe-webhook-recovery/);
}

/** STATIC — a corrupt stored payload becomes a documented permanent classification. */
function testCorruptPayloadClassification() {
  const service = read("src/lib/stripe/webhook-service.ts");
  assert.match(service, /EVENT_PAYLOAD_INVALID/);
  assert.match(service, /SUPPORTED_EVENT_TYPES\.has\(event\.type\)/);
  const errors = read("src/lib/stripe/webhook-errors.ts");
  assert.match(errors, /"EVENT_PAYLOAD_INVALID"/);
}

// ─── Stage 3.23 / Step 13 tests ────────────────────────────────────────────────

const PI_FAILED = "payment_intent.payment_failed";
const PI_CANCELED = "payment_intent.canceled";

/**
 * MOCK — Step 13: PI failed/canceled are eligible for automatic recovery through the
 * same processEvent path, preserving original event id/type and PaymentIntent object.
 * Does not prove PostgreSQL concurrency or live Stripe handler side effects.
 */
async function testPiTerminalEventsEligibleForRecovery() {
  const w = newWorld();
  const seen: Array<{ id: string; type: string; pi: unknown }> = [];
  for (const [id, type, pi] of [
    ["evt_pf", PI_FAILED, "pi_fail_1"],
    ["evt_pc", PI_CANCELED, "pi_cancel_1"],
  ] as const) {
    w.store.seed({
      stripeEventId: id,
      eventType: type,
      payload: { id: "evt_other", type: "other.type", data: { object: { id: pi, metadata: { bookingId: "b1" } } } },
    });
  }
  // Expired PROCESSING lease of a PI-failed event is also recoverable.
  w.store.seed({
    stripeEventId: "evt_pf_expired",
    eventType: PI_FAILED,
    status: "PROCESSING",
    claimToken: "dead_owner",
    claimExpiresAtMs: w.clock.nowMs - 1,
    claimGeneration: 2,
    attemptCount: 2,
    payload: { data: { object: { id: "pi_expired" } } },
  });

  const result = await runWebhookRecovery(
    {},
    ACTOR,
    w.recoveryDeps({
      processEvent: async (event, recovery) => {
        assert.ok(recovery, "recovery path passes claim options");
        const object = (event as { data?: { object?: { id?: unknown } } }).data?.object;
        seen.push({ id: event.id, type: event.type, pi: object?.id });
        return processWebhookEventWithDeps(event, w.orchestratorDeps, recovery);
      },
    }),
  );

  assert.equal(result.excludedEventType, 0);
  assert.equal(result.recovered, 3);
  assert.deepEqual(
    seen.map((s) => s.id).sort(),
    ["evt_pc", "evt_pf", "evt_pf_expired"],
  );
  assert.deepEqual(
    seen.find((s) => s.id === "evt_pf"),
    { id: "evt_pf", type: PI_FAILED, pi: "pi_fail_1" },
    "row id/type win; PI object preserved from payload",
  );
  assert.deepEqual(
    seen.find((s) => s.id === "evt_pc"),
    { id: "evt_pc", type: PI_CANCELED, pi: "pi_cancel_1" },
  );
  for (const id of ["evt_pf", "evt_pc", "evt_pf_expired"]) {
    assert.equal(w.store.get(id).status, "PROCESSED");
    assert.ok(w.store.claimCalls.some((c) => c.stripeEventId === id && c.recovery === true));
  }
}

/**
 * MOCK — Step 13: a retryable handler failure (e.g. missing/unlinked PI) stays within the
 * existing attempt budget and is not counted as recovered. Fake handler only — does not
 * run the real unpaid-terminal policy.
 */
async function testPiTerminalMissingRowStaysRetryableWithinBudget() {
  const w = newWorld({ maxAttempts: 3 });
  const row = w.store.seed({
    stripeEventId: "evt_pf_missing",
    eventType: PI_FAILED,
    attemptCount: 1,
    payload: { data: { object: { id: "pi_missing" } } },
  });
  const result = await runWebhookRecovery(
    {},
    ACTOR,
    w.recoveryDeps({
      processEvent: async (event, recovery) => {
        assert.equal(event.id, "evt_pf_missing");
        assert.equal(event.type, PI_FAILED);
        assert.ok(recovery);
        return processWebhookEventWithDeps(
          event,
          {
            ...w.orchestratorDeps,
            dispatch: async () => {
              throw new Error("UNPAID_TERMINAL_PAYMENT_NOT_FOUND: simulated missing payment");
            },
          },
          recovery,
        );
      },
    }),
  );
  assert.equal(result.recovered, 0);
  assert.equal(result.stillRetryable, 1);
  assert.equal(row.status, "RETRYABLE_FAILED");
  assert.equal(row.processed, false);
  assert.ok(row.attemptCount < 3, "still inside attempt budget");
  assert.notEqual(row.status, "DEAD_LETTER");
}

/** MOCK — duplicate recovery of an already-processed PI terminal event does not re-dispatch. */
async function testDuplicatePiTerminalRecoveryIsIdempotent() {
  const w = newWorld();
  w.store.seed({
    stripeEventId: "evt_pf_once",
    eventType: PI_FAILED,
    payload: { data: { object: { id: "pi_once" } } },
  });
  const first = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(first.recovered, 1);
  assert.equal(w.handler.calls.filter((id) => id === "evt_pf_once").length, 1);
  const second = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(second.scanned, 0, "PROCESSED rows are not re-selected");
  assert.equal(second.recovered, 0);
  assert.equal(w.handler.calls.filter((id) => id === "evt_pf_once").length, 1, "handler not called twice");
}

/** MOCK — live delivery of PI terminal types still uses the live claim (no recovery option). */
async function testLiveDeliveryOfPiTerminalTypesUnaffected() {
  const w = newWorld();
  for (const type of [PI_FAILED, PI_CANCELED]) {
    const id = `evt_live_${type}`;
    const event: RecoveryEvent = { id, type, data: { object: { id: "pi_1" } } };
    const result = await processWebhookEventWithDeps(event, w.orchestratorDeps);
    assert.equal(result.outcome, "processed");
    assert.ok(w.handler.calls.includes(id));
    assert.equal(w.store.get(id).status, "PROCESSED");
  }
  w.store.seed({ stripeEventId: "evt_live_retry", eventType: PI_FAILED, payload: { type: PI_FAILED } });
  const retry = await processWebhookEventWithDeps(
    { id: "evt_live_retry", type: PI_FAILED, data: { object: {} } },
    w.orchestratorDeps,
  );
  assert.equal(retry.outcome, "processed");
  assert.ok(w.store.claimCalls.every((c) => c.recovery === false), "live path never passes recovery options");
}

/** PURE — F1: empty exclusion list; helpers reject only members of the constant. */
function testExclusionHelper() {
  assert.equal(RECOVERY_EXCLUDED_EVENT_TYPES.length, 0);
  assert.equal(isRecoveryExcludedEventType(PI_FAILED), false);
  assert.equal(isRecoveryExcludedEventType(PI_CANCELED), false);
  for (const v of ["payment_intent.succeeded", "", null, undefined, 42, {}, [PI_FAILED]]) {
    assert.equal(isRecoveryExcludedEventType(v), false);
  }
  for (const payload of [null, undefined, "str", 7, [1], [{ type: PI_FAILED }], {}, { type: 5 }, { type: PI_CANCELED }]) {
    assert.equal(isRecoveryExcludedCandidate({ eventType: "refund.updated", payload }), false);
  }
  assert.equal(isRecoveryExcludedCandidate({ eventType: PI_FAILED, payload: null }), false);
}

/**
 * STATIC — recovery redispatches through the hardened Step 11 PI terminal path; no
 * bookingId-only bypass. Policy tests cover stale/paid/missing behavior separately.
 */
function testRecoveryReusesHardenedPiTerminalHandler() {
  const recoveryService = read("src/lib/stripe/webhook-recovery-service.ts");
  assert.match(recoveryService, /processWebhookEventForRecovery/);
  const webhookService = read("src/lib/stripe/webhook-service.ts");
  assert.match(
    webhookService,
    /processWebhookEventForRecovery[\s\S]*processWebhookEventWithDeps\(event, buildProductionWebhookDeps\(\), recovery\)/,
  );
  assert.match(webhookService, /case "payment_intent\.payment_failed":[\s\S]*handlePaymentIntentFailed/);
  assert.match(webhookService, /case "payment_intent\.canceled":[\s\S]*handlePaymentIntentCancelled/);
  assert.match(
    webhookService,
    /handlePaymentIntentFailed[\s\S]*applyUnpaidTerminalPaymentIntentEvent\(intent, "FAILED"\)/,
  );
  assert.match(
    webhookService,
    /handlePaymentIntentCancelled[\s\S]*applyUnpaidTerminalPaymentIntentEvent\(intent, "CANCELLED"\)/,
  );
  const applyFn = webhookService.match(
    /async function applyUnpaidTerminalPaymentIntentEvent[\s\S]*?\nasync function handlePaymentIntentFailed/,
  );
  assert.ok(applyFn, "shared PI terminal apply helper present");
  const body = applyFn![0];
  assert.match(body, /decideUnpaidTerminalPaymentIntentEffect/, "uses Step 11 decision");
  assert.match(body, /stripePaymentIntentId:\s*intent\.id/, "conditions writes on matching PI");
  assert.match(body, /shouldReleaseBookingAfterUnpaidTerminalWrite/, "release gated on write count");
  assert.doesNotMatch(
    body,
    /booking\.updateMany\(\s*\{\s*where:\s*\{\s*id:\s*bookingId\s*\}\s*,\s*data:\s*\{\s*status:\s*["']AVAILABLE/,
    "must not release booking by id alone without PI-scoped payment write",
  );
  const policy = read("src/lib/stripe/unpaid-terminal-payment-intent-policy.ts");
  assert.match(policy, /stale_attempt/);
  assert.match(policy, /protected_status/);
  assert.match(policy, /payment_not_found/);
  assert.match(policy, /payment_intent_not_linked/);
  assert.match(policy, /isPaidLineageStripePaymentStatus/);
}

/** MOCK — F3: a candidate that became ineligible after selection consumes NO attempt and is a skip, not a failure. */
async function testClaimTimeBackoffIsAtomic() {
  const w = newWorld();
  const row = w.store.seed({ stripeEventId: "evt_race", attemptCount: 2, claimGeneration: 2 });
  const result = await runWebhookRecovery(
    {},
    ACTOR,
    w.recoveryDeps({
      listCandidates: async (input) => {
        const listed = await modelListCandidates(w.store, w.clock)(input);
        assert.equal(listed.length, 1, "selected as eligible");
        // Another actor (live Stripe retry / other recovery) attempted it after selection.
        row.lastAttemptAtMs = w.clock.nowMs - 5_000;
        return listed;
      },
    }),
  );
  assert.equal(result.skippedNotEligible, 1);
  assert.equal(result.attempted, 1, "it was handed to the orchestrator...");
  assert.equal(result.recovered, 0);
  assert.equal(result.stillRetryable, 0, "...but a skip is not a processing failure");
  assert.equal(result.errors, 0);
  assert.equal(result.skippedInFlight, 0, "and not an in_flight skip either");
  assert.equal(result.events[0]?.outcome, "skipped_not_eligible");
  assert.equal(w.handler.calls.length, 0, "no handler run");
  assert.equal(row.attemptCount, 2, "attempt counter NOT consumed");
  assert.equal(row.claimGeneration, 2, "generation NOT advanced");
  assert.equal(row.status, "RETRYABLE_FAILED");
  assert.equal(row.claimToken, null);
  assert.ok(w.logs.includes("webhook.recovery_candidate_not_eligible"));
  assert.ok(
    w.processingLogs.includes("webhook.recovery_claim_not_eligible"),
    "orchestrator (processing-layer) logs the claim-time skip",
  );
}

/** MOCK — F3: the SAME freshly-attempted row IS claimable by a live delivery (backoff is recovery-only). */
async function testBackoffNotImposedOnLiveDeliveries() {
  const w = newWorld();
  const row = w.store.seed({
    stripeEventId: "evt_fresh_live",
    lastAttemptAtMs: w.clock.nowMs - 1_000,
  });
  const result = await processWebhookEventWithDeps(
    { id: "evt_fresh_live", type: "payment_intent.succeeded", data: { object: { id: "pi" } } },
    w.orchestratorDeps,
  );
  assert.equal(result.outcome, "processed");
  assert.equal(row.status, "PROCESSED");
  assert.equal(row.claimGeneration, 2);
}

/** MOCK — F3: a lease renewed after selection is still in_flight (checked before eligibility), not a failure. */
async function testRenewedLeaseAfterSelectionIsInFlight() {
  const w = newWorld();
  const row = w.store.seed({
    stripeEventId: "evt_renewed",
    status: "PROCESSING",
    claimToken: "owner",
    claimExpiresAtMs: w.clock.nowMs - 1,
    claimGeneration: 2,
    attemptCount: 2,
  });
  const result = await runWebhookRecovery(
    {},
    ACTOR,
    w.recoveryDeps({
      listCandidates: async (input) => {
        const listed = await modelListCandidates(w.store, w.clock)(input);
        row.claimExpiresAtMs = w.clock.nowMs + 60_000;
        return listed;
      },
    }),
  );
  assert.equal(result.skippedInFlight, 1);
  assert.equal(result.skippedNotEligible, 0);
  assert.equal(row.claimToken, "owner");
  assert.equal(row.attemptCount, 2);
}

/** MOCK — F3: recovery claim still increments attempts/generation and honours the retry cap. */
async function testRecoveryClaimKeepsAttemptAndCapSemantics() {
  const w = newWorld({ leaseSeconds: 300, maxAttempts: 3 });
  const row = w.store.seed({ stripeEventId: "evt_cap2", attemptCount: 1, claimGeneration: 1 });
  const r1 = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(r1.recovered, 1);
  assert.equal(row.attemptCount, 2);
  assert.equal(row.claimGeneration, 2);

  const capped = w.store.seed({ stripeEventId: "evt_cap3", attemptCount: 3, claimGeneration: 3 });
  const r2 = await runWebhookRecovery({}, ACTOR, w.recoveryDeps());
  assert.equal(r2.deadLettered, 1, "cap still dead-letters via the claim path");
  assert.equal(capped.deadLetterReason, "RETRY_LIMIT_EXCEEDED");
  assert.equal(w.handler.calls.length, 1, "handler never ran for the capped event");
}

/** MOCK — F4: claimGeneration = 0 rows fail closed without a valid cutover; nothing is reclassified or mutated. */
async function testLegacyGenerationZeroFailsClosed() {
  const w = newWorld();
  const legacyRetry = w.store.seed({
    stripeEventId: "evt_legacy_retry",
    status: "RETRYABLE_FAILED",
    claimGeneration: 0,
    attemptCount: 0,
  });
  const legacyProcessing = w.store.seed({
    stripeEventId: "evt_legacy_proc",
    status: "PROCESSING",
    claimGeneration: 0,
    attemptCount: 0,
    claimExpiresAtMs: null,
  });
  const staleReceived = w.store.seed({
    stripeEventId: "evt_legacy_recv",
    status: "RECEIVED",
    claimGeneration: 0,
    attemptCount: 0,
    createdAtMs: w.clock.nowMs - 7_200_000,
  });
  const snapshot = [legacyRetry, legacyProcessing, staleReceived].map((r) => JSON.stringify(r));

  // Cutover unset (null): nothing at all is eligible.
  const none = await runWebhookRecovery({}, ACTOR, w.recoveryDeps({ claimProtocolCutoverIso: null }));
  assert.equal(none.scanned, 0);
  assert.equal(w.handler.calls.length, 0);

  // Forced through the claim (bypassing the lister): the atomic predicate refuses every one.
  const forced = await runWebhookRecovery(
    {},
    ACTOR,
    w.recoveryDeps({
      claimProtocolCutoverIso: null,
      listCandidates: async () =>
        [legacyRetry, legacyProcessing, staleReceived].map((r) => ({
          stripeEventId: r.stripeEventId,
          eventType: r.eventType,
          status: r.status as "PROCESSING" | "RETRYABLE_FAILED" | "RECEIVED",
          attemptCount: r.attemptCount,
          payload: r.payload,
        })),
    }),
  );
  assert.equal(forced.skippedNotEligible, 3);
  assert.equal(forced.recovered + forced.errors + forced.stillRetryable, 0);
  assert.deepEqual([legacyRetry, legacyProcessing, staleReceived].map((r) => JSON.stringify(r)), snapshot, "no silent reclassification/backfill");
}

/** MOCK — F4: with an explicit valid cutover only post-cutover never-claimed RECEIVED rows become eligible. */
async function testCutoverMakesOnlyClaimEraReceivedEligible() {
  const w = newWorld();
  const cutoverIso = new Date(w.clock.nowMs - 5_000_000).toISOString();
  const preCutover = w.store.seed({
    stripeEventId: "evt_pre",
    status: "RECEIVED",
    claimGeneration: 0,
    attemptCount: 0,
    createdAtMs: w.clock.nowMs - 7_200_000,
  });
  const claimEra = w.store.seed({
    stripeEventId: "evt_era",
    status: "RECEIVED",
    claimGeneration: 0,
    attemptCount: 0,
    createdAtMs: w.clock.nowMs - 4_000_000,
  });
  const tooFresh = w.store.seed({
    stripeEventId: "evt_era_fresh",
    status: "RECEIVED",
    claimGeneration: 0,
    attemptCount: 0,
    createdAtMs: w.clock.nowMs - 10_000,
  });
  // Even after the cutover, a gen-0 RETRYABLE_FAILED / PROCESSING row is anomalous: never recovered.
  const anomaly = w.store.seed({
    stripeEventId: "evt_anomaly",
    status: "RETRYABLE_FAILED",
    claimGeneration: 0,
    attemptCount: 0,
    createdAtMs: w.clock.nowMs - 4_000_000,
  });

  const result = await runWebhookRecovery({}, ACTOR, w.recoveryDeps({ claimProtocolCutoverIso: cutoverIso }));
  assert.deepEqual(w.handler.calls, ["evt_era"]);
  assert.equal(result.recovered, 1);
  assert.equal(claimEra.status, "PROCESSED");
  assert.equal(claimEra.claimGeneration, 1);
  for (const r of [preCutover, tooFresh, anomaly]) {
    assert.equal(r.attemptCount, 0, `${r.stripeEventId} untouched`);
    assert.equal(r.claimGeneration, 0);
  }
}

/** PURE — F4: the cutover marker is parsed strictly; anything ambiguous fails closed. */
function testCutoverParsing() {
  const now = Date.parse("2026-10-23T12:00:00Z");
  assert.deepEqual(resolveClaimProtocolCutover({}, now), { status: "unset", value: null });
  assert.deepEqual(resolveClaimProtocolCutover({ STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT: "  " }, now), { status: "unset", value: null });
  assert.deepEqual(
    resolveClaimProtocolCutover({ STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT: "2026-10-01T09:30:00Z" }, now),
    { status: "valid", value: "2026-10-01T09:30:00.000Z" },
  );
  assert.deepEqual(
    resolveClaimProtocolCutover({ STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT: "2026-10-01T11:30:00+02:00" }, now),
    { status: "valid", value: "2026-10-01T09:30:00.000Z" },
    "offset normalised to UTC",
  );
  for (const bad of [
    "2026-10-01T09:30:00", // no offset: ambiguous
    "2026-10-01", // date only
    "2026-02-31T00:00:00Z", // impossible calendar date
    "2026-13-01T00:00:00Z",
    "2026-10-01T25:00:00Z",
    "2019-12-31T23:59:00Z", // implausibly old
    "2026-10-24T00:00:00Z", // in the future relative to now
    "yesterday",
    "0",
    "1730000000",
  ]) {
    assert.deepEqual(
      resolveClaimProtocolCutover({ STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT: bad }, now),
      { status: "invalid", value: null },
      `must fail closed: ${bad}`,
    );
  }
}

/** PURE — F2: the soft time budget uses seconds-based naming, conservative default, clamped bounds. */
function testBudgetConfig() {
  assert.equal(resolveRecoveryBudgetMs({}), 10_000);
  assert.equal(RECOVERY_DEFAULT_MAX_DURATION_MS, 10_000);
  assert.equal(resolveRecoveryBudgetMs({ STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS: "5" }), 5_000);
  assert.equal(resolveRecoveryBudgetMs({ STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS: "0" }), 1_000, "clamped up to 1 s");
  assert.equal(resolveRecoveryBudgetMs({ STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS: "-3" }), 1_000);
  assert.equal(resolveRecoveryBudgetMs({ STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS: "9999" }), 60_000, "clamped down to 60 s");
  for (const bad of ["", "  ", "abc", "2.5", "NaN", "1e2x"]) {
    assert.equal(resolveRecoveryBudgetMs({ STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS: bad }), 10_000, `default for ${JSON.stringify(bad)}`);
  }
  const cfg = resolveWebhookRecoveryConfig({ STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS: "7" }, Date.now());
  assert.equal(cfg.maxDurationMs, 7_000);
  assert.equal(cfg.claimProtocolCutover.status, "unset");
}

/** MOCK — F2: the budget is soft: checked between events; the running event is never cancelled. */
async function testBudgetIsSoftAndBetweenEvents() {
  const w = newWorld();
  for (let i = 0; i < 3; i += 1) {
    w.store.seed({ stripeEventId: `evt_soft${i}`, lastAttemptAtMs: w.clock.nowMs - 3_600_000 + i });
  }
  let t = 0;
  const result = await runWebhookRecovery(
    { batchSize: 3 },
    ACTOR,
    w.recoveryDeps({
      now: () => t,
      maxDurationMs: 1_000,
      processEvent: async (event, recovery) => {
        const r = await processWebhookEventWithDeps(event, w.orchestratorDeps, recovery);
        t += 5_000; // the event "took" far longer than the whole budget
        return r;
      },
    }),
  );
  assert.equal(result.attempted, 1, "first event ran to completion despite exceeding the budget");
  assert.equal(result.recovered, 1);
  assert.equal(result.stoppedEarly, true);
  assert.equal(result.hasMore, true);
  assert.equal(w.store.get("evt_soft0").status, "PROCESSED");
  assert.equal(w.store.get("evt_soft1").status, "RETRYABLE_FAILED", "later candidates left for the next run");
}

/**
 * STATIC — F2: no route-level maxDuration was invented.
 * vercel.json may be `{}` (crons intentionally disabled until production readiness)
 * or crons-only with `$schema` when schedules are re-enabled.
 */
function testNoGuessedPlatformDuration() {
  for (const rel of [
    "src/app/api/admin/webhooks/recovery/route.ts",
    "src/app/api/cron/stripe-webhook-recovery/route.ts",
    "src/app/api/cron/expired-holds-cleanup/route.ts",
    "src/app/api/stripe/webhook/route.ts",
    "next.config.ts",
  ]) {
    assert.doesNotMatch(read(rel), /export const maxDuration|maxDuration\s*[:=]/, `${rel} must not guess a platform limit`);
  }
  assert.equal(fs.existsSync(path.join(root, "vercel.json")), true, "vercel.json present");
  const vercel = JSON.parse(read("vercel.json")) as Record<string, unknown>;
  const keys = Object.keys(vercel).sort();
  const cronsDisabled = keys.length === 0;
  const cronsOnly = keys.join(",") === "$schema,crons";
  assert.ok(
    cronsDisabled || cronsOnly,
    `vercel.json must be empty (crons disabled) or crons-only with $schema; got keys=${JSON.stringify(keys)}`,
  );
  assert.doesNotMatch(JSON.stringify(vercel), /maxDuration/i);
}

/** STATIC — F4/F1: report categories and SQL expose legacy/unclaimed and excluded rows without payloads/free-text errors. */
function testReportExposesLegacyAndExcludedSafely() {
  const store = read("src/lib/stripe/webhook-recovery-store.ts");
  const reporter = store.split("export function createWebhookRecoveryReporter")[1]!;
  for (const c of ["EXCLUDED_EVENT_TYPE", "LEGACY_UNCLAIMED", "RECEIVED_CLAIM_ERA", "LEGACY_RETRYABLE"]) {
    assert.match(reporter, new RegExp(`'${c}'`), `${c} category in sample SQL`);
  }
  for (const k of ["legacyUnclaimed", "receivedClaimEraEligible", "excludedEventTypePending", "legacyRetryable"]) {
    assert.match(reporter, new RegExp(`AS "${k}"`), `${k} count in report SQL`);
  }
  const code = stripComments(reporter);
  assert.doesNotMatch(code, /"payload"/, "empty exclusion list: payload never selected");
  assert.doesNotMatch(code, /"error"/, "free-text error never selected");
  assert.doesNotMatch(code, /"claimToken"/, "claim tokens never selected");
  assert.match(code, /FALSE AS "isExcluded"/);
  const types = read("src/lib/stripe/webhook-recovery-report-types.ts");
  assert.match(types, /claimProtocolCutover: ClaimProtocolCutover/);
}

/** STATIC — F1/F2/F3/F4/F5/F10: the operator doc states the Stage 3.23 limits and cautions (and claims no rehearsal). */
function testDocsStage323Content() {
  const doc = read("docs/stripe-webhook-reliability.md");
  const must: Array<[RegExp, string]> = [
    [/RECOVERY_EXCLUDED_EVENT_TYPES[\s\S]{0,80}empty/i, "exclusion list currently empty"],
    [/payment_intent\.payment_failed[\s\S]{0,80}payment_intent\.canceled/, "PI terminal types named"],
    [/decideUnpaidTerminalPaymentIntentEffect/, "Step 11 decision named"],
    [/processWebhookEventForRecovery/, "recovery reuses live orchestrator"],
    [/Normal Stripe delivery of these event types is unchanged/, "live delivery unchanged"],
    [/STRIPE_WEBHOOK_RECOVERY_BUDGET_SECONDS/, "budget variable"],
    [/default \*\*10\*\*, \*\*clamped\s+1–60\*\*/, "budget default and bounds"],
    [/\*\*soft\*\*/, "budget is soft"],
    [/between events/i, "checked between events"],
    [/Default batch size 5/, "batch default"],
    [/No route-level `maxDuration`/, "no guessed platform limit"],
    [/vercel\.json/, "Hobby cron config documented"],
    [/CRON_SECRET/, "cron secret documented"],
    [/STRIPE_WEBHOOK_CLAIM_PROTOCOL_CUTOVER_AT/, "cutover variable"],
    [/fail closed/i, "fail closed"],
    [/never[\s\S]{0,30}defaulted or inferred/, "cutover never inferred"],
    [/consumes no attempt/, "claim-time skip consumes no attempt"],
    [/skippedNotEligible/, "distinct skip counter"],
    [/FINALIZE_FAILED[\s\S]{0,200}handler completed/i, "FINALIZE_FAILED semantics"],
    [/mixed-version/i, "mixed-version warning"],
    [/drain\/switch/, "drain/switch plan"],
    [/not been rehearsed/, "rollback not rehearsed"],
    [/not audited in-system/, "manual intervention unaudited"],
    [/single recovery scheduler/i, "single scheduler preferred"],
    [/Claim exclusivity holds only when every instance/, "claim exclusivity caveat"],
  ];
  for (const [re, label] of must) assert.match(doc, re, `doc missing: ${label}`);
  assert.doesNotMatch(doc, /has been rehearsed|were rehearsed|verified against production/i, "no rehearsal/verification claim");
}

async function main() {
  const tests: Array<[string, () => void | Promise<void>]> = [
    ["STATIC docs Stage 3.23 content", testDocsStage323Content],
    ["MOCK Step13 PI terminal events eligible for recovery", testPiTerminalEventsEligibleForRecovery],
    ["MOCK Step13 PI missing/unlinked stays retryable in budget", testPiTerminalMissingRowStaysRetryableWithinBudget],
    ["MOCK Step13 duplicate PI terminal recovery idempotent", testDuplicatePiTerminalRecoveryIsIdempotent],
    ["MOCK Step13 live delivery of PI terminal types unaffected", testLiveDeliveryOfPiTerminalTypesUnaffected],
    ["PURE F1 exclusion helper empty + malformed payloads", testExclusionHelper],
    ["STATIC Step13 recovery reuses hardened PI terminal handler", testRecoveryReusesHardenedPiTerminalHandler],
    ["MOCK F3 claim-time backoff atomic; skip consumes no attempt", testClaimTimeBackoffIsAtomic],
    ["MOCK F3 backoff not imposed on live deliveries", testBackoffNotImposedOnLiveDeliveries],
    ["MOCK F3 renewed lease after selection is in_flight", testRenewedLeaseAfterSelectionIsInFlight],
    ["MOCK F3 recovery claim keeps attempt/cap semantics", testRecoveryClaimKeepsAttemptAndCapSemantics],
    ["MOCK F4 legacy gen-0 fails closed, untouched", testLegacyGenerationZeroFailsClosed],
    ["MOCK F4 cutover makes only claim-era RECEIVED eligible", testCutoverMakesOnlyClaimEraReceivedEligible],
    ["PURE F4 cutover parsing fails closed", testCutoverParsing],
    ["PURE F2 budget config", testBudgetConfig],
    ["MOCK F2 budget is soft and between events", testBudgetIsSoftAndBetweenEvents],
    ["STATIC F2 no guessed platform maxDuration", testNoGuessedPlatformDuration],
    ["STATIC F6 LIMIT parameters cast", testLimitParametersAreCast],
    ["STATIC lister and claim share eligibility predicate", testListerAndClaimShareEligibilityPredicate],
    ["STATIC F1 excluded literals in sync", testExcludedTypeLiteralsInSync],
    ["STATIC live claim SQL untouched", testLiveClaimSqlUntouched],
    ["STATIC recovery claim keeps claim invariants", testRecoveryClaimKeepsClaimInvariants],
    ["STATIC report exposes legacy/excluded safely", testReportExposesLegacyAndExcludedSafely],
    ["MOCK active lease never stolen", testActiveLeaseNeverStolen],
    ["MOCK expired lease reclaimed via claim contract", testExpiredLeaseReclaimedViaClaim],
    ["MOCK stale owner fenced after recovery reclaim", testStaleOwnerFencedAfterRecoveryReclaim],
    ["MOCK retryable eligibility + legacy/unclaimed exclusions", testRetryableEligibilityAndExclusions],
    ["MOCK processed and dead-lettered not replayed", testProcessedAndDeadLetterNotReplayed],
    ["MOCK batch bounded + input clamped", testBatchBounded],
    ["MOCK time budget stops run", testTimeBudgetStopsRun],
    ["MOCK retry exhaustion preserves evidence and stops", testRetryExhaustionPreservesEvidenceAndStops],
    ["MOCK repeated recovery terminates", testRepeatedRecoveryTerminates],
    ["MOCK failed terminal write is not success", testFailedTerminalWriteIsNotSuccess],
    ["MOCK finalize failure not counted as recovered", testFinalizeFailureNotCountedAsRecovered],
    ["MOCK concurrent invocations single owner (contract model)", testConcurrentInvocationsSingleOwner],
    ["MOCK unexpected throw is error not success", testUnexpectedProcessThrowIsErrorNotSuccess],
    ["MOCK lookup failure attempts nothing", testLookupFailureAttemptsNothing],
    ["MOCK audit content + failure isolation", testAuditContentAndFailureIsolation],
    ["MOCK ops log distinguishes outcomes", testOpsLogDistinguishesOutcomes],
    ["PURE build event from candidate", testBuildEventFromCandidate],
    ["FAKE read-only queries (no writes, no payloads)", fakeClientTests],
    ["STATIC recovery store is read-only", testRecoveryStoreIsReadOnly],
    ["STATIC candidate SQL predicates", testCandidateSqlPredicates],
    ["STATIC recovery reuses orchestrator, no financial code", testRecoveryReusesOrchestratorAndTouchesNoFinancialCode],
    ["STATIC no unfenced WebhookEvent writes", testNoUnfencedWebhookEventWrites],
    ["STATIC Stage 3.21 migration additive", testStage321MigrationAdditive],
    ["STATIC docs diagnostics read-only", testDocsDiagnosticsAreReadOnly],
    ["STATIC corrupt payload classification", testCorruptPayloadClassification],
  ];
  for (const [name, fn] of tests) {
    await fn();
    console.log(`ok - ${name}`);
  }
  console.log(`\n${tests.length} recovery tests defined (PostgreSQL concurrency NOT covered).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
