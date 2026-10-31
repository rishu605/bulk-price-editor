/**
 * The typed confirmation for a start nobody is watching, checked on the server (#1009).
 *
 * The Apply button asks for "apply" over the store's thresholds (#818). The scheduler and
 * Flow cannot ask, so the word is asked when their start is decided -- dates saved in the
 * editor or on the campaign page, or the campaign confirmed for Flow on its page -- and kept
 * with the campaign. The start then checks the campaign as it is against what was confirmed.
 *
 * `startCheck` is that check, at save and at start alike (rule 4). At save it plans the
 * campaign the way the run does: the same context, candidates and planner, over the row as
 * stored, or as it is about to be stored. At start it reads the run's own plan, so what is
 * checked is exactly what would be written. Either way the plan's reach is read by the Apply
 * dialog's `blastRadiusOf`, and "is it covered" is decided by `unconfirmedStart`.
 */

import prisma from "../../db.server";
import { FLOW_ACTOR, SCHEDULER_ACTOR } from "../../lib/audit/actor";
import {
  asksForConfirmation,
  confirmationReasons,
  confirmThresholdsOf,
  typedTheWord,
  type BlastRadius,
} from "../../lib/campaigns/blast-radius";
import {
  confirmationOf,
  confirmedReach,
  startConfirmationOf,
  unconfirmedStart,
  withStartConfirmed,
  type StartConfirmation,
} from "../../lib/campaigns/start-confirmation";
import { AppError } from "../../lib/errors/app-error";
import { planRun } from "../../lib/planning/plan";
import type { PlanCandidate, PlannedRow, PlanUnchanged } from "../../lib/planning/types";
import type { ResolvableCampaign } from "../../lib/pricing/types";
import { guardrailsFor, readSettings } from "../settings.server";
import { loadCandidates, withWritten } from "./candidates.server";
import { campaignContext, importIdsOf, isPractice, type PlannableCampaign } from "./model.server";
import { blastRadiusOf } from "./preview.server";

/** An apply's plan, as far as the check reads it. */
export interface StartPlan {
  rows: readonly PlannedRow[];
  counts: { planned: number; clampedToMinimum: number };
  candidates: readonly PlanCandidate[];
  /** The variants already at its price, whose markets the apply prices too (#1166): see `blastRadiusOf`. */
  unchanged?: readonly PlanUnchanged[];
  /** The campaigns it was planned with, so its market prices' depth is counted too (#1171). */
  campaigns: readonly ResolvableCampaign[];
}

export interface StartCheck {
  /** How far it reaches; null when a blocking guardrail stops the plan, which refuses the start itself. */
  radius: BlastRadius | null;
  /** Why it cannot start with nobody there unless the word is typed now; null when it can. */
  unconfirmed: string | null;
}

/**
 * An apply of this campaign planned as the run plans one, or null when a guardrail blocks it.
 *
 * The run's own lines for an apply: its context, its candidates with nothing written to add,
 * and the planner with nothing excluded.
 */
async function planApply(shopId: string, campaign: PlannableCampaign): Promise<StartPlan | null> {
  const { resolvable, heldEdits, ast } = await campaignContext(shopId, campaign);
  const importIds = importIdsOf(resolvable);
  const [scoped, storeGuardrails] = await Promise.all([loadCandidates(shopId, ast, undefined, importIds), guardrailsFor(shopId)]);
  const candidates = await withWritten(shopId, scoped, [], importIds);
  const outcome = planRun({ campaigns: resolvable, candidates, storeGuardrails, heldEdits, campaignId: campaign.id });
  return outcome.kind === "ok"
    ? { rows: outcome.rows, counts: outcome.counts, candidates, unchanged: outcome.unchanged, campaigns: resolvable }
    : null;
}

/**
 * The one check, at save and at start: how far this campaign reaches, and whether the
 * confirmation stored with it covers that. `plan` is the run's own, when the run asks.
 */
export async function startCheck(shopId: string, campaign: PlannableCampaign, plan?: StartPlan): Promise<StartCheck> {
  const planned = plan ?? (await planApply(shopId, campaign));
  if (!planned) return { radius: null, unconfirmed: null };

  const thresholds = confirmThresholdsOf(await readSettings(shopId));
  const radius = await blastRadiusOf(shopId, planned.rows, planned.counts, planned.candidates, thresholds, new Map(), {
    campaignId: campaign.id,
    unchanged: planned.unchanged,
    campaigns: planned.campaigns,
  });
  return { radius, unconfirmed: unconfirmedStart(radius, startConfirmationOf(campaign.schedule)) };
}

/**
 * Refuses a start by the scheduler or Flow that needs the word and is not covered by the
 * confirmation stored with the campaign. The run calls it with its own plan, before its run
 * row exists: a VALIDATION refusal there is #975's "refused for good" for a scheduled start --
 * recorded on the campaign and emailed once, and not claimed again -- and a 4xx to Flow.
 *
 * A Flow start too large to run inside Flow's ten seconds -- nearly every one -- is checked
 * before it is handed to the worker, with a plan made here, so Flow hears the refusal rather
 * than "queued". One plan of the largest catalogue measured takes about three seconds.
 */
export async function refuseUnconfirmedStart(
  shopId: string,
  campaign: PlannableCampaign,
  actor: string,
  plan?: StartPlan,
): Promise<void> {
  const { unconfirmed } = await startCheck(shopId, campaign, plan);
  if (!unconfirmed) return;

  throw new AppError({
    code: "VALIDATION",
    userMessage: `${unconfirmed} ${nextStep(actor)}`,
    context: { campaignId: campaign.id, unconfirmedStart: true },
  });
}

/**
 * Refuses an Apply pressed on the campaign page without "apply" typed, when this run's own
 * plan asks for it (#812).
 *
 * The press is checked before the run against the campaign's stored preview, which is what
 * the dialog showed -- and a stored number can be stale. A sale previewed at 10% off eight
 * variants, edited or re-scoped since, may plan 95% off two thousand: the dialog asked for
 * nothing and the stored preview said so. So the run checks again, on the plan that decides
 * what it writes, in the reading the dialog uses (`blastRadiusOf`), before its run row exists:
 * a refusal writes nothing. A stored number can make the press ask when it need not; it can
 * never be why the word was skipped.
 */
export async function refuseUntypedPress(shopId: string, campaignId: string, plan: StartPlan): Promise<void> {
  const thresholds = confirmThresholdsOf(await readSettings(shopId));
  const radius = await blastRadiusOf(shopId, plan.rows, plan.counts, plan.candidates, thresholds, new Map(), {
    campaignId,
    unchanged: plan.unchanged,
    campaigns: plan.campaigns,
  });
  if (!asksForConfirmation(radius)) return;

  throw new AppError({
    code: "VALIDATION",
    // The dialog's own sentences, as the press refuses with them (#818): no prices, only
    // counts, percentages and a title.
    userMessage:
      `${confirmationReasons(radius).join(" ")} The preview this was pressed over said less, because it was worked ` +
      "out before something changed, so nothing was written. Type “apply” in the confirmation box to run it.",
    context: { campaignId, untypedPress: true },
  });
}

/** What to do about a refused start, by who was starting it. */
function nextStep(actor: string): string {
  if (actor === FLOW_ACTOR) {
    return (
      "Shopify Flow cannot type “apply”, so nothing was written. Confirm the campaign as it is now under " +
      "“Scheduled and Flow starts” on its Overview tab, then run the Flow again."
    );
  }
  if (actor === SCHEDULER_ACTOR) {
    return "A scheduled start cannot ask anyone to type “apply”: move its dates and type it when asked, or apply it by hand.";
  }
  return "Type “apply” to confirm it as it is now.";
}

/** What saving a start decided. */
export type StartSave =
  /** It may start: nothing needed confirming, or the word was typed and `confirmation` is what to record. */
  | { ok: true; confirmation?: StartConfirmation }
  /** It needs the word, which was not typed. The reach is for the box that asks, and has prices in it. */
  | { ok: false; unconfirmed: string; radius: BlastRadius };

/**
 * The check when a start is saved: dates in the editor or on the campaign page, or a
 * confirmation for Flow. Asks for the word exactly when the start would be refused without
 * it; when it was typed, returns the confirmation to record with the campaign.
 */
export async function saveStart(
  shopId: string,
  campaign: PlannableCampaign,
  typed: string,
  actor: string,
): Promise<StartSave> {
  const { radius, unconfirmed } = await startCheck(shopId, campaign);
  if (!radius || !unconfirmed) return { ok: true };
  if (!typedTheWord(typed)) return { ok: false, unconfirmed, radius };
  return { ok: true, confirmation: confirmationOf(radius, actor, new Date()) };
}

/**
 * "Scheduled and Flow starts" on the campaign page: confirm a campaign as it is now, so the
 * scheduler and Flow may start it. The only way a campaign with no dates gets a confirmation,
 * which Flow needs; on a scheduled one it confirms the start without moving the dates.
 */
export async function confirmStart(
  shopId: string,
  campaignId: string,
  typed: string,
  actor: string,
): Promise<{ ok: boolean; message: string }> {
  const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId } });
  if (!campaign) {
    throw new AppError({ code: "NOT_FOUND", userMessage: "That campaign no longer exists. Reload the page." });
  }
  if (isPractice(campaign) || campaign.status === "CANCELLED") {
    return {
      ok: false,
      message: `"${campaign.name}" never starts, ${isPractice(campaign) ? "being practice" : "being cancelled"}, so there is nothing to confirm. Nothing was changed.`,
    };
  }

  const save = await saveStart(shopId, campaign, typed, actor);
  if (!save.ok) {
    return { ok: false, message: `${save.unconfirmed} Type “apply” in the box to confirm it as it is now. Nothing was changed.` };
  }
  if (!save.confirmation) {
    return {
      ok: true,
      message: `"${campaign.name}" needs no typed confirmation as it is now, so the schedule and Shopify Flow can already start it.`,
    };
  }

  await recordStartConfirmed(shopId, campaignId, save.confirmation);
  return {
    ok: true,
    message:
      `Confirmed. The schedule and Shopify Flow can start "${campaign.name}" while it reaches no further than ` +
      `this: ${confirmedReach(save.confirmation)}.`,
  };
}

/**
 * Keeps a confirmation with the campaign, replacing any earlier one, and logs who gave it.
 * The schedule is read again here, after the check's plan, so a change made meanwhile is kept.
 */
async function recordStartConfirmed(shopId: string, campaignId: string, confirmation: StartConfirmation): Promise<void> {
  const current = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { schedule: true } });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { schedule: withStartConfirmed(current.schedule, confirmation) as never },
  });
  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: confirmation.by,
      action: "campaign.start-confirmed",
      entity: "Campaign",
      entityId: campaignId,
      before: (startConfirmationOf(current.schedule) ?? {}) as never,
      after: confirmation as never,
    },
  });
}
