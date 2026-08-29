/**
 * Prices a campaign that does not exist yet, for the editor's live preview.
 *
 * A resource route rather than a second action on the editor: the editor's own action
 * creates a campaign, and a preview that shares a submit target with "create the thing"
 * is one misrouted request away from creating one by accident.
 *
 * Deliberately outside `/app/campaigns/*` so it cannot be confused with a campaign id
 * by `app.campaigns.$id`.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { draftCampaignFrom } from "../services/campaigns/draft-input.server";
import { previewDraft } from "../services/campaigns/draft-preview.server";
import { shopCurrency } from "../services/settings.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();

  // The same reading of the fields the editor's loader uses for its first paint, so the
  // preview does not change the moment a merchant touches an unrelated control.
  return previewDraft(shop.id, await draftCampaignFrom(shop.id, form, await shopCurrency(shop.id)));
};
