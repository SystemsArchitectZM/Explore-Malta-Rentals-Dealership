import { NextResponse } from "next/server";
import { z } from "zod";

import { AdminForbiddenError, AdminUnauthorizedError } from "@/lib/admin-auth/errors";
import type { AdminSessionRecord } from "@/lib/admin-auth/types";
import {
  RECOVERY_DEFAULT_MIN_RETRY_AGE_SECONDS,
  RECOVERY_MAX_BATCH_SIZE,
  RECOVERY_MAX_MIN_RETRY_AGE_SECONDS,
  RECOVERY_MIN_MIN_RETRY_AGE_SECONDS,
  WebhookRecoveryLookupError,
  type WebhookRecoveryResult,
  type WebhookRecoveryRunInput,
} from "@/lib/stripe/webhook-recovery";
import {
  REPORT_DEFAULT_SAMPLE_LIMIT,
  REPORT_MAX_SAMPLE_LIMIT,
  WEBHOOK_REPORT_CATEGORIES,
  type WebhookRecoveryReport,
  type WebhookReportCategory,
} from "@/lib/stripe/webhook-recovery-report-types";

/**
 * POST body. Strict: unknown keys are rejected so a caller cannot smuggle options such
 * as "force", "includeDeadLetter" or a status override. There is intentionally NO
 * parameter that can select DEAD_LETTER/PROCESSED events, skip the claim, or change the
 * attempt limit or refund purpose.
 */
const runSchema = z
  .object({
    batchSize: z.number().int().min(1).max(RECOVERY_MAX_BATCH_SIZE).optional(),
    minRetryAgeSeconds: z
      .number()
      .int()
      .min(RECOVERY_MIN_MIN_RETRY_AGE_SECONDS)
      .max(RECOVERY_MAX_MIN_RETRY_AGE_SECONDS)
      .optional(),
  })
  .strict();

const reportQuerySchema = z.object({
  minRetryAgeSeconds: z.coerce
    .number()
    .int()
    .min(RECOVERY_MIN_MIN_RETRY_AGE_SECONDS)
    .max(RECOVERY_MAX_MIN_RETRY_AGE_SECONDS)
    .default(RECOVERY_DEFAULT_MIN_RETRY_AGE_SECONDS),
  sampleLimit: z.coerce.number().int().min(1).max(REPORT_MAX_SAMPLE_LIMIT).default(REPORT_DEFAULT_SAMPLE_LIMIT),
  category: z.enum(WEBHOOK_REPORT_CATEGORIES).optional(),
});

export type AdminWebhookRecoveryDeps = {
  authorize: () => Promise<AdminSessionRecord>;
  runRecovery: (
    input: Partial<WebhookRecoveryRunInput>,
    actor: string,
  ) => Promise<WebhookRecoveryResult>;
  loadReport: (input: {
    minRetryAgeSeconds: number;
    sampleLimit: number;
    category?: WebhookReportCategory;
  }) => Promise<WebhookRecoveryReport>;
};

function authFailure(error: unknown): NextResponse | null {
  if (error instanceof AdminUnauthorizedError) {
    return NextResponse.json(
      { success: false as const, code: "UNAUTHORIZED", message: "Unauthorized" },
      { status: 401 },
    );
  }
  if (error instanceof AdminForbiddenError) {
    return NextResponse.json(
      { success: false as const, code: "FORBIDDEN", message: "Forbidden" },
      { status: 403 },
    );
  }
  return null;
}

/**
 * POST: run one bounded recovery pass. ADMIN only; authorization happens BEFORE the
 * body is read and before any database work. The pass reuses the production
 * claim/fencing orchestrator, so this endpoint cannot bypass claiming, attempt limits,
 * terminal states or refund idempotency. Responses contain counts and event ids only.
 */
export async function handleAdminWebhookRecoveryRun(
  request: Request,
  deps: AdminWebhookRecoveryDeps,
): Promise<NextResponse> {
  try {
    const session = await deps.authorize();

    let body: unknown = {};
    const text = await request.text();
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return NextResponse.json(
          { success: false as const, code: "INVALID_JSON", message: "Invalid request body" },
          { status: 400 },
        );
      }
    }

    const parsed = runSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false as const,
          code: "INVALID_PARAMETERS",
          message: "Invalid recovery parameters",
          details: parsed.error.errors.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const result = await deps.runRecovery(parsed.data, `admin:${session.id}`);
    return NextResponse.json({ success: true as const, result });
  } catch (error) {
    const auth = authFailure(error);
    if (auth) return auth;
    if (error instanceof WebhookRecoveryLookupError) {
      return NextResponse.json(
        { success: false as const, code: error.code, message: "Recovery candidates could not be listed" },
        { status: 503 },
      );
    }
    console.error("[api/admin/webhooks/recovery] POST error");
    return NextResponse.json(
      { success: false as const, code: "INTERNAL_ERROR", message: "Internal server error" },
      { status: 500 },
    );
  }
}

/** GET: read-only diagnostic report (counts + bounded samples; no payloads). ADMIN only. */
export async function handleAdminWebhookRecoveryReport(
  request: Request,
  deps: AdminWebhookRecoveryDeps,
): Promise<NextResponse> {
  try {
    await deps.authorize();

    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    for (const key of ["minRetryAgeSeconds", "sampleLimit", "category"]) {
      const value = url.searchParams.get(key);
      if (value !== null) raw[key] = value;
    }
    const parsed = reportQuerySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false as const,
          code: "INVALID_PARAMETERS",
          message: "Invalid report parameters",
          details: parsed.error.errors.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const report = await deps.loadReport(parsed.data);
    return NextResponse.json({ success: true as const, report });
  } catch (error) {
    const auth = authFailure(error);
    if (auth) return auth;
    console.error("[api/admin/webhooks/recovery] GET error");
    return NextResponse.json(
      { success: false as const, code: "INTERNAL_ERROR", message: "Internal server error" },
      { status: 500 },
    );
  }
}
