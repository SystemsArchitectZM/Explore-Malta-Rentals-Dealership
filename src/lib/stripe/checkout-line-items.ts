/**
 * Complete Checkout Session line-item loading via Stripe's list API.
 * Never treat a single expanded page as authoritative.
 */

export type CheckoutLineItemSummary = {
  amountTotal: number | null;
  amountSubtotal: number | null;
  quantity: number | null;
  currency: string | null;
};

export type CheckoutLineItemPage = {
  data: Array<{
    id?: string;
    amount_total?: number | null;
    amount_subtotal?: number | null;
    quantity?: number | null;
    currency?: string | null;
  }>;
  has_more: boolean;
};

export type ListCheckoutLineItemsPage = (args: {
  sessionId: string;
  limit: number;
  startingAfter?: string;
}) => Promise<CheckoutLineItemPage>;

/**
 * Follows Stripe pagination until `has_more` is false.
 * Throws when pagination cannot be completed safely.
 */
export async function listAllCheckoutLineItems(
  sessionId: string,
  listPage: ListCheckoutLineItemsPage,
  pageLimit = 100,
): Promise<CheckoutLineItemSummary[]> {
  const items: CheckoutLineItemSummary[] = [];
  let startingAfter: string | undefined;

  for (;;) {
    const page = await listPage({
      sessionId,
      limit: pageLimit,
      ...(startingAfter ? { startingAfter } : {}),
    });

    for (const item of page.data) {
      items.push({
        amountTotal: item.amount_total ?? null,
        amountSubtotal: item.amount_subtotal ?? null,
        quantity: item.quantity ?? null,
        currency: item.currency ?? null,
      });
    }

    if (!page.has_more) {
      return items;
    }

    const lastId = page.data[page.data.length - 1]?.id;
    if (!lastId) {
      throw new Error("Incomplete checkout line-item pagination");
    }
    startingAfter = lastId;
  }
}
