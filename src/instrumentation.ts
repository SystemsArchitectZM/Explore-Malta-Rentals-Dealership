export async function register(): Promise<void> {
  // Instrumentation is compiled for both Node and Edge. Keep this file free of
  // static Node-only imports (pg/Prisma). The Edge webpack graph substitutes
  // instrumentation-edge-stub for instrumentation-node (see next.config.ts).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerNodeInstrumentation } = await import("./instrumentation-node");
  await registerNodeInstrumentation();
}
