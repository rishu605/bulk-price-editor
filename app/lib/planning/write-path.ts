/**
 * Choosing between the two write paths.
 *
 *   sync — `productVariantsBulkUpdate` called directly, grouped per product.
 *          Immediate, but every call spends rate-limit budget.
 *
 *   bulk — `bulkOperationRunMutation` with a staged JSONL upload. Costs **zero**
 *          rate-limit points, but carries real startup overhead (submit, queue,
 *          poll, download, parse) and is processed FIFO, so a busy queue can add
 *          minutes before the first row is touched.
 *
 * The crossover is around a thousand rows. Below it the bulk round-trip is slower
 * than simply making the calls; above it, bulk wins on every dimension — and given
 * the real budget is a 1,000-point bucket restoring at 50 points/second on standard
 * plans, large synchronous runs are not merely slow but infeasible.
 */

import type { WritePathDecision } from "./types";

export interface WritePathOptions {
  /** Row count above which bulk is used. Default 1,000 (`BULK_PATH_ROW_THRESHOLD`). */
  threshold?: number;
  /**
   * Points the shop's bucket restores per second, read from
   * `extensions.cost.throttleStatus`. Never hardcode a plan's limit — Advanced and
   * Plus restore at 100/s where standard restores at 50/s, and we do not know the
   * merchant's plan in advance.
   */
  restoreRatePerSecond?: number;
  /** Currently available points, likewise observed rather than assumed. */
  availablePoints?: number;
  /** Estimated cost of one mutation call. Shopify bills roughly 100 per variant. */
  estimatedCostPerCall?: number;
  /** Fraction of budget we allow ourselves, leaving headroom for other apps. */
  headroom?: number;
  /**
   * How long a synchronous run may reasonably take before bulk is preferable
   * regardless of row count. Default 60s.
   */
  maxSyncSeconds?: number;
}

export const DEFAULT_THRESHOLD = 1_000;
const DEFAULT_COST_PER_CALL = 100;
const DEFAULT_HEADROOM = 0.8;
const DEFAULT_MAX_SYNC_SECONDS = 60;

/**
 * Picks a write path.
 *
 * Two independent reasons to choose bulk: too many rows, or a synchronous run that
 * would not fit inside the shop's restore budget in reasonable time. The second
 * matters because row count alone is a poor proxy — the same 800 rows are fine on a
 * Plus store and painful on a throttled standard one.
 */
export function selectWritePath(
  rowCount: number,
  options: WritePathOptions = {},
): WritePathDecision {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  if (rowCount === 0) {
    return { path: "sync", rowCount, reason: "Nothing to write." };
  }

  if (rowCount > threshold) {
    return {
      path: "bulk",
      rowCount,
      reason:
        `${rowCount} rows exceeds the ${threshold}-row threshold; bulk operations ` +
        `carry no rate-limit cost.`,
    };
  }

  const restoreRate = options.restoreRatePerSecond;
  if (restoreRate && restoreRate > 0) {
    const costPerCall = options.estimatedCostPerCall ?? DEFAULT_COST_PER_CALL;
    const headroom = options.headroom ?? DEFAULT_HEADROOM;
    const maxSeconds = options.maxSyncSeconds ?? DEFAULT_MAX_SYNC_SECONDS;

    const totalCost = rowCount * costPerCall;
    const available = options.availablePoints ?? 0;
    const usableRate = restoreRate * headroom;
    const secondsNeeded = Math.max(0, totalCost - available) / usableRate;

    if (secondsNeeded > maxSeconds) {
      return {
        path: "bulk",
        rowCount,
        reason:
          `${rowCount} rows would need about ${Math.round(secondsNeeded)}s of ` +
          `rate-limit budget at ${restoreRate} points/s, past the ${maxSeconds}s ` +
          `ceiling for a synchronous run.`,
      };
    }
  }

  return {
    path: "sync",
    rowCount,
    reason:
      `${rowCount} rows is under the ${threshold}-row threshold and fits the ` +
      `available rate-limit budget; sync avoids bulk queue latency.`,
  };
}

/** Reads the threshold from the environment, falling back to the default. */
export function thresholdFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.BULK_PATH_ROW_THRESHOLD;
  if (!raw) return DEFAULT_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_THRESHOLD;
}
