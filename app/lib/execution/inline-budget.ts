/**
 * How many variants one HTTP request can price before its connection is closed.
 *
 * `runCampaign` executes inline, so a campaign applied from the campaign page is written
 * by the web process during a single request. Railway's proxy closes a request after
 * five minutes with no data transferred, and a React Router action sends nothing until
 * it returns — so five minutes is the real ceiling, not the fifteen that applies to a
 * streaming response.
 *
 * Measured on `anchor-perf`: 62,535 variants took 109 seconds end to end, about 1.75ms
 * per variant. Five minutes therefore lands somewhere near 170,000 variants in one
 * campaign — not a hypothetical size for a product whose performance store exists at
 * 102,132 precisely because that is the scale it targets.
 *
 * **The failure it prevents is the bad kind.** Exceeding the ceiling does not cancel the
 * work. The proxy closes the connection while `runCampaign` carries on writing, so the
 * merchant sees an error and their storefront changes anyway — the one outcome this
 * product exists to prevent, arriving through a timeout nobody documented.
 *
 * So the limit is deliberately well under the ceiling rather than close to it. At
 * 120,000 the estimate is around three and a half minutes, which leaves room for a slow
 * shop, a throttled Admin API, and the fact that the per-variant figure came from one
 * store on one afternoon.
 *
 * Above the limit the answer is not "no" — it is "not from a button". The scheduler
 * runs campaigns in the worker, which has no request attached and no deadline, so a
 * scope this size is a scheduling question rather than a refusal.
 *
 * Checking costs a `variantIndex.count` before every inline apply. Measured on the same
 * store: 8ms for the 102,132-row catalogue, against a run of 109 seconds. The scope
 * columns are GIN-indexed, and the count the plan gate already needed is reused.
 */

import { formatCount } from "../format/display";

/** Milliseconds per variant, measured end to end including read-back verification. */
export const MS_PER_VARIANT = 1.75;

/** What Railway allows a request with no data transferred. */
export const REQUEST_CEILING_MS = 5 * 60 * 1000;

/**
 * The most a synchronous apply may attempt.
 *
 * Not `REQUEST_CEILING_MS / MS_PER_VARIANT`. That is the cliff; this is the guardrail,
 * and the distance between them is the point.
 */
export const MAX_INLINE_ROWS = 120_000;

/** Roughly how long a scope of this size will take, for a message a merchant can act on. */
export function estimateMinutes(rows: number): number {
  return Math.max(1, Math.round((rows * MS_PER_VARIANT) / 60_000));
}

/**
 * The refusal, or null when the scope fits.
 *
 * Names the number, the reason and the way forward — the error taxonomy requires all
 * three, and "too large" on its own leaves a merchant with a campaign they cannot run
 * and no idea what to do about it.
 */
export function refuseInline(rows: number, limit = MAX_INLINE_ROWS): string | null {
  if (rows <= limit) return null;

  return (
    `This campaign covers ${formatCount(rows)} variants, and applying it from ` +
    `here would take about ${estimateMinutes(rows)} minutes — longer than a browser ` +
    `request is allowed to run. It would be cut off partway through while still writing ` +
    `prices, which is worse than not starting. Schedule it instead: a scheduled campaign ` +
    `runs in the background with no time limit, and reports the same result when it finishes.`
  );
}
