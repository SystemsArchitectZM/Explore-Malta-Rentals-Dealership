import { NextResponse } from "next/server";

import { CronUnauthorizedError } from "@/lib/cron/assert-cron-authorization";
import {
  WebhookRecoveryLookupError,
  type WebhookRecoveryResult,
  type WebhookRecoveryRunInput,
} from "@/lib/stripe/webhook-recovery";

/** Fixed actor for cron-driven recovery audit / ops logs. Not a session id. */
export const CRON_WEBHOOK_RECOVERY_ACTOR = "cron:webhook-recovery";

export type CronStripeWebhookRecoveryDeps = {
  authorize: (request: Request) => void;
  /** Always called with server-controlled empty input (production defaults). */
  runRecovery: (
    input: Partial<WebhookRecoveryRunInput>,
    actor: string,
  ) => Promise<WebhookRecoveryResult>;
};

/**
 * GET handler body for Vercel Cron. Auth runs before any recovery work.
 * Does not accept client-controlled batch/force/dead-letter options.
 */
export async function handleCronStripeWebhookRecovery(
  request: Request,
  deps: CronStripeWebhookRecoveryDeps,
): Promise<NextResponse> {
  try {
    deps.authorize(request);

    const result = await deps.runRecovery({}, CRON_WEBHOOK_RECOVERY_ACTOR);

    if (result.errors > 0) {
      return NextResponse.json(
        {
          success: false as const,
          code: "RECOVERY_PASS_ERRORS",
          message: "Recovery pass completed with dispatch errors",
          result,
        },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true as const, result });
  } catch (error) {
    if (error instanceof CronUnauthorizedError) {
      return NextResponse.json(
        { success: false as const, code: "UNAUTHORIZED", message: "Unauthorized" },
        { status: 401 },
      );
    }
    if (error instanceof WebhookRecoveryLookupError) {
      return NextResponse.json(
        {
          success: false as const,
          code: error.code,
          message: "Recovery candidates could not be listed",
        },
        { status: 503 },
      );
    }
    console.error("[api/cron/stripe-webhook-recovery] GET error");
    return NextResponse.json(
      { success: false as const, code: "INTERNAL_ERROR", message: "Internal server error" },
      { status: 500 },
    );
  }
}
