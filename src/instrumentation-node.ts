/**
 * Node-only instrumentation side effects (Prisma/pg, timers).
 * Imported only when NEXT_RUNTIME === "nodejs" from instrumentation.ts
 * so the Edge instrumentation graph never pulls in `fs`-dependent packages.
 */
export async function registerNodeInstrumentation(): Promise<void> {
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { startReviewRequestProcessor } = await import(
    "@/lib/reviews/start-review-request-processor"
  );
  startReviewRequestProcessor();
}
