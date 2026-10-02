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
import {
  answerForError,
  answerForRun,
  FLOW_ACTOR,
  FLOW_INLINE_BUDGET_MS,
  recordFlowRequest,
  respond,
  type FlowAnswer,
} from "../services/flow/flow-answer.server";
import { logger } from "../lib/logging/logger";

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
    select: { id: true, name: true },
  });
  if (!campaign) {
    const answer: FlowAnswer = {
      status: 404,
      outcome: "not-found",
      message: `There is no campaign "${campaignId || "(empty)"}" in this store, so nothing was ended. Check the campaign ID in this Flow action -- the campaign may have been deleted.`,
    };
    await recordFlowRequest(shop.id, "end-campaign", { kind: "Campaign", id: campaignId }, answer);
    return respond(answer);
  }

  // Bounded by Flow's ten seconds (#773): a revert larger than that is handed to the
  // background worker (#772) and answered at once. Never refused for its size.
  let answer: FlowAnswer;
  try {
    const outcome = await runCampaign(shop.id, campaign.id, toAdminClient(admin), {
      actor: FLOW_ACTOR,
      revert: true,
      inlineBudgetMs: FLOW_INLINE_BUDGET_MS,
    });
    answer = answerForRun(outcome, campaign.name, "ended");
  } catch (error) {
    answer = answerForError(error, `"${campaign.name}" was not ended`);
  }

  logger.info("Flow asked to end a campaign", {
    shopId: shop.id,
    campaignId: campaign.id,
    status: answer.status,
    outcome: answer.outcome,
  });
  await recordFlowRequest(shop.id, "end-campaign", { kind: "Campaign", id: campaign.id }, answer);
  return respond(answer);
};
