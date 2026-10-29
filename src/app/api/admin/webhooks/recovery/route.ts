import { requireAdminApiRole } from "@/lib/admin-auth";
import {
  loadProductionWebhookRecoveryReport,
  runProductionWebhookRecovery,
} from "@/lib/stripe/webhook-recovery-service";

import {
  handleAdminWebhookRecoveryReport,
  handleAdminWebhookRecoveryRun,
} from "./handle-admin-webhook-recovery";

const deps = {
  authorize: () => requireAdminApiRole(["ADMIN"]),
  runRecovery: runProductionWebhookRecovery,
  loadReport: loadProductionWebhookRecoveryReport,
};

/**
 * GET  /api/admin/webhooks/recovery  Read-only diagnostic report. ADMIN only.
 * POST /api/admin/webhooks/recovery  One bounded recovery pass over durable state.
 *                                    ADMIN only. Reuses the production claim/fencing
 *                                    orchestrator; never replays DEAD_LETTER events.
 *
 * Nothing calls this automatically: a separately configured scheduler (or an operator)
 * must invoke it. See docs/stripe-webhook-reliability.md.
 */
export async function GET(request: Request) {
  return handleAdminWebhookRecoveryReport(request, deps);
}

export async function POST(request: Request) {
  return handleAdminWebhookRecoveryRun(request, deps);
}
