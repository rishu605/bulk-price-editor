/**
 * Who keeps each variant once this campaign is taken out, for the Revert dialog.
 *
 * A resource route, asked as the dialog's page loads. Answering means a plan of the whole
 * scope with this campaign excluded, and it used to make one on every ask -- a third full
 * plan behind every load of a campaign that could be reverted, the page's preview and its
 * rollback report being the other two (#468, #812). The answer is now worked out with the
 * rest of the campaign's stored plan and read here; the last one, marked as such, when it is
 * not current. See `revertKeepers`.
 *
 * Outside `/app/campaigns/*` for the same reason `app.preview-draft` is: `app.campaigns.$id`
 * would read the segment as a campaign id.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { toAdminClient } from "../services/admin-client.server";
import { revertKeepers } from "../services/campaigns/plan-summary.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const campaignId = String(form.get("campaignId") ?? "");
  if (!campaignId) return { keepers: [], repriced: 0 };

  return revertKeepers(shop.id, campaignId, toAdminClient(admin));
};
