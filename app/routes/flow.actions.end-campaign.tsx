/**
 * Flow asking us to end a campaign.
 *
 * Never gated on plan, on any tier, for the same reason the Revert button is not: a
 * merchant whose plan lapsed must still be able to end a sale, and a storefront left
 * discounted because an automation was refused is a revenue incident we caused.
 */

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { toAdminClient } from "../services/admin-client.server";
import { runCampaign } from "../services/campaigns/index.server";
import { logger } from "../lib/logging/logger";
import { MAX_INLINE_ROWS } from "../lib/execution/inline-budget";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, payload } = await authenticate.flow(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { id: true },
  });
  if (!shop) return new Response("Unknown shop", { status: 404 });

  const campaignId = String(
    (payload as { properties?: Record<string, unknown> }).properties?.["campaign-id"] ?? "",
  );

  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId: shop.id },
    select: { id: true },
  });
  if (!campaign) {
    logger.warn("Flow asked to end an unknown campaign", { shop: session.shop, campaignId });
    return new Response(null, { status: 200 });
  }

  // Bounded like the button (#772): Flow calls this over HTTP too, and a revert too large
  // for one request is handed to the background worker rather than cut off mid-write.
  const outcome = await runCampaign(shop.id, campaign.id, toAdminClient(admin), {
    actor: "shopify-flow",
    revert: true,
    inlineRowLimit: MAX_INLINE_ROWS,
  });

  logger.info(outcome.queued ? "Flow ended a campaign through the worker" : "Flow ended a campaign", {
    shopId: shop.id,
    campaignId: campaign.id,
    verified: outcome.verified,
  });

  return new Response(null, { status: 200 });
};
