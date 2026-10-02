/**
 * The merchant removed the app.
 *
 * `Shop.uninstalledAt` is the flag every background job reads to leave a departed shop
 * alone -- the weekly digest, the scheduler, the nightly mirror audit, auto-enroll, Flow
 * triggers, the queue handlers -- and nothing ever set it (#786). This deleted the sessions
 * and returned, so a merchant who uninstalled kept getting digest emails, and their due
 * campaigns were attempted every tick with no session to attempt them with.
 *
 * The shop row itself is kept: a reinstall reuses it, and its baselines are the
 * merchant's history (`ensureShop`, which clears the flag again).
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { PRICES_MAY_BE_LIVE } from "../lib/lifecycle/transitions";
import { logger } from "../lib/logging/logger";
import { markUninstalled } from "../services/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  logger.info("webhook received", { topic, shop });

  const record = await db.shop.findUnique({
    where: { domain: shop },
    select: { id: true, installedAt: true, uninstalledAt: true },
  });

  // Shopify delivers webhooks late and more than once. An uninstall triggered before the
  // shop's latest install is from a previous life: acting on it would mark a reinstalled
  // shop gone and delete the sessions it is using right now.
  const triggeredAt = Date.parse(request.headers.get("x-shopify-triggered-at") ?? "");
  if (record && Number.isFinite(triggeredAt) && triggeredAt < record.installedAt.getTime()) {
    logger.info("stale uninstall ignored: the shop reinstalled since", { shop });
    return new Response();
  }

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  if (record && !record.uninstalledAt) {
    await markUninstalled(shop);

    // Prices a campaign wrote stay on the storefront, and with no session the app can no
    // longer revert them. Said once, in the record, with what was live -- the question a
    // merchant or support asks after a reinstall is "what did it leave behind?".
    const live = await db.campaign.findMany({
      where: { shopId: record.id, status: { in: [...PRICES_MAY_BE_LIVE] } },
      select: { id: true, name: true, status: true },
    });
    await db.auditLogEntry.create({
      data: {
        shopId: record.id,
        actor: "shopify",
        action: "shop.uninstall",
        entity: "Shop",
        entityId: record.id,
        after: { liveCampaigns: live } as never,
      },
    });
  }

  return new Response();
};
