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
import { applySubscriptionUpdate, subscriptionStillActive, syncSubscription } from "../services/billing.server";
import { toAdminClient } from "../services/admin-client.server";
import { parseSubscription } from "../lib/billing/subscription-payload";
import { logger } from "../lib/logging/logger";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, topic, shop, admin } = await authenticate.webhook(request);

  const record = await prisma.shop.findUnique({ where: { domain: shop }, select: { id: true } });
  if (!record) {
    // A subscription for a shop we have no row for. Acknowledged rather than retried:
    // Shopify will keep redelivering a failure, and there is nothing here to fix.
    logger.warn("subscription webhook for unknown shop", { shop, topic });
    return new Response();
  }

  // With a session, Shopify is asked whether a subscription is still active before a paid
  // event about it replaces the current one -- a replayed event about the plan the
  // merchant left is not (#787). Without one, the update applies as it always did.
  await applySubscriptionUpdate(record.id, parseSubscription(payload), {
    ...(admin ? { stillActive: subscriptionStillActive(toAdminClient(admin)) } : {}),
  });

  // Then settle on what Shopify lists as active (#860). An upgrade activates the new plan
  // and cancels the old, and the old one's CANCELLED often lands first, while the shop is
  // still recorded on it: applied alone, that put a merchant who had just paid for
  // Wholesale on Free until the new plan's ACTIVE arrived. Never throws.
  if (admin) await syncSubscription(record.id, toAdminClient(admin));

  return new Response();
};
