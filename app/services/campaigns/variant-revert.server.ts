/**
 * Reverting one variant out of a running campaign.
 *
 * The case this exists for: a merchant puts 4,000 products on sale, then notices that
 * three of them should not have been. The alternatives without this are all bad --
 * revert the whole campaign and reapply it with a narrower filter, or edit the price
 * by hand in Shopify and have the next run overwrite it. Both are how a merchant ends
 * up not trusting the app to leave their prices alone.
 *
 * Two halves, and both are needed:
 *
 *   The exclusion is durable. Written to the campaign before anything is priced, so
 *   the next scheduled run, the next auto-enroll and the next recurrence all leave
 *   the variant alone. A revert that only fixed today's price would be undone by
 *   tonight's tick, which is worse than not offering it.
 *
 *   The price is recomputed, not restored. `resolve(without this campaign, for this
 *   variant)` -- so a variant pulled out of a 30% sale that also sits in a 10% one
 *   lands on 10%. Restoring a saved number would quietly end a sale the merchant
 *   never ended.
 *
 * It runs through the ordinary planner, executor and verifier. A separate write path
 * for "just one variant" would be a second implementation of the ledger, free to
 * disagree with the first about what happened.
 */

import prisma from "../../db.server";
import { AppError } from "../../lib/errors/app-error";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { priceListLabel } from "../../lib/markets/display-name";
import { runCampaign } from "./run.server";
import type { RunOutcome } from "./types";
import { isLanded, LANDED } from "../../lib/execution/landed";

export interface VariantRevertOptions {
  actor?: string;
  /**
   * Record the exclusion but write nothing.
   *
   * For the rollback report's "leave the merchant's edit": the campaign should stop
   * touching the variant, and the value currently on the storefront is the one the
   * merchant wants kept.
   */
  excludeOnly?: boolean;
}

export interface VariantRevertResult {
  /** Null when the variant was already excluded, or when nothing needed writing. */
  outcome: RunOutcome | null;
  /** False when this variant was already excluded from the campaign. */
  changed: boolean;
  message: string;
}

export async function revertVariant(
  shopId: string,
  campaignId: string,
  variantGid: string,
  client: AdminClient,
  options: VariantRevertOptions = {},
): Promise<VariantRevertResult> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { id: true, name: true, excludedVariantGids: true },
  });

  if (!campaign) {
    throw new AppError({
      code: "NOT_FOUND",
      userMessage:
        "That campaign no longer exists, so there is nothing to revert this variant out of. Reload the page.",
      context: { campaignId, variantGid },
    });
  }

  const already = campaign.excludedVariantGids.includes(variantGid);

  if (!already) {
    // Before the write, always. If the exclusion failed to persist but the price was
    // already recomputed, the next run would put the campaign price straight back and
    // the merchant would watch their fix undo itself.
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { excludedVariantGids: { push: variantGid } },
    });

    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: options.actor ?? null,
        action: "campaign.variant.excluded",
        entity: "campaign",
        entityId: campaignId,
        after: { variantGid, excludeOnly: options.excludeOnly ?? false },
      },
    });
  }

  if (options.excludeOnly) {
    return {
      changed: !already,
      outcome: null,
      message: already
        ? `This variant was already excluded from "${campaign.name}". Its price is unchanged.`
        : `"${campaign.name}" will no longer price this variant. Its current price was left as it is.`,
    };
  }

  // Scoped to the one variant, but resolved against every campaign — so it lands
  // where full resolution would put it, including under a lower-priority campaign
  // that still covers it.
  // `revert: true` so the run is ledgered as a REVERT rather than an APPLY -- what
  // happened here is an undo, and a run history that calls it an apply is a run
  // history that misleads whoever reads it later. The campaign's own state is
  // untouched, because a scoped run says nothing about the other 3,999 variants.
  const outcome = await runCampaign(shopId, campaignId, client, {
    revert: true,
    variantGids: [variantGid],
    verifySampleRate: 1,
    occurrenceKey: `VARIANT-REVERT-${variantGid}-${Date.now()}`,
  });

  return {
    changed: !already,
    outcome,
    message: await describe(campaign.name, outcome, already),
  };
}

/**
 * What happened, surface by surface, from the run's own ledger.
 *
 * "Its price has been recomputed without it and verified" was true of the base price
 * only: markets were never touched, and the variant stayed on sale in every market
 * catalogue (#763). Named from the ledger rather than the outcome's counts, which are the
 * base surface's -- a variant already at its base price may still have had its markets
 * changed, and "nothing was written" would then be false.
 */
async function describe(campaignName: string, outcome: RunOutcome, already: boolean): Promise<string> {
  const prefix = already
    ? `This variant was already excluded from "${campaignName}".`
    : `"${campaignName}" will no longer price this variant.`;

  if (outcome.refused) return `${prefix} ${outcome.refused}`;

  const rows = outcome.runId
    ? await prisma.variantChange.findMany({
        where: { runId: outcome.runId, status: { in: [...LANDED, "FAILED", "APPLIED", "PENDING"] } },
        select: { surfaceKind: true, priceListGid: true, status: true },
      })
    : [];
  const lists = await prisma.priceListRecord.findMany({
    where: { priceListGid: { in: rows.map((row) => row.priceListGid).filter(Boolean) } },
    select: { priceListGid: true, name: true, currency: true, catalogTitle: true, surfaceKind: true },
  });
  const label = (row: { surfaceKind: string; priceListGid: string }) => {
    if (row.priceListGid === "") return "the base price";
    const list = lists.find((candidate) => candidate.priceListGid === row.priceListGid);
    return list ? `${priceListLabel(list)} (${list.currency})` : "a market";
  };
  const done = [...new Set(rows.filter((row) => isLanded(row.status)).map(label))];
  const notDone = [...new Set(rows.filter((row) => !isLanded(row.status)).map(label))];

  if (rows.length === 0) {
    // Nothing to write: the storefront already shows what resolution says it should.
    // Saying "0 variants updated" without this reads like a failure.
    return `${prefix} Its prices were already correct, so nothing was written.`;
  }

  const recomputed = done.length > 0 ? ` Recomputed without it and verified: ${joinNames(done)}.` : "";
  if (notDone.length > 0) {
    return (
      `${prefix}${recomputed} Not confirmed: ${joinNames(notDone)}. The exclusion is saved; ` +
      "press Revert this variant again to retry."
    );
  }
  return `${prefix}${recomputed}`;
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Puts a variant back into a campaign.
 *
 * The undo. Removing the exclusion is not enough on its own — the variant is now
 * sitting at a price the campaign disagrees with, so it is repriced in the same
 * scoped way it was let out.
 */
export async function reinstateVariant(
  shopId: string,
  campaignId: string,
  variantGid: string,
  client: AdminClient,
  options: { actor?: string } = {},
): Promise<VariantRevertResult> {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { name: true, excludedVariantGids: true },
  });

  if (!campaign) {
    throw new AppError({
      code: "NOT_FOUND",
      userMessage: "That campaign no longer exists. Reload the page.",
      context: { campaignId, variantGid },
    });
  }

  if (!campaign.excludedVariantGids.includes(variantGid)) {
    return {
      changed: false,
      outcome: null,
      message: `This variant is already part of "${campaign.name}".`,
    };
  }

  // `set`, not a pull: Prisma has no array-remove primitive, and read-modify-write on
  // the list we already hold is exact.
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      excludedVariantGids: {
        set: campaign.excludedVariantGids.filter((gid) => gid !== variantGid),
      },
    },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: options.actor ?? null,
      action: "campaign.variant.reinstated",
      entity: "campaign",
      entityId: campaignId,
      after: { variantGid },
    },
  });

  const outcome = await runCampaign(shopId, campaignId, client, {
    variantGids: [variantGid],
    verifySampleRate: 1,
    occurrenceKey: `VARIANT-REINSTATE-${variantGid}-${Date.now()}`,
  });

  return {
    changed: true,
    outcome,
    message:
      outcome.planned === 0
        ? `This variant is back in "${campaign.name}". Its price was already correct.`
        : `This variant is back in "${campaign.name}" and has been repriced.`,
  };
}
