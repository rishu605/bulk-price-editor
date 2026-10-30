import prisma from "../../db.server";
import { previewCampaign } from "./preview.server";
import type { CampaignPreview } from "./types";

/** A campaign that keeps some of the variants this one is giving up. */
export interface Keeper {
  campaignId: string;
  name: string;
  variants: number;
}

export interface KeepersAfterRevert {
  /** Prices that would be rewritten — the whole point of a revert being a recompute. */
  repriced: number;
  /** Campaigns still covering some of those variants, biggest first. */
  keepers: Keeper[];
  /**
   * Set when this is the last answer worked out and something it depends on has changed
   * since, or when there is none yet and one is being worked out (#812). The dialog says so
   * rather than "no other campaign covers these variants" over an answer it does not have.
   */
  recomputing?: boolean;
}

/**
 * Who keeps each variant once this campaign is reverted, worked out from a plan made with
 * the campaign excluded -- the resolver's answer rather than a guess assembled from
 * priorities. The Revert dialog asked for it as it opened (`app.revert-preview`); it is now
 * worked out with the rest of the campaign's stored plan, and the dialog reads that (#812).
 */
export async function keepersOf(shopId: string, campaignId: string): Promise<KeepersAfterRevert> {
  // `revert: true` plans with this campaign excluded, so every row that comes back is
  // owned by whoever keeps the variant afterwards.
  const preview = await previewCampaign(shopId, campaignId, { revert: true });

  // Names for whatever the plan says still owns rows. Fetched after the plan rather than
  // before it, so the query asks for the few campaigns that actually keep something
  // instead of every campaign the shop has.
  const owners = [
    ...new Set(preview.rows.map((row) => row.campaignId).filter((id): id is string => Boolean(id))),
  ].filter((id) => id !== campaignId);

  const named = await prisma.campaign.findMany({
    where: { shopId, id: { in: owners } },
    select: { id: true, name: true },
  });

  return keepersAfterRevert(preview, campaignId, new Map(named.map((campaign) => [campaign.id, campaign.name])));
}

/**
 * What a revert leaves behind.
 *
 * `docs/help/concepts/revert.md` makes the argument: a jacket at £100, a summer sale
 * taking it to £80, a clearance campaign taking it to £70 — end the summer sale and
 * restoring "what it was before" gives £100, while the right answer is £70, because
 * clearance is still running.
 *
 * This is that sentence with the merchant's own campaign names in it. The rows come from
 * a plan made with the campaign excluded, so a row's owner *is* who keeps the variant;
 * deriving it from priorities here would be a second implementation of the resolver.
 *
 * Rows carry an owner but not a name, so the caller passes the names it has and a keeper
 * whose name is unknown is reported rather than dropped — a merchant about to revert needs
 * the count to be right more than they need every name.
 */
export function keepersAfterRevert(
  preview: Pick<CampaignPreview, "counts" | "rows" | "overlaps">,
  revertingCampaignId: string,
  names: Map<string, string> = new Map(),
): KeepersAfterRevert {
  // From the planner's coverage when the preview has it (#821). The rows leave out every
  // variant already at its price, which is exactly a variant another campaign keeps, so a
  // sale entirely under a higher-priority one was told "no other campaign covers these
  // variants" by the dialog about to revert it.
  if (preview.overlaps) {
    return {
      repriced: preview.counts.planned,
      keepers: preview.overlaps
        .filter((overlap) => overlap.keeps > 0 && overlap.campaignId !== revertingCampaignId)
        .map((overlap) => ({
          campaignId: overlap.campaignId,
          name: names.get(overlap.campaignId) ?? overlap.name,
          variants: overlap.keeps,
        }))
        .sort((a, b) => b.variants - a.variants),
    };
  }

  const counts = new Map<string, number>();

  for (const row of preview.rows) {
    const owner = row.campaignId;
    if (!owner || owner === revertingCampaignId) continue;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }

  return {
    repriced: preview.counts.planned,
    keepers: [...counts.entries()]
      .map(([campaignId, variants]) => ({
        campaignId,
        name: names.get(campaignId) ?? "Another campaign",
        variants,
      }))
      .sort((a, b) => b.variants - a.variants),
  };
}
