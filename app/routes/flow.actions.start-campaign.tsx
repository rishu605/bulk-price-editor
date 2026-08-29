/**
 * Flow asking us to start a campaign.
 *
 * The load-bearing property: this does exactly what the Apply button does, including the
 * plan gate and every guardrail. An action that could start a campaign the interface
 * would have refused would be a way round every safety feature in the product, reachable
 * by anybody who can build a Flow — and the merchant would have no idea it existed.
 *
 * So there is no separate code path here. It authenticates, finds the campaign, and calls
 * the same `runCampaign` the button calls.
 */

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { toAdminClient } from "../services/admin-client.server";
import { runCampaign } from "../services/campaigns/index.server";
import { MAX_INLINE_ROWS } from "../lib/execution/inline-budget";
import { logger } from "../lib/logging/logger";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Verifies Flow's signature. An unsigned request is somebody else asking us to change
  // a merchant's prices.
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
    select: { id: true, name: true },
  });

  // 200, not 404. Flow retries a failure, and retrying will not make a deleted campaign
  // exist — it would just repeat the same error until the automation is disabled.
  if (!campaign) {
    logger.warn("Flow asked to start an unknown campaign", { shop: session.shop, campaignId });
    return new Response(null, { status: 200 });
  }

  // Same request deadline as the button, and the same reason: Flow calls this over HTTP
  // and the run is written before the response is sent.
  const outcome = await runCampaign(shop.id, campaign.id, toAdminClient(admin), {
    inlineRowLimit: MAX_INLINE_ROWS,
  });

  logger.info("Flow started a campaign", {
    shopId: shop.id,
    campaignId: campaign.id,
    verified: outcome.verified,
    refused: outcome.refused ?? null,
  });

  return new Response(null, { status: 200 });
};
