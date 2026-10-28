import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { sendTestEmail } from "../services/notifications.server";
import { withGuard } from "../lib/errors/guard.server";

/**
 * Settings → Notifications → Send test email (#1122).
 *
 * Its own route rather than an intent on the settings form, which is one form with no
 * intents on purpose (`settings-form.test.ts`): a test email is not a save, and must not
 * write a guardrail somebody has half-typed.
 */
export const action = withGuard("/app/settings/email-check", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return sendTestEmail(shop.id, shop.domain);
});
