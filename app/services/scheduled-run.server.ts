/**
 * A campaign's due scheduled start or end, run (#809).
 *
 * The scheduler's tick used to run each due transition inside itself, in turn. One 100k-variant
 * scheduled apply then held every other shop's scheduled starts and ends behind it for as long
 * as it took, and the leader lock lapsed meanwhile (#808's comment). Now the tick hands each to
 * the worker's queue, on the lane its size calls for, and the worker runs it here -- holding the
 * shop's lease, as every run does. With no queue at all (the chaos suite, a script) the tick
 * runs it here itself, holding the lease the same way, so its result is what it always was.
 *
 * The job carries the campaign and nothing else: this reads the campaign again and asks the
 * schedule again what is due, so a transition that waited behind its shop's other run acts on
 * the campaign as it is when it runs. Two jobs for one transition -- a ring and a late delivery
 * -- are one run, for the reason two overlapping ticks always were: the claim is conditional on
 * the state that was read, and the occurrence's row is unique (`runDue`).
 */

import { SCHEDULER_ACTOR } from "../lib/audit/actor";
import prisma from "../db.server";
import { dueTransition, occurrenceKeyFor, parseSchedule, type Transition } from "../lib/scheduling/window";
import { nextAttemptKey } from "../lib/scheduling/attempts";
import { refusedForGood, startRefusal } from "../lib/scheduling/start-refusal";
import { logger } from "../lib/logging/logger";
import { isPractice } from "./campaigns/model.server";
import { runCampaign } from "./campaigns/run.server";
import type { RunOutcome } from "./campaigns/types";
import { claimForSchedule, noteCampaign } from "./campaigns/lifecycle.server";
import { adminClientForShop } from "./admin-client.server";

/** What a scheduled transition did, counted the way the tick's result counts it. */
export interface ScheduledTally {
  applied: number;
  reverted: number;
  /** Refused before it started: awaiting approval, over a limit, refused for good (#975). */
  refused: number;
  failures: Array<{ campaignId: string; error: string }>;
}

/** A tally to fill, for a caller with none of its own: the worker's job. */
export function emptyTally(): ScheduledTally {
  return { applied: 0, reverted: 0, refused: 0, failures: [] };
}

/**
 * Runs whatever the campaign's schedule owes now, and -- when that was its start and its end
 * came while it applied -- its end straight after (#829, #1053). Returns the campaigns it ran a
 * transition for, which the tick's enrolment drain then leaves alone. Never throws; a failure is
 * counted on `tally`.
 *
 * The caller holds the shop's run lease: the tick when it runs this itself, `handleJob`
 * otherwise. The end after the start runs inside the same hold, so another of the shop's runs
 * never starts between the sale going on and its end that is already due.
 */
export async function runScheduledTransition(
  campaignId: string,
  tally: ScheduledTally,
  { now = new Date() }: { now?: Date } = {},
): Promise<Set<string>> {
  const transitioned = new Set<string>();
  // The real clock, so `now` can be moved on by the time the apply took.
  const startedAt = Date.now();
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { shop: { select: { id: true, domain: true, uninstalledAt: true } } },
  });
  if (!campaign || campaign.shop.uninstalledAt || isPractice(campaign)) return transitioned;

  const transition = dueTransition({ schedule: parseSchedule(campaign.schedule), status: campaign.status }, now);
  if (!transition) return transitioned;
  // Refused for a reason no retry changes, until its dates move (#975): asked again here, since
  // the tick that handed this over asked before the job waited.
  if (transition === "apply" && startRefusal(campaign.schedule)) return transitioned;

  await runDue(campaign, transition, now, tally, transitioned);
  if (transition !== "apply") return transitioned;

  // An apply that outlasted its window ends now, not a tick later (#829, #1053). This has been
  // inside the apply all along -- at 102,132 variants, past the end of a 30-minute sale -- so
  // the clock is moved on by the time spent, and the revert takes its own claim and occurrence
  // like any other: the apply's run has finished, so it is the only writer (rule 2).
  const later = new Date(now.getTime() + (Date.now() - startedAt));
  const after = await prisma.campaign.findUnique({ where: { id: campaign.id }, select: { status: true, schedule: true } });
  if (after && dueTransition({ schedule: parseSchedule(after.schedule), status: after.status }, later) === "revert") {
    await runDue({ ...campaign, ...after }, "revert", later, tally, transitioned);
  }
  return transitioned;
}

/** A campaign a transition acts on, as it was read. */
interface Candidate {
  id: string;
  schedule: unknown;
  shop: { id: string; domain: string };
}

/**
 * Runs one due transition for one campaign: picks the attempt, claims, runs, and counts the
 * outcome on `tally`. Never throws; a failure is counted, and the caller goes on.
 */
async function runDue(
  campaign: Candidate,
  transition: Transition,
  now: Date,
  tally: ScheduledTally,
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

  try {
    const outcome = await runTransition(
      campaign.shop.id,
      campaign.shop.domain,
      campaign.id,
      transition,
      // The occurrence this transition is acting on, not the instant it happened to run.
      // Two ticks that both find this window due produce the same key, and the unique
      // index turns the second into a no-op rather than a second apply.
      occurrenceKey,
    );
    // Refused before it started, and released back to SCHEDULED: nothing was applied,
    // and counting it as applied made a stuck campaign look like a working tick.
    if (outcome?.refused) {
      tally.refused++;
    } else if (transition === "apply") {
      tally.applied++;
      transitioned.add(campaign.id);
    } else {
      tally.reverted++;
      transitioned.add(campaign.id);
    }
  } catch (error) {
    // Refused for good (#975): `runCampaign` has recorded it on the campaign, and the
    // merchant has been told. A refusal like the ones returned early, not a failure of
    // ours, and not one the worker log should repeat.
    if (transition === "apply" && refusedForGood(error)) {
      tally.refused++;
      return;
    }
    // One campaign failing must not stop the rest: the others are still due, and a
    // scheduler that gives up on the first error leaves sales unstarted.
    tally.failures.push({
      campaignId: campaign.id,
      error: error instanceof Error ? error.message : String(error),
    });
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
  // worker that briefly held the lock, a ring and a late delivery — would otherwise both
  // start the same transition. The status change is the claim, taken from the exact state
  // that was read, so a run that fails before it starts can be put back there, and recorded
  // as the scheduler's (#829).
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

/**
 * The worker's job for a transition the tick handed over (#809): runs it, and says in the log
 * what the tick's own line used to say for it. Never throws, as the tick never did for one
 * campaign: the next tick asks again while the transition is still due.
 */
export async function runScheduledJob(campaignId: string): Promise<void> {
  const tally = emptyTally();
  await runScheduledTransition(campaignId, tally);
  for (const failure of tally.failures) {
    logger.error("a scheduled transition failed", { campaignId: failure.campaignId, error: failure.error });
  }
  if (tally.applied + tally.reverted + tally.refused > 0) {
    logger.info("a scheduled transition ran", { campaignId, applied: tally.applied, reverted: tally.reverted, refused: tally.refused });
  }
}
