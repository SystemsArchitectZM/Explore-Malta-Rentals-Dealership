import { assertCronAuthorization } from "@/lib/cron/assert-cron-authorization";
import { runProductionWebhookRecovery } from "@/lib/stripe/webhook-recovery-service";

import { handleCronStripeWebhookRecovery } from "./handle-cron-stripe-webhook-recovery";

const deps = {
  authorize: (request: Request) => assertCronAuthorization(request),
  runRecovery: runProductionWebhookRecovery,
};

/**
 * GET /api/cron/stripe-webhook-recovery
 *
 * Vercel Cron invokes paths with HTTP GET and (when configured) sends
 * `Authorization: Bearer ${CRON_SECRET}`. One bounded recovery pass using the same
 * production worker as ADMIN recovery (`runProductionWebhookRecovery`), with fixed
 * server defaults — no client-controlled force/batch/dead-letter options.
 *
 * ADMIN session auth is intentionally not used. The ADMIN endpoint at
 * `/api/admin/webhooks/recovery` remains unchanged for operators.
 *
 * No route-level `maxDuration` is set here: Hobby function limits must be confirmed
 * operationally; the recovery soft budget still bounds the pass between events.
 *
 * Schedule (Hobby, UTC, at most once daily): see vercel.json. Presence of that file
 * does not prove the cron is active until production deploy + Vercel dashboard check.
 */
export async function GET(request: Request) {
  return handleCronStripeWebhookRecovery(request, deps);
}
