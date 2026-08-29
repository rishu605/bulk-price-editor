/**
 * Where an email about a campaign should send the merchant.
 *
 * Every run notification already ends with "Open the campaign to review and resume", and
 * until now none of them carried a link: `campaignUrl` was optional on the notification
 * type, no caller ever set it, and the template's `link()` helper quietly returned an
 * empty string. So the one message whose entire purpose is to reach somebody who is *not*
 * looking at the app told them a run had gone partial and gave them no way to get to it.
 *
 * ## Why the admin URL and not ours
 *
 * `SHOPIFY_APP_URL` points at the Railway service, and opening it directly loads the app
 * outside the admin frame — no `host`, no `id_token`, no session. The merchant would land
 * on an authentication error. The embedded route has to be entered *through* the admin,
 * which is what `admin.shopify.com/store/<store>/apps/<client id>/<path>` does.
 *
 * ## Why it may return nothing
 *
 * No API key configured means local development or a self-hosted install, and the same
 * rule the mail transport follows applies here: unconfigured is a no-op, not an error. A
 * missing link drops one line from an email. A guessed link sends a merchant to a page
 * that will not load, which is worse than no link at all.
 */

export function campaignUrl(
  shopDomain: string,
  campaignId: string,
  apiKey: string | undefined,
): string | undefined {
  if (!apiKey) return undefined;

  const store = shopDomain.replace(/\.myshopify\.com$/, "");
  if (!store || !campaignId) return undefined;

  return `https://admin.shopify.com/store/${store}/apps/${apiKey}/app/campaigns/${campaignId}`;
}

/** The drift queue, for the one notification that is about no single campaign. */
export function driftUrl(shopDomain: string, apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;

  const store = shopDomain.replace(/\.myshopify\.com$/, "");
  if (!store) return undefined;

  return `https://admin.shopify.com/store/${store}/apps/${apiKey}/app/prices/drift`;
}
