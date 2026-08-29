/**
 * Who keeps each variant once this campaign is taken out.
 *
 * A resource route, and asked for only when the revert confirmation is opened, because
 * answering it means planning the whole scope again with this campaign excluded. The
 * campaign page already pays for one plan and a rollback report; a third in the loader
 * would put that cost in front of every page load for a modal most visits never open —
 * which is #468 in a new place.
 *
 * Outside `/app/campaigns/*` for the same reason `app.preview-draft` is: `app.campaigns.$id`
 * would read the segment as a campaign id.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { previewCampaign } from "../services/campaigns/preview.server";
import { keepersAfterRevert } from "../services/campaigns/keepers.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const campaignId = String(form.get("campaignId") ?? "");
  if (!campaignId) return { keepers: [], repriced: 0 };

  // `revert: true` plans with this campaign excluded, so every row that comes back is
  // owned by whoever keeps the variant afterwards — the resolver's answer rather than a
  // guess assembled from priorities.
  const preview = await previewCampaign(shop.id, campaignId, { revert: true });

  // Names for whatever the plan says still owns rows. Fetched after the plan rather than
  // before it, so the query asks for the few campaigns that actually keep something
  // instead of every campaign the shop has.
  const owners = [
    ...new Set(preview.rows.map((row) => row.campaignId).filter((id): id is string => Boolean(id))),
  ].filter((id) => id !== campaignId);

  const named = await prisma.campaign.findMany({
    where: { shopId: shop.id, id: { in: owners } },
    select: { id: true, name: true },
  });

  return keepersAfterRevert(
    preview,
    campaignId,
    new Map(named.map((campaign) => [campaign.id, campaign.name])),
  );
};
