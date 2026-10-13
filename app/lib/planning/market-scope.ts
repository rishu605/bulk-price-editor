/**
 * The variants a campaign's markets and tags are planned over: the ones it wins.
 *
 * Markets used to inherit the base surface's write set: only the variants whose base price
 * the run was about to change. The planner leaves a variant already at its base price out
 * of its rows altogether, so once the base was right Apply never looked at a market again
 * -- one skipped by a guardrail, one whose write failed, one added to a running campaign
 * -- and reported "all verified" while it stayed at full price (#841).
 *
 * Widening that to every variant in scope went too far (#937). A lower sale covers
 * variants a higher one wins; its run priced the market for them at the winner's price,
 * ledgered under itself, and ending it deleted those prices -- taking the higher sale off
 * the market while it was still running. A campaign answers for the variants it prices,
 * so this is exactly those: its own rows the plan did not set aside, and the variants
 * already at its price, which the planner reports as unchanged with their winner. Each
 * market still makes its own no-op check (the market planner's `alreadyCorrect`).
 *
 * Shared by the run and the preview, so the Markets card cannot describe a different set
 * of variants from the one the run prices.
 */

interface Row {
  ref: { variantGid: string };
  status: string;
  campaignId?: string;
}

interface Unchanged {
  ref: { variantGid: string };
  campaignId?: string;
}

export function marketScope(campaignId: string, rows: readonly Row[], unchanged: readonly Unchanged[]): string[] {
  return [
    ...new Set([
      ...rows.filter((row) => row.status !== "skipped" && row.campaignId === campaignId).map((row) => row.ref.variantGid),
      ...unchanged.filter((row) => row.campaignId === campaignId).map((row) => row.ref.variantGid),
    ]),
  ];
}
