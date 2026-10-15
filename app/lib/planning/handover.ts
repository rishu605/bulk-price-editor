/**
 * Which campaign a revert handed a variant to (#998).
 *
 * A revert writes `resolve(without C)` (rule 6), and where another campaign still covers
 * the variant that answer is the other campaign's price: B ends, and A's sale goes live on
 * the variants B was pricing over it. The write is ledgered under B's REVERT run, because
 * that is the run holding the claim (rule 2) and the row had to be committed before the
 * write (I4). Moving it under one of A's runs would break both. So the ledger never says
 * A prices the variant, and every reader that asked the ledger "whose price is this"
 * found nobody: a hand edit raised no drift event, and A's revert left the price behind
 * once the product had left A's scope.
 *
 * The answer is the planner's, as the revert itself reached it. Each variant is planned as
 * if live were what the revert wrote, and the campaign the plan leaves it with -- already
 * at its price, or holding a hand edit on it -- is the one that took it over. Preview and
 * execution share that code path (rule 4), so this cannot disagree with what a run of the
 * winner would do.
 *
 * A product that has left every scope since (archived, untagged) is asked again with the
 * scopes set aside, highest priority first: the campaign whose own rule prices it at what
 * the revert wrote. That is what lets the campaign's revert still take the price back.
 *
 * Pure: the caller loads the campaigns, candidates and what each revert wrote.
 */

import { money } from "../money/money";
import { compareCampaigns } from "../pricing/resolver";
import type { Guardrails, ResolvableCampaign } from "../pricing/types";
import { planRun } from "./plan";
import type { PlanCandidate } from "./types";

export interface HandoverInput {
  /**
   * Every campaign that may be pricing these variants now, each carrying its own scope
   * (`withScopes`). One without a scope covers every candidate, as in `planRun`.
   */
  campaigns: readonly ResolvableCampaign[];
  /** The handed-over variants' base surfaces, loaded as the planner loads them. */
  candidates: readonly PlanCandidate[];
  /** What the revert wrote for each variant, in minor units of the variant's currency. */
  handedOver: ReadonlyMap<string, number>;
  storeGuardrails?: Guardrails;
  /** Hand edits a campaign is holding, by variant: it keeps them until the merchant answers. */
  heldEdits?: ReadonlyMap<string, string>;
}

/** Variant gid -> the campaign whose price the revert wrote there. Absent: nobody's. */
export function inheritors(input: HandoverInput): Map<string, string> {
  const { campaigns, handedOver, storeGuardrails, heldEdits } = input;

  // As the revert left them: live is what it wrote, so "already at its price" means the
  // revert wrote this campaign's price.
  const asWritten = input.candidates.flatMap((candidate) => {
    const amount = handedOver.get(candidate.ref.variantGid);
    if (amount === undefined || candidate.ref.surfaceKind !== "base" || candidate.ref.priceListGid !== "") return [];
    return [{ ...candidate, livePrice: money(amount, candidate.ref.currency) }];
  });

  const found = new Map<string, string>();

  // The resolver's winner over the scopes as they are now, hand edits included.
  credit(found, asWritten, handedOver, (batch) => planRun({ campaigns: [...campaigns], candidates: batch, storeGuardrails, heldEdits }));

  // Left over: a variant no campaign's current scope accounts for. The revert priced it
  // while it was in scope; the product has left since. The highest-priority campaign whose
  // own rule gives exactly what was written, as the resolver would have ranked them.
  //
  // Never a baseline, though. A revert that put the baseline back handed the variant to
  // nobody, and a campaign covering none of it whose rule happens to land on that same
  // price -- an increase rounded back down to it -- would be held for every hand edit there.
  const ranked = [...campaigns].sort((a, b) => compareCampaigns(b, a));
  const unclaimed = asWritten.filter(
    (candidate) =>
      candidate.baseline.price.currency !== candidate.ref.currency ||
      candidate.baseline.price.amount !== handedOver.get(candidate.ref.variantGid),
  );
  for (const campaign of ranked) {
    const rest = unclaimed.filter((candidate) => !found.has(candidate.ref.variantGid));
    if (rest.length === 0) break;
    const unscoped: ResolvableCampaign = { ...campaign, scope: undefined };
    credit(found, rest, handedOver, (batch) => planRun({ campaigns: [unscoped], candidates: batch, storeGuardrails }), false);
  }

  return found;
}

/**
 * Credits each candidate the plan leaves at what the revert wrote to the campaign it
 * resolves to. One variant's blocking guardrail stops a whole plan, so a blocked batch
 * is planned again one variant at a time rather than answering nothing for all of them.
 */
function credit(
  found: Map<string, string>,
  candidates: readonly PlanCandidate[],
  handedOver: ReadonlyMap<string, number>,
  plan: (batch: PlanCandidate[]) => ReturnType<typeof planRun>,
  heldCounts = true,
): void {
  if (candidates.length === 0) return;
  const outcome = plan([...candidates]);
  if (outcome.kind === "blocked") {
    if (candidates.length > 1) for (const one of candidates) credit(found, [one], handedOver, plan, heldCounts);
    return;
  }

  for (const { ref, campaignId } of outcome.unchanged) {
    if (campaignId) found.set(ref.variantGid, campaignId);
  }
  for (const row of outcome.rows) {
    if (!row.campaignId) continue;
    // A campaign holding a hand edit on it keeps it until the merchant answers (#821).
    if (row.reason === "held-edit") {
      if (heldCounts) found.set(row.ref.variantGid, row.campaignId);
      continue;
    }
    // The same price with a different compare-at: the price is this campaign's.
    if (row.status !== "skipped" && row.intendedPrice?.amount === handedOver.get(row.ref.variantGid)) {
      found.set(row.ref.variantGid, row.campaignId);
    }
  }
}
