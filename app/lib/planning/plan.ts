/**
 * The run planner's pure core.
 *
 * For each enrolled variant × surface it resolves the intended state, diffs it
 * against the mirrored live values, and emits a ledger row where they differ.
 *
 * Two properties matter more than anything else here:
 *
 *   Write-ahead. Rows are materialised BEFORE any Admin API call (invariant I4). If
 *   the worker dies between writing the row and calling the API, verification finds
 *   an unverified row and retries. The other order would change a merchant's
 *   storefront with no record that we did it — unrecoverable, and precisely how
 *   competitors end up unable to explain what happened.
 *
 *   No-ops are skipped. If the live value already equals the intended value there is
 *   nothing to write. On a recurring campaign over a large catalogue, most rows are
 *   no-ops on the second and subsequent runs; writing them anyway would multiply the
 *   API cost of every recurrence for no benefit.
 */

import { equals, type Money } from "../money/money";
import { resolve } from "../pricing/resolver";
import type { Resolution } from "../pricing/types";
import type {
  PlanCandidate,
  PlanCounts,
  PlanInput,
  PlanOutcome,
  PlannedRow,
} from "./types";

/** Stable identity of one writable cell, matching the ledger's unique constraint. */
export function refKey(ref: {
  variantGid: string;
  surfaceKind: string;
  priceListGid: string;
}): string {
  return `${ref.variantGid}|${ref.surfaceKind}|${ref.priceListGid}`;
}

export function planRun(input: PlanInput): PlanOutcome {
  const { candidates, storeGuardrails, excludeCampaignId } = input;

  // Revert is resolution with the ending campaign removed, not a restore of saved
  // numbers (invariant I3).
  const campaigns = excludeCampaignId
    ? input.campaigns.filter((c) => c.id !== excludeCampaignId)
    : input.campaigns;

  const rows: PlannedRow[] = [];
  const counts: PlanCounts = { planned: 0, noop: 0, skipped: 0, clamped: 0 };

  // `variant_changes` is unique on (runId, variantGid, surfaceKind, priceListGid).
  // Two candidates for the same cell would violate that at INSERT, surfacing as an
  // opaque constraint error deep inside the write path. Upstream queries should
  // never produce duplicates, but collapsing them here makes the guarantee explicit
  // and keeps the failure mode out of the executor entirely. First occurrence wins,
  // so the result stays deterministic.
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const key = refKey(candidate.ref);
    if (seen.has(key)) continue;
    seen.add(key);

    const resolution = resolve({
      baseline: candidate.baseline,
      surface: {
        kind: candidate.ref.surfaceKind,
        priceListId: candidate.ref.priceListGid || undefined,
        currency: candidate.ref.currency,
      },
      // Callers pass campaigns already filtered to active, targeting this surface,
      // and with this variant enrolled -- matching the resolver's documented
      // contract. Enrollment in particular is pinned at plan time, so a product
      // tagged mid-campaign is not priced by a run that never planned for it, and
      // one untagged mid-campaign is still reverted (edge cases E5, E6). Those
      // decisions need the clock and the database, so they live in the caller.
      campaigns,
      storeGuardrails,
      variantSegmentIds: candidate.segmentIds,
    });

    // A blocking policy stops the whole run. Returning partial rows here would let
    // a caller write some of them, which is exactly what "block" must prevent.
    if (resolution.meta.outcome === "blocked") {
      return {
        kind: "blocked",
        reason: resolution.meta.reason ?? "below-floor",
        ref: candidate.ref,
        counts,
      };
    }

    if (resolution.meta.outcome === "skipped") {
      counts.skipped++;
      rows.push({
        ref: candidate.ref,
        beforePrice: candidate.livePrice,
        beforeCompareAt: candidate.liveCompareAt,
        intendedCompareAtSet: false,
        status: "skipped",
        reason: resolution.meta.reason,
        campaignId: resolution.meta.controlledBy,
      });
      continue;
    }

    if (isNoop(resolution, candidate)) {
      counts.noop++;
      continue;
    }

    const compareAtSet = resolution.compareAtPrice !== undefined;

    rows.push({
      ref: candidate.ref,
      beforePrice: candidate.livePrice,
      beforeCompareAt: candidate.liveCompareAt,
      intendedPrice: resolution.price,
      intendedCompareAt: compareAtSet ? resolution.compareAtPrice : undefined,
      intendedCompareAtSet: compareAtSet,
      status: resolution.meta.clamped ? "clamped" : "pending",
      reason: resolution.meta.clamped ? "below-floor" : undefined,
      campaignId: resolution.meta.controlledBy,
    });

    counts.planned++;
    if (resolution.meta.clamped) counts.clamped++;
  }

  return { kind: "ok", rows, counts };
}

/**
 * True when the storefront already shows the intended values.
 *
 * A missing live value is deliberately NOT treated as a match. We have no record of
 * what is live, so the safe assumption is that a write is needed — asserting the
 * intended value costs one API call, while wrongly skipping leaves a stale price up
 * for the length of a campaign.
 */
function isNoop(resolution: Resolution, candidate: PlanCandidate): boolean {
  if (!resolution.price) return false;
  if (!candidate.livePrice) return false;
  if (!equals(resolution.price, candidate.livePrice)) return false;

  // undefined means "leave compare-at alone", so price equality settles it.
  if (resolution.compareAtPrice === undefined) return true;

  // null means "clear it": a no-op only if there is nothing there already.
  if (resolution.compareAtPrice === null) return candidate.liveCompareAt === undefined;

  return (
    candidate.liveCompareAt !== undefined &&
    equals(resolution.compareAtPrice, candidate.liveCompareAt)
  );
}

/** Groups rows by product, since `productVariantsBulkUpdate` is a per-product call. */
export function groupByProduct<T extends { ref: { variantGid: string } }>(
  rows: T[],
  productOf: (variantGid: string) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const product = productOf(row.ref.variantGid);
    const existing = groups.get(product);
    if (existing) existing.push(row);
    else groups.set(product, [row]);
  }
  return groups;
}

/** Rows that still need writing, for planning a resume (edge case E2). */
export function rowsNeedingWrite(rows: PlannedRow[]): PlannedRow[] {
  return rows.filter((r) => r.status !== "skipped");
}

/** Convenience for previews: the net change a row represents. */
export function priceDelta(row: PlannedRow): Money | undefined {
  if (!row.intendedPrice || !row.beforePrice) return undefined;
  return {
    amount: row.intendedPrice.amount - row.beforePrice.amount,
    currency: row.intendedPrice.currency,
  };
}
