/**
 * Paginated Checkout Session line-item listing (mocked Stripe list API).
 * No database and no Stripe network.
 *
 *   npm run test:checkout-line-items-pagination
 */

import assert from "node:assert/strict";

import { listAllCheckoutLineItems } from "../src/lib/stripe/checkout-line-items";

async function testSinglePageComplete() {
  const items = await listAllCheckoutLineItems("cs_1", async () => ({
    data: [
      { id: "li_1", amount_total: 17500, amount_subtotal: 17500, quantity: 1, currency: "eur" },
      { id: "li_2", amount_total: 25000, amount_subtotal: 25000, quantity: 1, currency: "eur" },
    ],
    has_more: false,
  }));
  assert.equal(items.length, 2);
  assert.equal(items[0]?.amountTotal, 17500);
  assert.equal(items[1]?.amountTotal, 25000);
}

async function testFollowsHasMorePagination() {
  const startingAfterSeen: Array<string | undefined> = [];
  const items = await listAllCheckoutLineItems("cs_2", async ({ startingAfter }) => {
    startingAfterSeen.push(startingAfter);
    if (!startingAfter) {
      return {
        data: [
          { id: "li_a", amount_total: 17500, amount_subtotal: 17500, quantity: 1, currency: "eur" },
        ],
        has_more: true,
      };
    }
    assert.equal(startingAfter, "li_a");
    return {
      data: [
        { id: "li_b", amount_total: 25000, amount_subtotal: 25000, quantity: 1, currency: "eur" },
      ],
      has_more: false,
    };
  });
  assert.deepEqual(startingAfterSeen, [undefined, "li_a"]);
  assert.equal(items.length, 2);
  assert.equal(items[0]?.amountTotal, 17500);
  assert.equal(items[1]?.amountTotal, 25000);
}

async function testHasMoreWithoutCursorThrows() {
  await assert.rejects(
    () =>
      listAllCheckoutLineItems("cs_3", async () => ({
        data: [{ amount_total: 100, amount_subtotal: 100, quantity: 1, currency: "eur" }],
        has_more: true,
      })),
    /Incomplete checkout line-item pagination/,
  );
}

async function testPaginationNetworkErrorPropagates() {
  await assert.rejects(
    () =>
      listAllCheckoutLineItems("cs_4", async () => {
        throw { statusCode: 429, code: "rate_limit", message: "slow down" };
      }),
    (error: unknown) => {
      assert.equal((error as { statusCode?: number }).statusCode, 429);
      return true;
    },
  );
}

async function testEmptyCompleteList() {
  const items = await listAllCheckoutLineItems("cs_5", async () => ({
    data: [],
    has_more: false,
  }));
  assert.equal(items.length, 0);
}

async function main() {
  await testSinglePageComplete();
  await testFollowsHasMorePagination();
  await testHasMoreWithoutCursorThrows();
  await testPaginationNetworkErrorPropagates();
  await testEmptyCompleteList();
  console.log("test-checkout-line-items-pagination: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
