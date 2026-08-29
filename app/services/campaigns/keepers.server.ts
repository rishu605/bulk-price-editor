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
  preview: Pick<CampaignPreview, "counts" | "rows">,
  revertingCampaignId: string,
  names: Map<string, string> = new Map(),
): KeepersAfterRevert {
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
