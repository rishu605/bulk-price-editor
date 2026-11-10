/**
 * The scheduler: finding campaigns that owe a transition, and running it.
 *
 * All the timing rules live in lib/scheduling/window.ts, which is pure and tested.
 * This module only fetches candidates, asks that function what is due, and hands each
 * due transition to the worker's queue (#809), whose job runs it through the existing run
 * path — so scheduled and manual runs go through exactly the same code, ledger and
 * verification. Given no queue, it runs each itself (`runScheduledTransition`).
 */

import { SCHEDULER_ACTOR } from "../lib/audit/actor";
import prisma from "../db.server";
import { dueTransition, parseSchedule, type Transition } from "../lib/scheduling/window";
import { IS_PRACTICE, isPractice } from "./campaigns/model.server";
import { unschedule } from "./campaigns/schedule-control.server";
import { inlineWork } from "./campaigns/run.server";
import { startRefusal } from "../lib/scheduling/start-refusal";
import { isEndingLate, toldEndingLate } from "../lib/scheduling/ending-late";
import { adminClientForShop } from "./admin-client.server";
import { claimEnrollment, endingSinceLastApply, pendingEnrollments } from "./auto-enroll.server";
import { enqueueOrRun, inlineRuntime, type QueueRuntime } from "../worker/queue-runtime.server";
import { handleJob } from "../worker/handlers.server";
import { laneFor, type JobRef } from "../worker/queues";
import { smallRun, smallVariantRun } from "../lib/execution/run-lane";
import { RUN_ENQUEUE_TIMEOUT_MS } from "./campaigns/queued-run.server";
import { reclaimStaleRuns } from "./campaigns/reaper.server";
import { runScheduledTransition } from "./scheduled-run.server";
import { leaseHolder, withShopLease } from "./shop-lease.server";
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
  /** Due transitions handed to the worker's queue, which runs and counts them (#809). */
  queued: number;
  /**
   * Due transitions this tick ran nothing for because another of the shop's runs holds its
   * lease (#809). Still due, so the next tick asks again; only a tick given no queue has these.
   */
  waiting: number;
  failures: Array<{ campaignId: string; error: string }>;
}

/**
 * One scheduler pass.
 *
 * Statuses are filtered in the query, but the decision itself is left to
 * `dueTransition` so there is one place that knows the rules.
 */
export async function tick(
  now: Date = new Date(),
  /**
   * Where the tick hands the work it finds (#808): the worker's queues, which since #809 take
   * its scheduled starts and ends too. Inline when not given -- the chaos suite, a script -- so
   * the work has happened by the time the tick returns, as it always had.
   */
  queue: QueueRuntime = inlineRuntime(handleJob),
): Promise<TickResult> {
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
    queued: 0,
    waiting: 0,
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

  // Before the work below, which can hold this tick for as long as one apply takes when the
  // tick was given no queue and runs it itself.
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
  // And those it handed to the queue (#809), whose enrolments wait for the transition to run:
  // its apply prices them anyway, and its end must never have them priced in beside it.
  const handedOver = new Set<string>();

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

    // To the worker's queue, on the lane its size calls for (#809): one 100k-variant apply run
    // here held every other shop's scheduled starts and ends behind it, and the leader lock
    // lapsed meanwhile. The job asks the schedule again when it runs, and an end that came
    // while its start applied follows in the same job (#1053).
    if (!queue.inline) {
      await handOver(campaign.shop.id, campaign.id, transition, queue, result);
      handedOver.add(campaign.id);
      continue;
    }

    // Given no queue, run here, as the tick always did -- holding the shop's run lease as the
    // worker's job would, so another of the shop's runs never writes beside it. Beaten again
    // per campaign: the run can spend minutes on a large catalogue, and a heartbeat that only
    // fired between ticks would go stale during the work that proves the scheduler alive.
    await beat(new Date());
    const ran = await withShopLease(
      campaign.shop.id,
      "run",
      () => runScheduledTransition(campaign.id, result, { now }),
      { holder: leaseHolder("tick"), campaignId: campaign.id },
    );
    if (ran.busy) result.waiting++;
    else for (const id of ran.value) transitioned.add(id);
  }

  await drainEnrollments(result, transitioned, handedOver, queue);

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

/**
 * Hands one due transition to the worker's queue (#809), on the small-run lane when its scope
 * is (`smallRun`), counted from one indexed count before anything is planned. Rung again by
 * every tick while it is still due: a job still waiting -- or put back because its shop is busy
 * -- absorbs the ring by its deduplication key. When the queue does not take it within a second
 * it runs here after all, in the tick, as the worker did everything before the queue existed.
 */
async function handOver(
  shopId: string,
  campaignId: string,
  transition: Transition,
  queue: QueueRuntime,
  result: TickResult,
): Promise<void> {
  try {
    const lane = laneFor(smallRun(await inlineWork(shopId, campaignId)));
    const ref: JobRef = { shopId, scheduled: campaignId, revert: transition === "revert" };
    const how = await enqueueOrRun(
      queue,
      lane,
      ref,
      // Run here when the queue cannot take it: the same transition, the same lease, counted.
      async () => {
        const ran = await withShopLease(shopId, "run", () => runScheduledTransition(campaignId, result), {
          holder: leaseHolder("tick"),
          campaignId,
        });
        if (ran.busy) result.waiting++;
      },
      RUN_ENQUEUE_TIMEOUT_MS,
    );
    if (how === "queued") result.queued++;
  } catch (error) {
    result.failures.push({ campaignId, error: error instanceof Error ? error.message : String(error) });
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
 * Hands the products campaigns gained while running to the worker's queue (#808).
 *
 * Each is an apply over the enrolled variants and nothing else, resolved against every
 * campaign like any run (#805), and it is the worker's to run (`runEnrollment`): the tick
 * used to run every one itself, in turn, and a campaign that gained a few thousand products
 * held every other shop's scheduled start and end behind it. The job carries the campaign,
 * not the variants: they stay its pending mark until the job claims them, so a job lost
 * before then loses nothing, and the next tick hands it over again -- absorbed, while one
 * waits, by its deduplication key. When the queue does not take it within a second, it runs
 * here, as it always did.
 */
async function drainEnrollments(
  result: TickResult,
  alreadyRun: ReadonlySet<string>,
  waitingToRun: ReadonlySet<string>,
  queue: QueueRuntime,
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

    // One whose transition is in the queue (#809): its mark waits for a tick after it has run.
    // Its end must not have them priced in beside it, and if its start is refused the mark is
    // still there.
    if (waitingToRun.has(entry.id)) continue;

    // Marked before a revert was asked for. The merchant is ending this sale; pricing its
    // new products into it now would be a second writer against the revert, or a sale
    // put back on products the revert has just restored. Asked here so a campaign being
    // ended is never handed over, and again by the job, for a revert pressed while it waits.
    if (await endingSinceLastApply(entry.id)) {
      await claimEnrollment(entry.id);
      continue;
    }

    try {
      // On the small-run lane when the variants waiting are few enough (#809).
      const lane = laneFor(smallVariantRun(entry.pending, entry.tagged));
      await enqueueOrRun(queue, lane, { shopId: entry.shopId, enroll: entry.id }, handleJob, RUN_ENQUEUE_TIMEOUT_MS);
      result.enrolled++;
    } catch (error) {
      result.failures.push({
        campaignId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
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
