/**
 * Whether a product arriving by webhook is a gift card.
 *
 * Campaigns never price gift cards (#672): a discounted gift card is store credit sold
 * below face value. The exclusion reads `variant_index.isGiftCard`, and the product
 * webhook payload carries no such field -- only the GraphQL `Product.isGiftCard` does.
 * A product first seen through `products/create` used to be mirrored with the schema
 * default, `false`, and nothing scheduled the catalogue sync that would correct it, so
 * a gift card created during an "everything 20% off" sale was auto-enrolled and sold at
 * $40 for $50 of credit (#689).
 *
 * So the webhook asks Shopify, but only when the mirror cannot already be trusted:
 *
 *   Seen before as an ordinary product: trusted, no lookup. Gift-card-ness is fixed for
 *   the life of a product, and product-update webhooks fire on every stock and title
 *   edit -- asking each time would spend budget to learn nothing.
 *
 *   Never seen, or recorded as a gift card: asked. The second case is what lets a
 *   product marked a gift card only because a lookup failed correct itself on its next
 *   edit, rather than waiting for a sync nobody schedules.
 *
 * A lookup that fails answers "gift card". Leaving a new product out of a sale until
 * Shopify can say what it is costs a merchant one product's discount; guessing wrong the
 * other way sells store credit at a loss.
 */

import prisma from "../db.server";
import type { AdminClient } from "../lib/execution/sync-executor";
import { logger } from "../lib/logging/logger";
import type { AnchorProductGiftCardQuery } from "../types/admin.generated";

export const PRODUCT_GIFT_CARD_QUERY = `#graphql
  query AnchorProductGiftCard($id: ID!) {
    product(id: $id) { id isGiftCard }
  }
`;

/**
 * What to record as `isGiftCard` for this product's variants, or `undefined` to leave
 * the mirror's value as it is.
 *
 * `client` is null when the shop has no usable offline session, which is treated like
 * any other failed lookup.
 */
export async function giftCardFlagFor(
  shopId: string,
  productGid: string,
  client: AdminClient | null,
): Promise<boolean | undefined> {
  const known = await prisma.variantIndex.findFirst({
    where: { shopId, productGid },
    select: { isGiftCard: true },
  });
  if (known && !known.isGiftCard) return undefined;

  try {
    if (!client) throw new Error("no admin session for this shop");
    const response = await client.request<AnchorProductGiftCardQuery>(PRODUCT_GIFT_CARD_QUERY, {
      id: productGid,
    });
    const isGiftCard = response.data?.product?.isGiftCard;
    if (typeof isGiftCard !== "boolean") throw new Error("product not returned");
    return isGiftCard;
  } catch (error) {
    logger.warn("gift-card lookup failed; product kept out of campaigns", {
      shopId,
      productGid,
      error,
    });
    return true;
  }
}
