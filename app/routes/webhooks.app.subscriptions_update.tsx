/**
 * Shopify telling us a subscription changed.
 *
 * The only place the plan tier moves. A merchant upgrading mid-session and a merchant
 * whose card was declined arrive here the same way, and neither touches a campaign —
 * see the note in `billing.server.ts` about edge case E8.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { applySubscriptionUpdate } from "../services/billing.server";
import { parseSubscription } from "../lib/billing/subscription-payload";
import { logger } from "../lib/logging/logger";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop } = await authenticate.webhook(request);

  const record = await prisma.shop.findUnique({ where: { domain: shop }, select: { id: true } });
  if (!record) {
    // A subscription for a shop we have no row for. Acknowledged rather than retried:
    // Shopify will keep redelivering a failure, and there is nothing here to fix.
    logger.warn("subscription webhook for unknown shop", { shop, topic });
    return new Response();
  }

  await applySubscriptionUpdate(record.id, parseSubscription(payload));

  return new Response();
};
