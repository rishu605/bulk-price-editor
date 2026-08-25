/**
 * Choosing what to check, and deciding what the answer means.
 *
 * The mirror is a cache and Shopify is truth. Webhooks get missed, payloads arrive out
 * of order, bugs slip in — and without an independent check, mirror drift is invisible
 * until a merchant's campaign prices the wrong products. By then the trust is gone,
 * because "the app changed prices it should not have" is not a thing you explain your
 * way out of.
 *
 * Sampling rather than a full re-sync every night. Half a percent of a catalogue is
 * enough to detect *systematic* divergence cheaply, and a full re-sync is the response
 * to detection rather than the routine — a nightly full read of 500K variants would
 * spend a shop's entire rate-limit budget to confirm what a few hundred rows already
 * said.
 */

/** Fraction of the catalogue sampled each night. */
export const SAMPLE_RATE = 0.005;

/**
 * Floor on the sample size.
 *
 * Half a percent of a two-hundred-variant shop is one variant, which cannot distinguish
 * a healthy mirror from a broken one — a single mismatch would read as 100% divergence
 * and a single match as perfect. Five hundred is enough to make the rate mean something
 * on a small catalogue, and is nothing on a large one.
 */
export const MIN_SAMPLE = 500;

/** Divergence above this is systematic rather than incidental, and gets a response. */
export const ALERT_THRESHOLD = 0.005;

export function sampleSize(total: number): number {
  if (total <= 0) return 0;
  return Math.min(total, Math.max(MIN_SAMPLE, Math.ceil(total * SAMPLE_RATE)));
}

export interface MirrorRow {
  variantGid: string;
  price: bigint | null;
  compareAt: bigint | null;
}

export interface LiveRow {
  variantGid: string;
  price: bigint | null;
  compareAt: bigint | null;
  /** Absent from Shopify entirely — deleted since the mirror last saw it. */
  missing?: boolean;
}

export type DivergenceKind = "price" | "compare-at" | "deleted" | "unknown-to-shopify";

export interface Divergence {
  variantGid: string;
  kind: DivergenceKind;
  mirror: bigint | null;
  live: bigint | null;
}

export interface AuditVerdict {
  checked: number;
  diverged: number;
  /** Diverged over checked. The number the alert threshold is compared against. */
  rate: number;
  divergences: Divergence[];
  /** True when divergence is systematic enough to warrant a re-sync and an alert. */
  alert: boolean;
}

/**
 * Diffs a fresh read against the mirror.
 *
 * A variant Shopify no longer knows about counts as divergence rather than being
 * skipped. A mirror full of products that no longer exist will happily enroll them in a
 * campaign, where every row then fails — and a run reporting four hundred failures
 * nobody can act on is a run nobody reads.
 */
export function auditSample(
  mirror: readonly MirrorRow[],
  live: readonly LiveRow[],
  threshold = ALERT_THRESHOLD,
): AuditVerdict {
  const liveByGid = new Map(live.map((row) => [row.variantGid, row]));
  const divergences: Divergence[] = [];

  for (const row of mirror) {
    const fresh = liveByGid.get(row.variantGid);

    if (!fresh || fresh.missing) {
      divergences.push({
        variantGid: row.variantGid,
        kind: fresh ? "deleted" : "unknown-to-shopify",
        mirror: row.price,
        live: null,
      });
      continue;
    }

    if (fresh.price !== row.price) {
      divergences.push({
        variantGid: row.variantGid,
        kind: "price",
        mirror: row.price,
        live: fresh.price,
      });
      continue;
    }

    // Checked separately and second. A compare-at that has drifted matters less than a
    // price that has, and reporting only the first difference found would let a price
    // divergence hide behind a compare-at one on the same row.
    if (fresh.compareAt !== row.compareAt) {
      divergences.push({
        variantGid: row.variantGid,
        kind: "compare-at",
        mirror: row.compareAt,
        live: fresh.compareAt,
      });
    }
  }

  const checked = mirror.length;
  const rate = checked === 0 ? 0 : divergences.length / checked;

  return {
    checked,
    diverged: divergences.length,
    rate,
    divergences,
    // Strictly greater than: a threshold of exactly 0.5% should not fire at exactly
    // 0.5%, or every shop sitting on the line alerts every night and the alert stops
    // meaning anything.
    alert: checked > 0 && rate > threshold,
  };
}
