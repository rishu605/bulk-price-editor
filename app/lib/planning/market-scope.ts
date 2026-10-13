/**
 * The variants a campaign's markets are planned over (#841).
 *
 * Markets used to inherit the base surface's write set: only the variants whose base price
 * the run was about to change. The planner leaves a variant already at its base price out
 * of its rows altogether, so once the base was right Apply never looked at a market again
 * -- one skipped by a guardrail, one whose write failed, one added to a running campaign
 * -- and reported "all verified" while it stayed at full price.
 *
 * So a market gets every variant in the campaign's scope, and makes its own no-op check
 * (the market planner's `alreadyCorrect`): a market already at the campaign's prices costs
 * reads, not writes. The one thing still inherited is a deliberate skip. A variant the plan
 * set aside for a reason -- a hand edit held for the merchant, a baseline it cannot use --
 * is left alone on every surface, as it always was.
 *
 * Shared by the run and the preview, so the Markets card cannot describe a different set
 * of variants from the one the run prices.
 */

interface Candidate {
  ref: { variantGid: string };
}

interface Row {
  ref: { variantGid: string };
  status: string;
}

export function marketScope(candidates: readonly Candidate[], rows: readonly Row[]): string[] {
  const setAside = new Set(rows.filter((row) => row.status === "skipped").map((row) => row.ref.variantGid));
  return [...new Set(candidates.map((candidate) => candidate.ref.variantGid))].filter((gid) => !setAside.has(gid));
}
