/**
 * The scheduler: finding campaigns that owe a transition, and running it.
 *
 * All the timing rules live in lib/scheduling/window.ts, which is pure and tested.
 * This module only fetches candidates, asks that function what is due, and calls
 * the existing run path — so scheduled and manual runs go through exactly the same
 * code, ledger and verification.
 */

import prisma from "../db.server";
import {
  dueTransition,
  occurrenceKeyFor,
  parseSchedule,
  type Transition,
} from "../lib/scheduling/window";
import { runCampaign } from "./campaigns/run.server";
import { adminClientForShop } from "./admin-client.server";
import { claimEnrollment, pendingEnrollments } from "./auto-enroll.server";
import { reclaimStaleRuns } from "./campaigns/reaper.server";
import { sendDueDigests } from "./digest.server";
import { auditMirror } from "./mirror-audit.server";
import { logger } from "../lib/logging/logger";

export interface TickResult {
  examined: number;
  applied: number;
  reverted: number;
  /** Campaigns re-applied because products entered their scope while running. */
  enrolled: number;
  /** Runs whose process died and which this tick marked visibly partial. */
  reclaimed: number;
  /** Weekly summaries sent this tick. */
  digests: number;
  /** Shops whose mirror was sampled and checked against Shopify this tick. */
  audited: number;
  failures: Array<{ campaignId: string; error: string }>;
}

/**
 * One scheduler pass.
 *
 * Statuses are filtered in the query, but the decision itself is left to
 * `dueTransition` so there is one place that knows the rules.
 */
export async function tick(now: Date = new Date()): Promise<TickResult> {
  const result: TickResult = {
    examined: 0,
    applied: 0,
    reverted: 0,
    enrolled: 0,
    reclaimed: 0,
    digests: 0,
    audited: 0,
    failures: [],
  };

  // First, before anything is scheduled. A run whose process died still holds its
  // campaign in APPLYING, and a campaign in APPLYING is invisible to the query below
  // -- so without reclaiming first, a dead run would block every future occurrence of
  // that campaign forever, not merely display wrongly.
  result.reclaimed = (await reclaimStaleRuns(now)).reclaimed;

  const candidates = await prisma.campaign.findMany({
    where: { status: { in: ["SCHEDULED", "ACTIVE", "PARTIAL"] } },
    include: { shop: { select: { id: true, domain: true, uninstalledAt: true } } },
  });

  // Campaigns this tick has already run, so the enrollment drain does not run them
  // a second time for no reason.
  const transitioned = new Set<string>();

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
      await runTransition(
        campaign.shop.id,
        campaign.shop.domain,
        campaign.id,
        transition,
        // The occurrence this tick is acting on, not the instant it happened to run.
        // Two ticks that both find this window due produce the same key, and the unique
        // index turns the second into a no-op rather than a second apply.
        occurrenceKeyFor(parseSchedule(campaign.schedule), transition, now),
      );
      if (transition === "apply") {
        result.applied++;
        transitioned.add(campaign.id);
      } else {
        result.reverted++;
        transitioned.add(campaign.id);
      }
    } catch (error) {
      // One campaign failing must not stop the tick: the others are still due, and
      // a scheduler that gives up on the first error leaves sales unstarted.
      result.failures.push({
        campaignId: campaign.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await drainEnrollments(result, transitioned);

  // Last, and never able to hold up the work above it. A digest is a courtesy; a sale
  // starting on time is not.
  try {
    result.digests = await sendDueDigests(now);
  } catch {
    // sendDueDigests already logs per shop; a throw here would be the loop itself.
  }

  try {
    result.audited = await auditDueMirrors(now);
  } catch {
    // Per-shop failures are already logged; a throw here would be the loop itself.
  }

  return result;
}

/**
 * Samples each shop's mirror against Shopify, once a day, off-peak.
 *
 * Off-peak because it spends rate-limit budget: an audit that throttled a merchant's own
 * campaign to check up on itself would be a poor trade. The window is judged in the
 * shop's own timezone rather than the server's, or every shop on the platform would be
 * audited in the same hour.
 */
async function auditDueMirrors(now: Date): Promise<number> {
  const DAY = 24 * 60 * 60_000;
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null, initialSyncCompletedAt: { not: null } },
    select: { id: true, domain: true, timezone: true },
  });

  let audited = 0;

  for (const shop of shops) {
    try {
      if (!isOffPeak(now, shop.timezone)) continue;

      const last = await prisma.auditLogEntry.findFirst({
        where: { shopId: shop.id, action: "mirror.audit" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      if (last && now.getTime() - last.createdAt.getTime() < DAY) continue;

      const client = await adminClientForShop(shop.domain);
      if (!client) continue;

      await auditMirror(client, shop.id, { now });
      audited++;
    } catch (error) {
      logger.warn("mirror audit failed", {
        shop: shop.domain,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return audited;
}

/** Between 2am and 5am in the shop's own zone. */
function isOffPeak(now: Date, timeZone: string): boolean {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hour12: false }).format(now),
    );
    return hour >= 2 && hour < 5;
  } catch {
    // An unrecognised zone must not exclude a shop from ever being audited.
    return now.getUTCHours() >= 2 && now.getUTCHours() < 5;
  }
}

/**
 * Re-applies campaigns that gained products while running.
 *
 * This is a plain apply, not a special path. The run is idempotent -- variants
 * already at the campaign price are planned as "already correct" and written to
 * nobody -- so the newly enrolled variants are the only ones that cost an API call.
 */
async function drainEnrollments(
  result: TickResult,
  alreadyRun: ReadonlySet<string>,
): Promise<void> {
  const pending = await pendingEnrollments();

  for (const entry of pending) {
    // Claiming clears the mark. Another worker that got there first returns false,
    // which is the whole point -- two workers must not re-apply the same campaign.
    if (!(await claimEnrollment(entry.id))) continue;

    // A campaign whose window transition already ran in this same tick has just been
    // priced from scratch, and that run covered the new variants too. Clearing the
    // mark without a second run is correct, not a shortcut.
    if (alreadyRun.has(entry.id)) continue;

    try {
      const client = await adminClientForShop(entry.shopDomain);
      if (!client) throw new Error(`No usable session for ${entry.shopDomain}`);

      await runCampaign(entry.shopId, entry.id, client, {});
      result.enrolled++;
    } catch (error) {
      result.failures.push({
        campaignId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function runTransition(
  shopId: string,
  shopDomain: string,
  campaignId: string,
  transition: Transition,
  occurrenceKey: string,
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

  await runCampaign(shopId, campaignId, client, {
    revert: transition === "revert",
    occurrenceKey,
  });
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
