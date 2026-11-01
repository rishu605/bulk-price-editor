/**
 * A blocked plan, in the merchant's words (#1076): each blocking variant by its title. See
 * `lib/planning/blocked-message.ts`.
 */

import prisma from "../../db.server";
import type { BreachPolicy } from "../../lib/campaigns/breach-policy";
import { BLOCKED_NAMED, blockedMessage, type BlockedLine } from "../../lib/planning/blocked-message";
import type { BlockedVariant } from "../../lib/planning/types";
import { titleMapFor } from "./candidates.server";
import { breachPolicyOf } from "./model.server";

export async function describeBlocked(
  shopId: string,
  blocked: readonly BlockedVariant[],
  when: "preview" | "run",
  planned: {
    /** The campaign applied, previewed or reverted: a variant some other campaign stopped names that one (#1169). */
    campaignId: string;
    /** Its floor-breach policy, which decides what it is told to do (#1161). None for a revert, which plans without it. */
    breach?: BreachPolicy;
    /** It sets floors of its own (#816), so the floor to lower may be one of them. */
    ownFloors?: boolean;
  },
): Promise<string> {
  // Titles for the ones named only; the rest are a count.
  const [titles, others] = await Promise.all([
    titleMapFor(shopId, [...new Set(blocked.slice(0, BLOCKED_NAMED).map((entry) => entry.ref.variantGid))]),
    stoppedBy(shopId, blocked, planned.campaignId),
  ]);
  return blockedMessage(
    blocked.map((entry) => {
      const by = entry.campaignId ? others.get(entry.campaignId) : undefined;
      return {
        title: nameOf(entry.ref.variantGid, titles.get(entry.ref.variantGid)),
        reason: entry.reason,
        ...(entry.wouldBe ? { wouldBe: entry.wouldBe } : {}),
        ...(entry.floor ? { floor: entry.floor } : {}),
        ...(by ? { by } : {}),
      };
    }),
    when,
    planned.breach,
    planned.ownFloors,
  );
}

/**
 * The campaigns other than the one planned whose policy stopped a variant (#1169), by name and
 * with the policy each runs with. Each is one the plan resolved against, so it is pricing and
 * keeps the policy it started with, which `breachPolicyOf` says as the campaign page does. A
 * handful at most, never one per variant.
 */
async function stoppedBy(
  shopId: string,
  blocked: readonly BlockedVariant[],
  planned: string,
): Promise<Map<string, NonNullable<BlockedLine["by"]>>> {
  const ids = [...new Set(blocked.flatMap((entry) => (entry.campaignId && entry.campaignId !== planned ? [entry.campaignId] : [])))];
  if (ids.length === 0) return new Map();
  const campaigns = await prisma.campaign.findMany({
    where: { shopId, id: { in: ids } },
    // With its own floors and policy (#816): a campaign that chose Block keeps it in any state.
    select: { id: true, name: true, status: true, guardrailViolationPolicy: true, guardrails: true },
  });
  return new Map(
    await Promise.all(
      campaigns.map(async (campaign) => [campaign.id, { name: campaign.name, breach: await breachPolicyOf(shopId, campaign) }] as const),
    ),
  );
}

/**
 * The variant's title, or its number when the mirror has no title for it -- never the Admin
 * API's `gid://` form, which is what the mirror falls back to and nobody can look up.
 */
function nameOf(variantGid: string, title: string | undefined): string {
  return title && !title.startsWith("gid://") ? title : `variant ${variantGid.split("/").pop()}`;
}
