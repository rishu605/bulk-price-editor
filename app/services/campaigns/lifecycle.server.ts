/**
 * The only place a campaign's status changes.
 *
 * Status was previously written inline wherever a run finished, which meant nothing
 * enforced the state machine and nothing recorded who moved what. Two problems with
 * that, both real:
 *
 *   A run finishing late could overwrite a newer state -- a revert that started while
 *   an apply was still settling would flip ACTIVE back on after the revert completed.
 *
 *   When a campaign was found in a surprising state, there was no way to find out how
 *   it got there.
 *
 * The update is conditional on the current state being one this transition is legal
 * from, so it doubles as the claim: two workers racing on the same transition, one
 * wins, and the loser sees `changed: false` rather than corrupting the sequence.
 */

import { SCHEDULER_ACTOR } from "../../lib/audit/actor";
import prisma from "../../db.server";
import {
  canTransition,
  describeState,
  type CampaignState,
} from "../../lib/lifecycle/transitions";
import { AppError } from "../../lib/errors/app-error";
import { logger } from "../../lib/logging/logger";
import { startsKeepingPolicy } from "../../lib/campaigns/breach-policy";
import { campaignGuardrailsOf } from "../../lib/campaigns/campaign-floors";
import { readSettings } from "../settings.server";
import { recordRecapturedAtSale } from "./recaptured.server";

export interface TransitionResult {
  changed: boolean;
  from: CampaignState;
  to: CampaignState;
}

export interface TransitionOptions {
  /** Why, for the audit trail. "scheduler: window opened", "merchant clicked resume". */
  reason: string;
  /**
   * Who moved it: `actorFor(...)` for a person, `SCHEDULER_ACTOR` for the scheduler,
   * `FLOW_ACTOR` for Flow (#746). Required: a missing actor used to default to "system",
   * which Activity shows as the Scheduler, so every Apply pressed by hand read as the
   * Scheduler's doing.
   */
  actor: string;
  runId?: string;
  /** Skip the audit entry when the last one gave this same reason (`releaseClaim` only). */
  quietIfRepeated?: boolean;
}

/**
 * Moves a campaign to `to`, if that is legal from where it currently is.
 *
 * Returns `changed: false` rather than throwing when the campaign has already moved
 * on -- a duplicate tick is expected, not exceptional. Throws only when the requested
 * transition is illegal from the *current* state, which is a bug worth surfacing.
 */
export async function transitionCampaign(
  shopId: string,
  campaignId: string,
  to: CampaignState,
  options: TransitionOptions,
): Promise<TransitionResult> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    // And its guardrails, whose own policy is the one it keeps as it starts (#816).
    select: { status: true, guardrails: true },
  });

  const from = campaign.status as CampaignState;

  if (from === to) {
    // Already there. Idempotent by design: see the note about duplicate ticks in
    // lib/lifecycle/transitions.ts.
    return { changed: false, from, to };
  }

  if (!canTransition(from, to)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: `This campaign is ${describeState(from).label.toLowerCase()}, so that action does not apply to it. Reload the page to see its current state.`,
      context: { campaignId, from, to, reason: options.reason },
    });
  }

  // Conditional on `from`, so a concurrent transition cannot be clobbered: whoever
  // reads the old state first wins, and the other sees changed: false.
  const updated = await prisma.campaign.updateMany({
    where: { id: campaignId, shopId, status: from },
    data: { status: to, ...(await keptPolicy(shopId, from, to, campaign.guardrails)) },
  });

  if (updated.count === 0) return { changed: false, from, to };

  await recordTransition(shopId, campaignId, from, to, options);

  // Into Active, its count of baselines recaptured at its sale price is taken again (#1166):
  // the list, Home and the calendar read it, and an apply changes it -- one after a revert
  // starts its writes afresh, from baselines captured before them. Never throws.
  if (to === "ACTIVE") await recordRecapturedAtSale(shopId, [campaignId]);

  return { changed: true, from, to };
}

/**
 * What a campaign starting keeps (#789): the store's floor-breach policy as it is now, which it
 * was previewed with and its run plans with, written with the move that starts it. Until then
 * it follows the store's setting, and from then on it keeps this one while its prices may be up,
 * so changing the setting does not change what it does to prices already on a storefront. Every
 * move into a state with prices live comes through `transitionCampaign` or `claimForSchedule`.
 * A campaign that chose its own keeps that one instead, as it has since it was saved (#816).
 */
async function keptPolicy(shopId: string, from: CampaignState, to: CampaignState, guardrails: unknown) {
  if (!startsKeepingPolicy(from, to)) return {};
  const own = campaignGuardrailsOf(guardrails).violationPolicy;
  return { guardrailViolationPolicy: own ?? (await readSettings(shopId)).violationPolicy };
}

/** The two states that mean "a run has claimed this campaign and may be writing". */
const CLAIM_STATES: ReadonlySet<CampaignState> = new Set<CampaignState>(["APPLYING", "REVERTING"]);

/** What `releaseClaim` writes before its reason, so a release can be told from any other move. */
export const RELEASED = "claim released without running: ";

/** Where each scheduled transition takes a campaign from, and the claim it moves it to. */
const SCHEDULED_CLAIMS = {
  apply: { from: ["SCHEDULED"], to: "APPLYING", reason: "scheduled start" },
  revert: { from: ["ACTIVE", "PARTIAL", "HELD"], to: "REVERTING", reason: "scheduled end" },
} as const satisfies Record<string, { from: readonly CampaignState[]; to: CampaignState; reason: string }>;

export interface ScheduledClaim {
  from: CampaignState;
  to: CampaignState;
  /** The history's reason for it: "scheduled start", or "scheduled end, tried again". */
  reason: string;
  /** False for a retry, whose claim is recorded once its run is under way: see `recordClaim`. */
  recorded: boolean;
}

/**
 * Takes a campaign for the transition its schedule owes, and records it (#829).
 *
 * The claim used to be a bare conditional update in the scheduler, so the history never
 * said the scheduler had taken a campaign: at 100k variants it read "APPLYING → SCHEDULED,
 * claim released" at 17:40 and nothing more for an hour, while a second attempt was
 * applying the sale. The update is still conditional on the exact state that was read --
 * the claim two overlapping ticks race for -- so whoever loses changes nothing and records
 * nothing.
 *
 * A retry is recorded later, not here. A start or end that keeps being refused -- waiting
 * for approval, Shopify unreachable -- is claimed and given back every thirty seconds, and
 * its one release entry says why (`quietIfRepeated`); a claim entry before each would bury
 * it. So a claim whose last attempt was given back is recorded by the run once it is under
 * way (`recordClaim`), and one refused again leaves the history as it was.
 */
export async function claimForSchedule(
  shopId: string,
  campaignId: string,
  transition: keyof typeof SCHEDULED_CLAIMS,
  actor: string,
): Promise<ScheduledClaim | null> {
  const { from: claimable, to, reason } = SCHEDULED_CLAIMS[transition];
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId }, select: { status: true, guardrails: true } });
  const from = campaign?.status as CampaignState | undefined;
  if (!from || !(claimable as readonly CampaignState[]).includes(from)) return null;

  const claimed = await prisma.campaign.updateMany({
    where: { id: campaignId, shopId, status: from },
    data: { status: to, ...(await keptPolicy(shopId, from, to, campaign?.guardrails)) },
  });
  if (claimed.count === 0) return null; // someone else took it

  const last = await lastTransition(shopId, campaignId);
  const retry = last?.from === to && last.to === from && last.reason.startsWith(RELEASED);
  if (retry) return { from, to, reason: `${reason}, tried again`, recorded: false };

  await recordTransition(shopId, campaignId, from, to, { reason, actor });
  return { from, to, reason, recorded: true };
}

/** Records a scheduler's claim that `claimForSchedule` left for its run to record. */
export async function recordClaim(
  shopId: string,
  campaignId: string,
  claim: Pick<ScheduledClaim, "from" | "to" | "reason">,
  options: { actor: string; runId: string },
): Promise<void> {
  await recordTransition(shopId, campaignId, claim.from, claim.to, { reason: claim.reason, ...options });
}

/**
 * Puts a campaign back where it was when a run claimed it and then never started.
 *
 * `runCampaign` moves the campaign to APPLYING before it plans, so that an illegal
 * action is refused before a price moves. But planning can fail -- a guardrail blocks
 * the run, the catalogue is too large for one statement, the shop's session expired --
 * and until this existed, every one of those left the campaign claiming to be applying
 * forever. `PRICES_MAY_BE_LIVE` includes APPLYING, so the whole app then believed the
 * storefront might be carrying this campaign's prices when the ledger was empty. Revert
 * was refused (APPLYING -> REVERTING is not a legal edge) and the merchant's only way
 * out was to press apply again, which is the one action that sounds most dangerous.
 *
 * The guardrail case is not exotic: `planRun` returning `blocked` *throws*, so a floor
 * price doing exactly its job stranded the campaign every single time.
 *
 * This is deliberately not `transitionCampaign`. APPLYING -> DRAFT is not a legal
 * transition and should not become one: it is not the campaign progressing, it is a
 * claim being given back, and the difference matters when reading an audit trail six
 * months later. Adding those edges to the state machine would also let any caller move
 * a genuinely-running campaign back to DRAFT, which is precisely the corruption the
 * machine exists to prevent.
 *
 * Refuses when the campaign is not in a claim state, or when a run is still executing,
 * because in either case something may have been written and the honest answer is
 * PARTIAL rather than "nothing happened".
 */
export async function releaseClaim(
  shopId: string,
  campaignId: string,
  to: CampaignState,
  options: TransitionOptions,
): Promise<TransitionResult> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
    select: { status: true },
  });

  const from = campaign.status as CampaignState;

  // Someone else already moved it on -- a concurrent run finishing, a cancel. Their
  // state is newer than ours and must not be clobbered.
  if (!CLAIM_STATES.has(from)) return { changed: false, from, to };

  // Full runs only. A run over named variants never holds the claim, so one in flight is
  // no reason to keep a claim nobody is using -- and a full run standing down for one has
  // to be able to give its claim back (#763).
  const executing = await prisma.campaignRun.count({
    where: {
      campaignId,
      status: { in: ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"] },
      NOT: { occurrenceKey: { startsWith: "VARIANT-" } },
    },
  });
  if (executing > 0) {
    // A run is live. Releasing now would tell the merchant nothing is happening while
    // prices are being written, which is worse than the stuck state this fixes.
    logger.info("campaign claim not released, a run is still live", {
      campaignId,
      from,
      executing,
    });
    return { changed: false, from, to };
  }

  const updated = await prisma.campaign.updateMany({
    where: { id: campaignId, shopId, status: from },
    data: { status: to },
  });

  if (updated.count === 0) return { changed: false, from, to };

  const reason = `${RELEASED}${options.reason}`;
  if (!(options.quietIfRepeated && (await lastTransitionReason(shopId, campaignId)) === reason)) {
    await recordTransition(shopId, campaignId, from, to, { ...options, reason });
  }

  return { changed: true, from, to };
}

/**
 * Records why a campaign could not move, without moving it.
 *
 * For a scheduled transition the scheduler could not even attempt -- no usable session,
 * because the store revoked Anchor's access -- the campaign stays where it is, and the
 * only other trace was a line in a tick log nobody reads (#707). Written once per reason,
 * however many ticks hit the same wall.
 *
 * Also a run that is waiting rather than moving (#1054): its actor and run id, when given,
 * are the run's, so the entry says whose run it is and which one.
 */
export async function noteCampaign(
  shopId: string,
  campaignId: string,
  reason: string,
  by: { actor?: string; runId?: string } = {},
): Promise<void> {
  if ((await lastTransitionReason(shopId, campaignId)) === reason) return;
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { status: true },
  });
  if (!campaign) return;
  const status = campaign.status as CampaignState;
  // The scheduler, when it notes a campaign it could not move (#707).
  await recordTransition(shopId, campaignId, status, status, { reason, actor: by.actor ?? SCHEDULER_ACTOR, runId: by.runId });
}

/** The reason on this campaign's most recent recorded transition. */
async function lastTransitionReason(shopId: string, campaignId: string): Promise<string | undefined> {
  return (await lastTransition(shopId, campaignId))?.reason;
}

/** This campaign's most recent recorded transition: from, to and why. */
async function lastTransition(
  shopId: string,
  campaignId: string,
): Promise<{ from?: string; to?: string; reason: string } | null> {
  const last = await prisma.auditLogEntry.findFirst({
    where: { shopId, entity: "Campaign", entityId: campaignId, action: "campaign.transition" },
    orderBy: { createdAt: "desc" },
    select: { before: true, after: true },
  });
  if (!last) return null;
  const before = last.before as { status?: string } | null;
  const after = last.after as { status?: string; reason?: string } | null;
  return { from: before?.status, to: after?.status, reason: after?.reason ?? "" };
}

/**
 * Records the move.
 *
 * Deliberately after the update and deliberately not fatal: losing the audit row is
 * bad, but failing the transition because its bookkeeping failed would leave the
 * campaign stuck mid-run, which is worse.
 */
async function recordTransition(
  shopId: string,
  campaignId: string,
  from: CampaignState,
  to: CampaignState,
  options: TransitionOptions,
): Promise<void> {
  logger.info("campaign transition", {
    campaignId,
    from,
    to,
    reason: options.reason,
    runId: options.runId,
  });

  try {
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: options.actor,
        action: "campaign.transition",
        entity: "Campaign",
        entityId: campaignId,
        before: { status: from } as never,
        after: { status: to, reason: options.reason, runId: options.runId } as never,
      },
    });
  } catch (error) {
    logger.warn("could not record campaign transition", {
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The state history of one campaign, newest first, for the detail page. */
export async function transitionHistory(shopId: string, campaignId: string, limit = 20) {
  const entries = await prisma.auditLogEntry.findMany({
    where: { shopId, action: "campaign.transition", entityId: campaignId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return entries.map((entry) => {
    const before = entry.before as { status?: string } | null;
    const after = entry.after as { status?: string; reason?: string } | null;
    return {
      at: entry.createdAt.toISOString(),
      from: (before?.status ?? "—") as string,
      to: (after?.status ?? "—") as string,
      reason: after?.reason ?? "",
      actor: entry.actor ?? "system",
    };
  });
}

/**
 * Puts a campaign on hold because a price it controls was edited elsewhere.
 *
 * Held rather than "keep writing": overwriting would undo a deliberate human
 * decision, and the merchant is the one who should choose which price wins.
 */
export async function holdForDrift(
  shopId: string,
  campaignId: string,
  variantGid: string,
): Promise<TransitionResult | null> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { status: true },
  });
  if (!campaign) return null;

  // Only a running campaign can be held. Holding one that already finished would
  // raise an alarm about a price nobody is maintaining any more.
  if (campaign.status !== "ACTIVE" && campaign.status !== "PARTIAL") return null;

  // The variant by name, as the campaign's history shows it (#759): the reason printed the
  // raw Admin GID, which names nothing a merchant can find.
  const variant = await prisma.variantIndex.findFirst({
    where: { shopId, variantGid },
    select: { title: true },
  });
  const result = await transitionCampaign(shopId, campaignId, "HELD", {
    reason: `price edited outside Anchor on ${variant?.title ?? "a variant it prices"}`,
    actor: "drift-detector",
  });

  // The Flow trigger the help centre calls the one worth setting up (#711). It was
  // published and declared, and nothing fired it, so "when a campaign is held, message the
  // team" was a workflow that never ran. Fired only when this call held the campaign, and
  // not awaited: it is an Admin API call, and this runs inside a products webhook that has
  // to answer quickly. Best-effort, as every trigger is.
  if (result.changed) void announceHold(shopId, campaignId);

  return result;
}

async function announceHold(shopId: string, campaignId: string): Promise<void> {
  try {
    const [campaign, drifted] = await Promise.all([
      prisma.campaign.findUnique({ where: { id: campaignId }, select: { name: true } }),
      prisma.driftEvent.findMany({
        where: { shopId, campaignId, resolution: "PENDING" },
        distinct: ["variantGid"],
        select: { variantGid: true },
      }),
    ]);
    // Products, as the field says: a product edited on three variants is one product.
    const products = await prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: drifted.map((event) => event.variantGid) } },
      distinct: ["productGid"],
      select: { productGid: true },
    });
    const { fireTriggerForShop } = await import("../flow.server");
    await fireTriggerForShop(shopId, "campaign-held", {
      "campaign id": campaignId,
      "campaign name": campaign?.name ?? "",
      // A string, as the manifest declares: a number makes Flow refuse the whole trigger.
      "products drifted": String(products.length),
    });
  } catch (error) {
    logger.info("could not fire the campaign-held trigger", {
      shopId,
      campaignId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Lets a held campaign run again once nothing holds it (#756).
 *
 * The merchant resolves the drift from the queue -- puts the price back, keeps the
 * change, or leaves it -- and that decision is what the hold was waiting for. Nothing
 * released it: the campaign stayed HELD for good, and the scheduler, which only looks at
 * running campaigns, never ended it either.
 *
 * Back to the state it was held from, read from the transition that held it: a campaign
 * that was PARTIAL before somebody edited one of its prices still has rows to resume.
 */
export async function releaseHold(
  shopId: string,
  campaignId: string,
  actor: string,
): Promise<TransitionResult | null> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { status: true },
  });
  if (campaign?.status !== "HELD") return null;

  const pending = await prisma.driftEvent.count({
    where: { shopId, campaignId, resolution: "PENDING" },
  });
  if (pending > 0) return null;

  const held = await prisma.auditLogEntry.findFirst({
    where: {
      shopId,
      action: "campaign.transition",
      entityId: campaignId,
      after: { path: ["status"], equals: "HELD" },
    },
    orderBy: { createdAt: "desc" },
    select: { before: true },
  });
  const from = (held?.before as { status?: string } | null)?.status;

  return transitionCampaign(shopId, campaignId, from === "PARTIAL" ? "PARTIAL" : "ACTIVE", {
    reason: "price drift resolved",
    actor,
  });
}
