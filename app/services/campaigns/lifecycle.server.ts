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

import prisma from "../../db.server";
import {
  canTransition,
  describeState,
  type CampaignState,
} from "../../lib/lifecycle/transitions";
import { AppError } from "../../lib/errors/app-error";
import { logger } from "../../lib/logging/logger";

export interface TransitionResult {
  changed: boolean;
  from: CampaignState;
  to: CampaignState;
}

export interface TransitionOptions {
  /** Why, for the audit trail. "scheduler: window opened", "merchant clicked resume". */
  reason: string;
  actor?: string;
  runId?: string;
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
    select: { status: true },
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
    data: { status: to },
  });

  if (updated.count === 0) return { changed: false, from, to };

  await recordTransition(shopId, campaignId, from, to, options);

  return { changed: true, from, to };
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
        actor: options.actor ?? "system",
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

  return transitionCampaign(shopId, campaignId, "HELD", {
    reason: `price edited outside Anchor on ${variantGid}`,
    actor: "drift-detector",
  });
}
