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

  // A 4xx, which Flow shows and does not resend: resending will not make a deleted
  // campaign exist. It used to be a 200, so the merchant's run log said it had worked.
  if (!campaign) {
    const answer: FlowAnswer = {
      status: 404,
      outcome: "not-found",
      message: `There is no campaign "${campaignId || "(empty)"}" in this store, so nothing was applied. Check the campaign ID in this Flow action -- the campaign may have been deleted.`,
    };
    await recordFlowRequest(shop.id, "start-campaign", { kind: "Campaign", id: campaignId }, answer);
    return respond(answer);
  }

  // The same call the button makes, bounded by Flow's ten seconds rather than the page's
  // five minutes (#773): anything larger goes to the background worker and is answered at
  // once, after the approval and plan gates have had their say.
  let answer: FlowAnswer;
  try {
    const outcome = await runCampaign(shop.id, campaign.id, toAdminClient(admin), {
      actor: FLOW_ACTOR,
      inlineBudgetMs: FLOW_INLINE_BUDGET_MS,
    });
    answer = answerForRun(outcome, campaign.name, "applied");
  } catch (error) {
    answer = answerForError(error, `"${campaign.name}" was not applied`);
  }

  logger.info("Flow asked to start a campaign", {
    shopId: shop.id,
    campaignId: campaign.id,
    status: answer.status,
    outcome: answer.outcome,
  });
  await recordFlowRequest(shop.id, "start-campaign", { kind: "Campaign", id: campaign.id }, answer);
  return respond(answer);
};
