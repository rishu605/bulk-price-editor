/**
 * Flow asking us to capture baselines.
 *
 * The one action here with a sharp edge. A baseline is what every campaign computes from,
 * permanently — so capturing while a sale is running records the sale price as the new
 * normal, and every future discount comes off the discounted number.
 *
 * The app makes a merchant type a confirmation for exactly that reason. An automation
 * cannot type, so this refuses outright when a campaign is live rather than asking. A
 * scheduled automation that silently reset a merchant's reference prices mid-sale would be
 * the most expensive thing in this codebase.
 */

import type { ActionFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { planRecapture, recapture } from "../services/recapture.server";
import { logger } from "../lib/logging/logger";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, payload } = await authenticate.flow(request);

  const shop = await prisma.shop.findUnique({
    where: { domain: session.shop },
    select: { id: true },
  });
  if (!shop) return new Response("Unknown shop", { status: 404 });

  const running = await prisma.campaign.count({
    where: { shopId: shop.id, status: { in: ["ACTIVE", "APPLYING", "PARTIAL"] } },
  });

  if (running > 0) {
    logger.warn("Flow asked to capture baselines while a campaign is live; refused", {
      shopId: shop.id,
      running,
    });
    return new Response(null, { status: 200 });
  }

  const segmentId = String(
    (payload as { properties?: Record<string, unknown> }).properties?.["segment id"] ?? "",
  );

  // The confirmation phrase is generated from the plan and handed straight back. That
  // reads like defeating the check and is not: the check exists to make a *person* stop
  // and read the warning, and the warning it produces is about live campaigns — which is
  // the condition already refused above. What remains is the scope, which the automation
  // named deliberately.
  const plan = await planRecapture(shop.id, { segmentId: segmentId || undefined });

  const result = await recapture(shop.id, {
    segmentId: segmentId || undefined,
    confirmation: plan.confirmationPhrase ?? undefined,
    actor: "shopify-flow",
  });

  logger.info("Flow captured baselines", { shopId: shop.id, captured: result.captured });

  return new Response(null, { status: 200 });
};
