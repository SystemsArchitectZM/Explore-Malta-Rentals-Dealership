import { NextResponse } from "next/server";
import { constructWebhookEvent, processWebhookEvent } from "@/lib/stripe/webhook-service";
import { WebhookConfigurationError } from "@/lib/stripe/webhook-errors";
import { mapWebhookResultToHttp } from "@/lib/stripe/webhook-http-policy";

/**
 * POST /api/stripe/webhook
 *
 * Receives and processes Stripe webhook events.
 * Must consume the raw body bytes for signature verification — do NOT parse as JSON first.
 *
 * HTTP policy (Stripe retries any non-2xx):
 *   400  missing/invalid signature or unreadable body — rejected before any event
 *        processing; no WebhookEvent row is created for unverified requests.
 *   500  server misconfiguration (signing secret absent) or retryable incomplete
 *        processing.
 *   503  in-flight duplicate (another worker holds an unexpired lease; this delivery
 *        ran no handler). Retryable, with Retry-After. Does not alter the owner's lease.
 *   200  processed / ignored / already processed / permanently dead-lettered
 *        (terminal decision durably recorded).
 * The 2xx/5xx decision for processed events comes from the typed outcome in
 * webhook-http-policy.ts, never from error-message text.
 */
export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    console.warn("[webhook] Request received without stripe-signature header");
    return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (error) {
    console.error("[webhook] Failed to read request body", error);
    return NextResponse.json({ error: "Failed to read request body" }, { status: 400 });
  }

  let event;
  try {
    event = constructWebhookEvent(rawBody, signature);
  } catch (error) {
    if (error instanceof WebhookConfigurationError) {
      // Server fault: not a signature problem, and retryable once configured.
      console.error("[webhook] Webhook endpoint is not configured");
      return NextResponse.json({ error: "Webhook endpoint is not configured" }, { status: 500 });
    }
    console.warn("[webhook] Invalid signature or payload");
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 400 });
  }

  let result;
  try {
    result = await processWebhookEvent(event);
  } catch (error) {
    // processWebhookEvent is designed not to throw; if it does, processing is
    // incomplete and must be retried rather than acknowledged.
    console.error("[webhook] Unexpected failure outside typed processing", {
      eventId: event.id,
      eventType: event.type,
      error,
    });
    return NextResponse.json(
      { received: false, outcome: "retryable_failure", error: "WEBHOOK_PROCESSING_UNAVAILABLE" },
      { status: 500 },
    );
  }

  const { status, body, headers } = mapWebhookResultToHttp(result);

  // in_flight is a normal concurrency signal (503 by policy), not a processing failure;
  // it is already logged as webhook.duplicate_in_flight_skipped by the orchestrator.
  if (status >= 500 && result.outcome !== "in_flight") {
    console.error("[webhook] Event processing incomplete", {
      eventId: event.id,
      eventType: event.type,
      outcome: result.outcome,
    });
  }

  return NextResponse.json(body, { status, ...(headers ? { headers } : {}) });
}
