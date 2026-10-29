/**
 * Static audit: production createRefund callers must be ADMIN-gated routes only.
 *
 *   npm run test:refund-service-boundary
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  const root = process.cwd();
  const files = walk(path.join(root, "src"));
  const productionImporters: string[] = [];

  for (const file of files) {
    const rel = path.relative(root, file);
    // Definition / re-exports are fine.
    if (
      rel === "src/lib/stripe/refund-service.ts" ||
      rel === "src/lib/stripe/index.ts"
    ) {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const importsCreateRefund =
      /import\s*\{[^}]*\bcreateRefund\b[^}]*\}\s*from\s*["']@\/lib\/stripe(?:\/refund-service)?["']/.test(
        text,
      ) ||
      /import\s*\{\s*createRefund\s*\}\s*from\s*["']\.\.?\/.*refund-service["']/.test(text);
    if (importsCreateRefund) {
      productionImporters.push(rel);
    }
  }

  assert.deepEqual(
    productionImporters,
    ["src/app/api/admin/payments/[id]/refund/route.ts"],
    `Unexpected createRefund importers: ${JSON.stringify(productionImporters)}`,
  );

  const route = fs.readFileSync(
    path.join(root, "src/app/api/admin/payments/[id]/refund/route.ts"),
    "utf8",
  );
  assert.match(route, /requireAdminApiRole\(\["ADMIN"\]\)/);

  const reconcileRoute = fs.readFileSync(
    path.join(root, "src/app/api/admin/payments/[id]/reconcile-refunds/route.ts"),
    "utf8",
  );
  assert.match(reconcileRoute, /requireAdminApiRole\(\["ADMIN"\]\)/);

  const recoverRoute = fs.readFileSync(
    path.join(root, "src/app/api/admin/payments/[id]/recover-terminal-refund/route.ts"),
    "utf8",
  );
  assert.match(recoverRoute, /requireAdminApiRole\(\["ADMIN"\]\)/);
  assert.match(recoverRoute, /recoverTerminalRefundRequest/);
  assert.doesNotMatch(recoverRoute, /stripe\.refunds|createStripeRefund|refunds\.create/);

  console.log(
    "test-refund-service-boundary: only ADMIN refund route imports createRefund; reconcile + recover routes ADMIN-gated; recover never calls Stripe.",
  );
}

main();
