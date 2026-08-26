/**
 * Telling Shopify Flow what a campaign did.
 *
 * No dedicated price editor in this category supports Flow, which makes it a cheap and
 * visible differentiator: a merchant wires pricing into automations they already have,
 * and we do not have to guess which ones.
 *
 * **A trigger payload never carries a price.** Same rule as telemetry, and for a stronger
 * reason: a payload passes through Flow and into whatever the merchant connected next —
 * a Slack channel, a spreadsheet, another app's API — and out of anywhere we can reason
 * about. Ids, names and counts are enough to act on and cost nothing if they leak.
 *
 * That rule is enforced rather than trusted: `assertNoPrices` walks the payload before it
 * is sent, and a payload carrying something price-shaped is dropped with a loud log rather
 * than delivered. A trigger that does not fire is a missing automation; a trigger that
 * leaks a merchant's pricing is a different kind of problem.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import type { AdminClient } from "../lib/execution/sync-executor";
import { adminClientForShop } from "./admin-client.server";

export const FLOW_TRIGGER_RECEIVE = `#graphql
  mutation AnchorFlowTriggerReceive($handle: String!, $payload: JSON!) {
    flowTriggerReceive(handle: $handle, payload: $payload) {
      userErrors { field message }
    }
  }
`;

export type TriggerHandle = "campaign-started" | "campaign-ended" | "campaign-held";

/**
 * Fields a trigger may carry.
 *
 * Deliberately narrow. Anything not on this list is a decision somebody should make
 * explicitly rather than a field that crept in, and the type is what stops a price being
 * added "just this once".
 */
export interface TriggerPayload {
  campaign_id: string;
  campaign_name: string;
  products_affected?: number;
  products_reverted?: number;
  products_drifted?: number;
  outcome?: "clean" | "partial" | "failed";
}

/**
 * Whether a payload contains anything that looks like money.
 *
 * Shape-based, not key-based, because the risk is somebody adding a field called
 * `threshold` that happens to hold "19.99". Checks values rather than names for the same
 * reason the telemetry redactor does.
 */
export function containsPrice(payload: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(payload)) {
    if (/price|amount|cost|money|compare/i.test(key)) return true;

    // Thousands separators included. "$1,299.00" is exactly the shape a price takes once
    // it has been formatted for display, and the first version of this missed it — the
    // test asserting so was itself wrong, which is a good argument for reading what a
    // test claims rather than only that it passes.
    if (typeof value === "string" && /^\s*[$£€¥]?\s*\d{1,3}(?:[,\s]\d{3})*[.,]\d{2}\s*$/.test(value)) {
      return true;
    }
    if (typeof value === "bigint") return true;

    if (value && typeof value === "object" && containsPrice(value as Record<string, unknown>)) {
      return true;
    }
  }

  return false;
}

/**
 * Fires a trigger, unless the payload would leak a price.
 *
 * Never throws. A trigger is a notification about work that has already happened, and
 * failing a campaign because an automation could not be told about it would be the tail
 * wagging the dog.
 */
export async function fireTrigger(
  client: AdminClient,
  handle: TriggerHandle,
  payload: TriggerPayload,
): Promise<boolean> {
  if (containsPrice(payload as unknown as Record<string, unknown>)) {
    logger.error("refused to fire a Flow trigger carrying a price", { handle });
    return false;
  }

  try {
    const response = await client.request<{
      flowTriggerReceive?: { userErrors?: Array<{ message?: string }> };
    }>(FLOW_TRIGGER_RECEIVE, { handle, payload });

    const errors = response.data?.flowTriggerReceive?.userErrors ?? [];
    if (errors.length > 0) {
      logger.warn("Flow rejected a trigger", {
        handle,
        error: errors.map((entry) => entry.message).join("; "),
      });
      return false;
    }

    return true;
  } catch (error) {
    // A merchant with no Flow installed, or a network blip. Logged at info because it is
    // not a problem worth an alert: nothing about the campaign depends on it.
    logger.info("could not deliver a Flow trigger", {
      handle,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** Fires a trigger for a shop, resolving its client. Used from the worker. */
export async function fireTriggerForShop(
  shopId: string,
  handle: TriggerHandle,
  payload: TriggerPayload,
): Promise<void> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { domain: true, uninstalledAt: true },
  });
  if (!shop || shop.uninstalledAt) return;

  const client = await adminClientForShop(shop.domain);
  if (!client) return;

  await fireTrigger(client, handle, payload);
}
