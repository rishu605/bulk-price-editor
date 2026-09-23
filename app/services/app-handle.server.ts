/**
 * This app's own handle, as Shopify knows it.
 *
 * It is the one piece of the managed-pricing link that is not a constant, and it is
 * deliberately not configuration. A handle in an env var is a second copy of a fact
 * Shopify already owns: it is set once, forgotten, and then wrong after a rename, which
 * surfaces as a 404 on the page where a merchant was about to pay.
 *
 * Cached for the lifetime of the process. The handle changes when somebody renames the
 * app in the Partner Dashboard, which is a deploy-shaped event, and the alternative is a
 * network call on every render of the plan page.
 */

import type { AdminClient } from "../lib/execution/sync-executor";
import { logger } from "../lib/logging/logger";

export const APP_HANDLE_QUERY = `#graphql
  query AnchorAppHandle {
    currentAppInstallation {
      app {
        handle
      }
    }
  }
`;

interface HandleResponse {
  currentAppInstallation?: { app?: { handle?: string | null } | null } | null;
}

let cached: string | null | undefined;

/**
 * Null when the query fails or answers nothing.
 *
 * Callers render no link rather than a broken one, so a failure here costs a button and
 * never a wrong page. That is why it swallows: the plan page is still worth showing
 * without its primary action, and taking the page down because one field did not arrive
 * would be the larger bug.
 */
export async function appHandle(client: AdminClient): Promise<string | null> {
  if (cached !== undefined) return cached;

  try {
    const { data } = await client.request<HandleResponse>(APP_HANDLE_QUERY, {});
    cached = data?.currentAppInstallation?.app?.handle ?? null;
  } catch (error) {
    logger.warn("app-handle.unavailable", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    cached = null;
  }

  return cached;
}

/** Test seam. The cache is process-wide, so a suite that never clears it leaks. */
export function resetAppHandleCache(): void {
  cached = undefined;
}
