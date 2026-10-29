/**
 * Read-only parity check: Admin.nav.stripePayments + Admin.stripePayments
 * key trees must match English across all locale files.
 *
 *   npm run test:stripe-payments-i18n-parity
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function leafPaths(value: unknown, prefix = ""): string[] {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return [prefix];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return [prefix];
  return entries.flatMap(([key, child]) =>
    leafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

function main() {
  const dir = path.join(process.cwd(), "messages");
  const en = JSON.parse(fs.readFileSync(path.join(dir, "en.json"), "utf8")) as {
    Admin?: { nav?: { stripePayments?: string }; stripePayments?: unknown };
  };
  assert.equal(typeof en.Admin?.nav?.stripePayments, "string");
  assert.ok(en.Admin?.stripePayments && typeof en.Admin.stripePayments === "object");

  const expected = new Set(leafPaths(en.Admin.stripePayments, "Admin.stripePayments"));
  expected.add("Admin.nav.stripePayments");

  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const missing: string[] = [];

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
      Admin?: { nav?: { stripePayments?: unknown }; stripePayments?: unknown };
    };
    if (typeof data.Admin?.nav?.stripePayments !== "string") {
      missing.push(`${file}: Admin.nav.stripePayments`);
    }
    if (!data.Admin?.stripePayments || typeof data.Admin.stripePayments !== "object") {
      missing.push(`${file}: Admin.stripePayments`);
      continue;
    }
    const actual = new Set(leafPaths(data.Admin.stripePayments, "Admin.stripePayments"));
    for (const key of expected) {
      if (key === "Admin.nav.stripePayments") continue;
      if (!actual.has(key)) missing.push(`${file}: ${key}`);
    }
    for (const key of actual) {
      if (!expected.has(key)) missing.push(`${file}: unexpected ${key}`);
    }
  }

  assert.deepEqual(missing, [], `Locale key parity failures:\n${missing.join("\n")}`);
  console.log(`test-stripe-payments-i18n-parity: ${files.length} locales OK (${expected.size} keys)`);
}

main();
