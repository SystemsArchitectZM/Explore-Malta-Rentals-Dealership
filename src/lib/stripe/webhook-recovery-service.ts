/**
 * Production wiring for webhook recovery. Deliberately thin: recovery reuses
 * `processWebhookEvent` (the one production orchestrator: claim -> fenced dispatch ->
 * fenced finalize) and adds no event-processing logic of its own.
 */

import type Stripe from "stripe";

import { writePaymentAuditLog } from "./audit-service";
import { resolveWebhookClaimConfig } from "./webhook-event-claim";
import { logWebhookOpsEvent } from "./webhook-ops-log";
import {
  runWebhookRecovery,
  type WebhookRecoveryResult,
  type WebhookRecoveryRunInput,
} from "./webhook-recovery";
import {
  createWebhookRecoveryCandidateLister,
  createWebhookRecoveryReporter,
} from "./webhook-recovery-store";
import type {
  WebhookRecoveryReport,
  WebhookReportCategory,
} from "./webhook-recovery-report-types";
import { resolveWebhookRecoveryConfig } from "./webhook-recovery-policy";
import { processWebhookEventForRecovery } from "./webhook-service";

export function runProductionWebhookRecovery(
  input: Partial<WebhookRecoveryRunInput>,
  actor: string,
): Promise<WebhookRecoveryResult> {
  // Read once per run so the list and every claim in this pass use one interpretation.
  // Missing/invalid cutover => null => claimGeneration = 0 rows stay excluded (fail closed).
  const config = resolveWebhookRecoveryConfig();
  return runWebhookRecovery(input, actor, {
    listCandidates: createWebhookRecoveryCandidateLister(),
    // The stored payload is the full Stripe event JSON captured at first delivery.
    // Same orchestrator as live delivery; the recovery option only narrows the claim.
    processEvent: (event, recovery) =>
      processWebhookEventForRecovery(event as unknown as Stripe.Event, recovery),
    claimProtocolCutoverIso: config.claimProtocolCutover.value,
    maxDurationMs: config.maxDurationMs,
    audit: (args) =>
      writePaymentAuditLog({
        action: args.action,
        actor: args.actor,
        newValue: args.newValue,
      }),
    log: logWebhookOpsEvent,
    now: () => Date.now(),
  });
}

export function loadProductionWebhookRecoveryReport(input: {
  minRetryAgeSeconds: number;
  sampleLimit: number;
  category?: WebhookReportCategory;
}): Promise<WebhookRecoveryReport> {
  return createWebhookRecoveryReporter()({
    ...input,
    maxAttempts: resolveWebhookClaimConfig().maxAttempts,
    claimProtocolCutover: resolveWebhookRecoveryConfig().claimProtocolCutover,
  });
}
