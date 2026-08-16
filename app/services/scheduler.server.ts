/**
 * The scheduler: finding campaigns that owe a transition, and running it.
 *
 * All the timing rules live in lib/scheduling/window.ts, which is pure and tested.
 * This module only fetches candidates, asks that function what is due, and calls
 * the existing run path — so scheduled and manual runs go through exactly the same
 * code, ledger and verification.
 */

import prisma from "../db.server";
import { dueTransition, parseSchedule, type Transition } from "../lib/scheduling/window";
import { runCampaign } from "./campaigns/run.server";
import { adminClientForShop } from "./admin-client.server";

export interface TickResult {
  examined: number;
  applied: number;
  reverted: number;
  failures: Array<{ campaignId: string; error: string }>;
}

/**
 * One scheduler pass.
 *
 * Statuses are filtered in the query, but the decision itself is left to
 * `dueTransition` so there is one place that knows the rules.
 */
export async function tick(now: Date = new Date()): Promise<TickResult> {
  const result: TickResult = { examined: 0, applied: 0, reverted: 0, failures: [] };

  const candidates = await prisma.campaign.findMany({
    where: { status: { in: ["SCHEDULED", "ACTIVE", "PARTIAL"] } },
    include: { shop: { select: { id: true, domain: true, uninstalledAt: true } } },
  });

  for (const campaign of candidates) {
    // An uninstalled shop has no usable token, and writing to it is impossible
    // anyway. Skipping quietly is correct; the data is retained for reinstall.
    if (campaign.shop.uninstalledAt) continue;

    result.examined++;

    const transition = dueTransition(
      { schedule: parseSchedule(campaign.schedule), status: campaign.status },
      now,
    );
    if (!transition) continue;

    try {
      await runTransition(campaign.shop.id, campaign.shop.domain, campaign.id, transition);
      if (transition === "apply") result.applied++;
      else result.reverted++;
    } catch (error) {
      // One campaign failing must not stop the tick: the others are still due, and
      // a scheduler that gives up on the first error leaves sales unstarted.
      result.failures.push({
        campaignId: campaign.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function runTransition(
  shopId: string,
  shopDomain: string,
  campaignId: string,
  transition: Transition,
): Promise<void> {
  const client = await adminClientForShop(shopDomain);
  if (!client) throw new Error(`No usable session for ${shopDomain}`);

  // Claim the campaign before running. Two ticks overlapping — a slow run, a second
  // worker that briefly held the lock — would otherwise both start the same
  // transition. The status change is the claim.
  const claimed = await prisma.campaign.updateMany({
    where: {
      id: campaignId,
      status: transition === "apply" ? "SCHEDULED" : { in: ["ACTIVE", "PARTIAL"] },
    },
    data: { status: transition === "apply" ? "APPLYING" : "REVERTING" },
  });

  if (claimed.count === 0) return; // someone else took it

  await runCampaign(shopId, campaignId, client, { revert: transition === "revert" });
}

/** Campaigns with a schedule that has not yet fired, for the UI. */
export async function upcomingTransitions(shopId: string, limit = 10) {
  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: ["SCHEDULED", "ACTIVE", "PARTIAL"] } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return campaigns
    .map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      status: campaign.status,
      schedule: parseSchedule(campaign.schedule),
    }))
    .filter((entry) => entry.schedule.kind === "window");
}
