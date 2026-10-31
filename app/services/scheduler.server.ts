/**
 * The scheduler: finding campaigns that owe a transition, and running it.
 *
 * All the timing rules live in lib/scheduling/window.ts, which is pure and tested.
 * This module only fetches candidates, asks that function what is due, and calls
 * the existing run path — so scheduled and manual runs go through exactly the same
 * code, ledger and verification.
 */

import { SCHEDULER_ACTOR } from "../lib/audit/actor";
import prisma from "../db.server";
import {
  dueTransition,
  occurrenceKeyFor,
  parseSchedule,
  type Transition,
} from "../lib/scheduling/window";
import { IS_PRACTICE, isPractice } from "./campaigns/model.server";
import { unschedule } from "./campaigns/schedule-control.server";
import { runCampaign } from "./campaigns/run.server";
import type { RunOutcome } from "./campaigns/types";
import { nextAttemptKey } from "../lib/scheduling/attempts";
import { refusedForGood, startRefusal } from "../lib/scheduling/start-refusal";
import { isEndingLate, toldEndingLate } from "../lib/scheduling/ending-late";
import { adminClientForShop } from "./admin-client.server";
import { claimEnrollment, endingSinceLastApply, pendingEnrollments } from "./auto-enroll.server";
import { reclaimStaleRuns } from "./campaigns/reaper.server";
import { claimForSchedule, noteCampaign } from "./campaigns/lifecycle.server";
import { recordEndingLate } from "./campaigns/ending-late.server";
import { countUncounted } from "./campaigns/recaptured.server";
import { beat } from "./scheduler-heartbeat.server";
import { checkAlerts } from "./alerting.server";
import { sendDueDigests } from "./digest.server";
import { pruneErrorEvents } from "./error-report.server";
import { pruneWebhookLog } from "./webhook-log.server";
import { auditMirror } from "./mirror-audit.server";
import { refreshDeveloperStore } from "./sync-job.server";
import { logger } from "../lib/logging/logger";
import { metric } from "../lib/telemetry/metrics";

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
  /** Operator alerts delivered this tick. Not merchant notifications. */
  alerts: number;
  /** Due transitions refused before they started: awaiting approval, over a limit, refused for good (#975). */
  refused: number;
  failures: Array<{ campaignId: string; error: string }>;
}

/**
 * One scheduler pass.
 *
 * Statuses are filtered in the query, but the decision itself is left to
 * `dueTransition` so there is one place that knows the rules.
 */
export async function tick(now: Date = new Date()): Promise<TickResult> {
  // The real clock, so `now` can be moved on by the time a run inside this tick took.
  const tickStartedAt = Date.now();
  const result: TickResult = {
    examined: 0,
    applied: 0,
    reverted: 0,
    enrolled: 0,
    reclaimed: 0,
    digests: 0,
    audited: 0,
    alerts: 0,
    refused: 0,
    failures: [],
  };

  // Before anything else, including before the alert check below reads it. This is the
  // only signal that separates a stopped scheduler from a quiet one, and a tick that did
  // any work first would be reporting liveness it had already spent time not having.
  await beat(now);

  // First, before anything is scheduled. A run whose process died still holds its
  // campaign in APPLYING, and a campaign in APPLYING is invisible to the query below
  // -- so without reclaiming first, a dead run would block every future occurrence of
  // that campaign forever, not merely display wrongly.
  result.reclaimed = (await reclaimStaleRuns(now)).reclaimed;

  // Before the work rather than after it. A tick that spends four minutes on a large
  // campaign and then checks alerts would report a stopped scheduler four minutes late,
  // every time — which is four minutes of a sale running past its end.
  const alerts = await checkAlerts(now);
  result.alerts = alerts.sent;

  // Before the work below, which can hold this tick for as long as one apply takes.
  await noteEndingLate(now);

  // HELD too: a held campaign's prices are still live, and its window still ends. Leaving
  // it out meant a sale that took one price edit never reverted on its end date (#756).
  //
  // A practice campaign never runs, so it never owes a transition (#827), and is not read at
  // all -- unless it is still in SCHEDULED, to be made a draft below (#976). In the query since
  // the flag is a column read alone (#1141): a JSON-path `NOT` on the schedule dropped every
  // row with no `practice` key at all, which was nearly all of them.
  const candidates = await prisma.campaign.findMany({
    where: { status: { in: ["SCHEDULED", "ACTIVE", "PARTIAL", "HELD"] }, OR: [{ NOT: IS_PRACTICE }, { status: "SCHEDULED" }] },
    include: { shop: { select: { id: true, domain: true, uninstalledAt: true } } },
  });

  // Campaigns this tick has already run, so the enrollment drain does not run them
  // a second time for no reason.
  const transitioned = new Set<string>();

  for (const campaign of candidates) {
    // An uninstalled shop has no usable token, and writing to it is impossible
    // anyway. Skipping quietly is correct; the data is retained for reinstall.
    if (campaign.shop.uninstalledAt) continue;

    // A practice campaign created with dates before the editor refused them sits in
    // SCHEDULED (#827), and from its start every tick claimed it, had `runCampaign` refuse it
    // -- a throw, whose release is recorded every time rather than once -- and put it back: an
    // activity entry and a worker failure every thirty seconds, for ever, since nothing ever
    // moves it out of SCHEDULED. The query reads one only in SCHEDULED, and here, before the
    // claim, it is made a draft again, once (#976): its page hides the schedule controls, as it
    // should for practice, so the merchant could not unschedule it, and it went on saying its
    // prices would change automatically.
    if (isPractice(campaign)) {
      if (campaign.status === "SCHEDULED") await unschedulePractice(campaign.shop.id, campaign.id);
      continue;
    }

    result.examined++;

    const transition = dueTransition(
      { schedule: parseSchedule(campaign.schedule), status: campaign.status },
      now,
    );
    if (!transition) continue;

    // A start refused for a reason no retry changes is left alone until its dates move
    // (#975). Before the claim, so a tick neither touches it nor says anything about it: the
    // campaign says why once, on its page, and every claim after that wrote the same release
    // to its history again, every thirty seconds.
    if (transition === "apply" && startRefusal(campaign.schedule)) continue;

    await runDue(campaign, transition, now, result, transitioned);
    if (transition !== "apply") continue;

    // An apply that outlasted its window ends now, not a tick later (#829). This tick has
    // been inside the apply all along -- at 102,132 variants, past the end of a 30-minute
    // sale -- and the rest of its list could hold it longer still. The clock is the tick's,
    // moved on by the time spent, and the revert takes its own claim and occurrence like any
    // other: the apply's run has finished, so it is the only writer (rule 2).
    const later = new Date(now.getTime() + (Date.now() - tickStartedAt));
    const after = await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true, schedule: true } });
    if (after && dueTransition({ schedule: parseSchedule(after.schedule), status: after.status }, later) === "revert") {
      await runDue({ ...campaign, ...after }, "revert", later, result, transitioned);
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

  // Webhook deliveries past their keeping, so the table every delivery writes does not grow
  // without end (#712). Last, and never able to hold up anything above it.
  try {
    await pruneWebhookLog(now);
  } catch (error) {
    logger.warn("could not prune the webhook log", { error: error instanceof Error ? error.message : String(error) });
  }

  // And failures past theirs (#785), for the same reason and on the same terms. The table
  // had no other bound, and a failure `shop/redact` cannot attribute to its shop is only
  // ever removed by this.
  try {
    await pruneErrorEvents(now);
  } catch (error) {
    logger.warn("could not prune the error log", { error: error instanceof Error ? error.message : String(error) });
  }

  // The live campaigns whose count of baselines recaptured at their sale price was never taken
  // (#1171), so one recaptured under before the count existed reads "needs a decision" on the
  // list, Home and the calendar. Each is counted once; after that its plan, a recapture, an
  // import or an apply keeps it. Last as well, on the same terms: it never throws.
  await countUncounted();

  // The log of writes stored plans are judged against (#812), past the age any summary could
  // still be current about. Last as well, on the same terms.
  try {
    const { prunePlanInputChanges } = await import("./campaigns/plan-summary.server");
    await prunePlanInputChanges(now);
  } catch (error) {
    logger.warn("could not prune the plan-input log", { error: error instanceof Error ? error.message : String(error) });
  }

  // Emitted every tick, including the quiet ones. A scheduler panel that only has data
  // when something happened cannot distinguish "nothing was due" from "the worker died"
  // — and those need very different responses.
  metric("scheduler.tick", 1, {
    examined: result.examined,
    applied: result.applied,
    reverted: result.reverted,
    reclaimed: result.reclaimed,
    failed: result.failures.length,
  });

  try {
    result.audited = await auditDueMirrors(now);
  } catch {
    // Per-shop failures are already logged; a throw here would be the loop itself.
  }

  return result;
}

/** A campaign the tick acts on, as its candidates query reads it. */
interface Candidate {
  id: string;
  schedule: unknown;
  shop: { id: string; domain: string };
}

/**
 * Runs one due transition for one campaign: picks the attempt, claims, runs, and counts the
 * outcome on `result`. Never throws; a failure is counted, and the tick goes on.
 */
async function runDue(
  campaign: Candidate,
  transition: Transition,
  now: Date,
  result: TickResult,
  transitioned: Set<string>,
): Promise<void> {
  // Which attempt at this occurrence, if any. Null when one is still running or every
  // attempt has been used; a finished attempt never blocks the next one (#700).
  const base = occurrenceKeyFor(parseSchedule(campaign.schedule), transition, now);
  const attempts = await prisma.campaignRun.findMany({
    where: {
      campaignId: campaign.id,
      kind: transition === "apply" ? "APPLY" : "REVERT",
      occurrenceKey: { startsWith: base },
    },
    select: { occurrenceKey: true, status: true },
  });
  const occurrenceKey = nextAttemptKey(base, attempts);
  if (!occurrenceKey) return;

  // Beaten again per campaign, not only at the top of the tick. `runTransition` below
  // can spend minutes on a large catalogue, and a heartbeat that only fires between
  // ticks would go stale during precisely the work that proves the scheduler is
  // alive — turning a busy scheduler into a stopped one. One upsert per due campaign
  // is nothing next to the run it precedes.
  await beat(new Date());

  try {
    const outcome = await runTransition(
      campaign.shop.id,
      campaign.shop.domain,
      campaign.id,
      transition,
      // The occurrence this tick is acting on, not the instant it happened to run.
      // Two ticks that both find this window due produce the same key, and the unique
      // index turns the second into a no-op rather than a second apply.
      occurrenceKey,
    );
    // Refused before it started, and released back to SCHEDULED: nothing was applied,
    // and counting it as applied made a stuck campaign look like a working tick.
    if (outcome?.refused) {
      result.refused++;
    } else if (transition === "apply") {
      result.applied++;
      transitioned.add(campaign.id);
    } else {
      result.reverted++;
      transitioned.add(campaign.id);
    }
  } catch (error) {
    // Refused for good (#975): `runCampaign` has recorded it on the campaign, and the
    // merchant has been told. A refusal like the ones returned early, not a failure of
    // ours, and not one the worker log should repeat.
    if (transition === "apply" && refusedForGood(error)) {
      result.refused++;
      return;
    }
    // One campaign failing must not stop the tick: the others are still due, and
    // a scheduler that gives up on the first error leaves sales unstarted.
    result.failures.push({
      campaignId: campaign.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Tells the merchant about every campaign still applying past the moment its revert was
 * due (#829), once each. The apply watches for this itself; this is for the time before it
 * starts watching -- a run being planned, or waiting in the worker's queue -- and for an
 * apply this tick is not running. `recordEndingLate` says each end once, whoever asks.
 */
async function noteEndingLate(now: Date): Promise<void> {
  try {
    const applying = await prisma.campaign.findMany({
      where: { status: "APPLYING", shop: { uninstalledAt: null } },
      select: { id: true, shopId: true, status: true, schedule: true },
    });
    for (const campaign of applying) {
      if (!isEndingLate(parseSchedule(campaign.schedule), campaign.status, now) || toldEndingLate(campaign.schedule)) continue;
      await recordEndingLate(campaign.shopId, campaign.id, now);
    }
  } catch (error) {
    // A courtesy to the merchant, never a reason for the tick not to start or end a sale.
    logger.warn("could not look for campaigns ending late", { error: error instanceof Error ? error.message : String(error) });
  }
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

      // A development store transferred to a merchant stops being free (#713).
      await refreshDeveloperStore(client, shop.id);
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
 * Prices the products campaigns gained while running.
 *
 * An apply over the enrolled variants and nothing else, resolved against every campaign
 * like any run. It used to be a whole-campaign apply, idempotent in theory: after a revert
 * stopped part-way it re-discounted everything the revert had restored, for one enrolled
 * variant (#805). A campaign being reverted is not priced into at all; its mark is cleared.
 */
async function drainEnrollments(
  result: TickResult,
  alreadyRun: ReadonlySet<string>,
): Promise<void> {
  const pending = await pendingEnrollments();

  for (const entry of pending) {
    // A campaign whose window transition already ran in this same tick has just been
    // priced from scratch, and that run covered the new variants too. Clearing the
    // mark without a second run is correct, not a shortcut.
    if (alreadyRun.has(entry.id)) {
      await claimEnrollment(entry.id);
      continue;
    }

    // Marked before a revert was asked for. The merchant is ending this sale; pricing its
    // new products into it now would be a second writer against the revert, or a sale
    // put back on products the revert has just restored.
    if (await endingSinceLastApply(entry.id)) {
      await claimEnrollment(entry.id);
      continue;
    }

    // The client before the claim. Claiming clears the mark, and clearing it for a run
    // that then could not start -- no session -- dropped the newly enrolled variants for
    // good (#707). Without a client the mark stays, and the next tick asks again.
    const client = await adminClientForShop(entry.shopDomain);
    if (!client) {
      result.failures.push({ campaignId: entry.id, error: `No usable session for ${entry.shopDomain}` });
      continue;
    }

    // Another worker that got there first returns false, which is the whole point --
    // two workers must not re-apply the same campaign.
    const variantGids = await claimEnrollment(entry.id);
    if (!variantGids) continue;
    // A mark from before the variants were recorded with it names none. Nothing is lost
    // that the variant's next edit does not enrol again.
    if (variantGids.length === 0) continue;

    try {
      // Named variants, so the run never holds the campaign: a revert pressed meanwhile
      // finds it and asks the merchant to try again in a minute, and this run, finding the
      // campaign claimed first, writes nothing (#763).
      await runCampaign(entry.shopId, entry.id, client, {
        actor: SCHEDULER_ACTOR,
        variantGids,
        occurrenceKey: `VARIANT-ENROLL-${Date.now()}`,
      });
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
): Promise<RunOutcome | null> {
  const client = await adminClientForShop(shopDomain);
  if (!client) {
    // Before any claim, so the campaign keeps its state and the next tick tries again --
    // but said on the campaign, once, rather than only in a tick log.
    await noteCampaign(
      shopId,
      campaignId,
      `Couldn't ${transition === "apply" ? "start" : "end"} on schedule: Anchor lost access to ` +
        `your store. Open Anchor in your Shopify admin to reconnect; the schedule resumes on its own.`,
    );
    throw new Error(`No usable session for ${shopDomain}`);
  }

  // Claim the campaign before running. Two ticks overlapping — a slow run, a second
  // worker that briefly held the lock — would otherwise both start the same
  // transition. The status change is the claim, taken from the exact state that was read,
  // so a run that fails before it starts can be put back there, and recorded as the
  // scheduler's (#829).
  const claim = await claimForSchedule(shopId, campaignId, transition, SCHEDULER_ACTOR);
  if (!claim) return null; // someone else took it

  // A held campaign's end still comes (#756), but the prices that held it were edited by
  // somebody on purpose and are waiting for a decision in the drift queue. Ending the sale
  // reverts everything else on time and leaves those as edited (#784): overwriting them
  // unasked is the one thing the hold exists to prevent.
  const edited =
    transition === "revert" && claim.from === "HELD"
      ? (
          await prisma.driftEvent.findMany({
            where: { shopId, campaignId, resolution: "PENDING", surfaceKind: "BASE" },
            select: { variantGid: true },
          })
        ).map((event) => event.variantGid)
      : [];

  return runCampaign(shopId, campaignId, client, {
    actor: SCHEDULER_ACTOR,
    revert: transition === "revert",
    occurrenceKey,
    claimedFrom: claim.from,
    ...(claim.recorded ? {} : { claimUnrecorded: claim.reason }),
    // An end tried again after one stopped part-way finishes that revert, as Resume does, so
    // it keeps what that revert kept as edited (#1157). Run as a fresh revert, the next tick
    // wrote over every one, before the merchant could press anything.
    ...(transition === "revert" && claim.from === "PARTIAL" ? { resume: true } : {}),
    ...(edited.length > 0
      ? {
          skipVariantGids: edited,
          skipReason:
            "Left as it is: this price was edited outside the app while the campaign was held, and the edit is still " +
            "waiting for your decision in the drift queue. The rest of the sale ended on schedule.",
        }
      : {}),
  });
}

/** Campaigns with a schedule that has not yet fired, for the UI. */
export async function upcomingTransitions(shopId: string, limit = 10) {
  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: ["SCHEDULED", "ACTIVE", "PARTIAL", "HELD"] } },
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

/**
 * A practice campaign left in SCHEDULED from before #827, returned to a draft with no
 * dates (#976), the way Unschedule does, with the history and audit entries that leaves.
 * A campaign that moved on since this tick read it is left alone.
 */
async function unschedulePractice(shopId: string, campaignId: string): Promise<void> {
  try {
    await unschedule(shopId, campaignId, SCHEDULER_ACTOR, "practice campaigns never run on a schedule");
  } catch (error) {
    logger.warn("practice campaign not unscheduled", { campaignId, error: error instanceof Error ? error.message : String(error) });
  }
}
