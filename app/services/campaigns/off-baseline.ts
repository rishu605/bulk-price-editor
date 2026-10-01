import type { PlanCandidate, PlannedRow } from "../../lib/planning/types";

/**
 * The base-price rows whose live price is not their baseline, from what a plan already
 * holds: the row's `beforePrice` is the live price and the candidate carries the baseline.
 * A row with no live price on record is not counted -- there is nothing to compare.
 */
export function offBaseline(
  rows: readonly Pick<PlannedRow, "ref" | "beforePrice">[],
  candidates: readonly Pick<PlanCandidate, "ref" | "baseline">[],
): string[] {
  const baselineOf = new Map(
    candidates
      .filter((candidate) => candidate.ref.priceListGid === "")
      .map((candidate) => [candidate.ref.variantGid, candidate.baseline.price]),
  );

  return rows
    .filter((row) => {
      if (row.ref.priceListGid !== "" || !row.beforePrice) return false;
      const baseline = baselineOf.get(row.ref.variantGid);
      return !!baseline && baseline.amount !== row.beforePrice.amount;
    })
    .map((row) => row.ref.variantGid);
}
