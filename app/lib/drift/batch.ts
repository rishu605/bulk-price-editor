/**
 * Deciding many drifted prices at once (#822): what the queue is filtered to, what one
 * decision over the filtered set covers, and how its outcome reads.
 *
 * The queue offered one decision per row, fifteen rows at a time. A merchant's own bulk
 * edit, a CSV import in the Shopify admin or another app repricing during a sale is routine
 * volume, and 1,113 drifted prices were 1,113 clicks while the campaign stayed Held. Now the
 * queue filters by campaign, product and direction, and one confirmed decision covers
 * everything the filters match.
 *
 * Client-safe on purpose: the page renders these sentences, and the server, the export and
 * the worker read the same filters. A bulk decision that covered a different set from the
 * one on screen would be the worst bug available on a page whose only job is a considered
 * decision, so there is one parser and one description.
 */

import { formatCount } from "../format/display";

export const DRIFT_DIRECTIONS = ["up", "down"] as const;
export type DriftDirection = (typeof DRIFT_DIRECTIONS)[number];

/** The three decisions, as the service names them. */
export type DriftChoice = "adopt" | "reassert" | "ignore";
export const DRIFT_CHOICES: readonly DriftChoice[] = ["adopt", "reassert", "ignore"];

export interface DriftFilters {
  /** The campaign that set the price. */
  campaignId?: string;
  /** Product: the variant's title (product and variant), its SKU, or its id. */
  q?: string;
  /** Whether the edit raised or lowered the campaign's price. */
  direction?: DriftDirection;
}

/** What the filter form owns in the URL. Anything else there is left alone. */
export const DRIFT_FILTER_FIELDS = ["campaign", "q", "direction"] as const;

/** A search longer than this is not a product title anybody typed. */
const QUERY_LIMIT = 255;

export function driftFiltersFrom(params: URLSearchParams): DriftFilters {
  const q = params.get("q")?.trim();
  const direction = params.get("direction");
  return {
    campaignId: params.get("campaign") || undefined,
    q: q ? q.slice(0, QUERY_LIMIT) : undefined,
    // Against the two that exist: an unknown value filters nothing rather than everything.
    direction: (DRIFT_DIRECTIONS as readonly string[]).includes(direction ?? "")
      ? (direction as DriftDirection)
      : undefined,
  };
}

/** Whether anything narrows the queue. The campaign alone counts. */
export function isFiltered(filters: DriftFilters): boolean {
  return Boolean(filters.campaignId || filters.q || filters.direction);
}

/**
 * The product and direction filters in words, for the confirmation and the audit entry --
 * or null when neither narrows the set. The campaign is named separately, always.
 */
export function describeDriftFilters(filters: Pick<DriftFilters, "q" | "direction">): string | null {
  const parts = [
    filters.q ? `title, SKU or ID contains "${filters.q}"` : null,
    filters.direction === "up" ? "raised above the campaign's price" : null,
    filters.direction === "down" ? "lowered below the campaign's price" : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Past this many, keeping or leaving the set is the background worker's job rather than the
 * request's (#808), and the page follows it.
 *
 * Both are database work only -- a status per event, and for "keep" a baseline per variant --
 * and a thousand of them take well under a second. The line is drawn where a merchant
 * starts needing to see progress, not where a request would run out of time: the worker has
 * no request to outlive, and at 19,000 prices (#805) the page should say how far it has got
 * rather than spin. Putting prices back is decided by the time its writing takes instead
 * (`inline-budget.ts`), because that is a run.
 */
export const DRIFT_INLINE_ROWS = 1_000;

/**
 * A bulk decision handed to the worker, as the page's URL carries it while it follows the
 * work: what was chosen, for which campaign, over the prices the merchant saw at `asOf`, and
 * how many that was. The product and direction filters ride in the URL beside it.
 */
export interface BatchRef {
  resolution: DriftChoice;
  campaignId: string;
  /** When the page that confirmed it was loaded: an edit after this is not in the decision. */
  asOf: string;
  /** How many prices the confirmation named. */
  total: number;
}

export function formatBatchParam(ref: BatchRef): string {
  return [ref.resolution, new Date(ref.asOf).getTime(), ref.total, ref.campaignId].join(".");
}

export function batchParamFrom(value: string | null): BatchRef | null {
  const [resolution, millis, total, campaignId, ...rest] = (value ?? "").split(".");
  const at = Number(millis);
  const count = Number(total);
  if (rest.length > 0 || !campaignId || !Number.isFinite(at) || !Number.isInteger(count) || count < 0) return null;
  if (!DRIFT_CHOICES.includes(resolution as DriftChoice)) return null;
  return { resolution: resolution as DriftChoice, campaignId, asOf: new Date(at).toISOString(), total: count };
}

/**
 * What one bulk decision did, as its audit entry records it and the page reports it.
 *
 * Counts only. The prices are in the baselines it wrote and the run it made; the entry's
 * job is to say who decided what about which variants.
 */
export interface BatchSummary {
  resolution: DriftChoice;
  /** The campaign's name. */
  campaign: string;
  /** Prices this decision resolved. */
  resolved: number;
  /** "Keep": the storefront no longer shows the edit, so there was nothing to keep. */
  notKept?: number;
  /** "Put back": written, and Shopify did not confirm it. Still waiting. */
  notConfirmed?: number;
  /** "Put back": the storefront already showed the campaign's price. Counted in `resolved`. */
  unchanged?: number;
  /**
   * "Put back": the campaign has no price it can write for these -- they left its scope, or
   * its plan skips them -- so nothing was written and the edit is still live (#1042).
   * Still waiting.
   */
  notPriced?: number;
  /** Why it stopped short, or never started: a refusal, or a failure part-way. */
  stopped?: string;
  /** Drifted prices still waiting for this campaign afterwards. */
  stillWaiting: number;
  /** Whether nothing was left, so the campaign runs again. */
  released: boolean;
}

/** "1 price", "1,113 prices". */
export function prices(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "price" : "prices"}`;
}

/** The outcome in sentences: what happened, what did not and why, and what to do next. */
export function describeBatch(summary: BatchSummary): string {
  const name = `"${summary.campaign}"`;
  const sentences: string[] = [];

  if (summary.resolved > 0) {
    if (summary.resolution === "adopt") {
      sentences.push(
        `Kept ${summary.resolved === 1 ? "1 change" : `${formatCount(summary.resolved)} changes`} as the new baseline for ${name}. Future campaigns compute from ${summary.resolved === 1 ? "that price" : "those prices"}.`,
      );
    } else if (summary.resolution === "ignore") {
      sentences.push(`Left ${prices(summary.resolved)} for ${name} as they are, and closed their alerts.`);
    } else {
      const written = summary.resolved - (summary.unchanged ?? 0);
      if (written > 0) {
        sentences.push(`Put back ${prices(written)} for ${name}, in one run: written and read back.`);
      }
      if (summary.unchanged) {
        sentences.push(
          `${prices(summary.unchanged)} already showed the campaign's price, so nothing was written for ${summary.unchanged === 1 ? "it" : "them"}.`,
        );
      }
    }
  }

  if (summary.notKept) {
    sentences.push(
      `${prices(summary.notKept)} ${summary.notKept === 1 ? "wasn't" : "weren't"} kept: the storefront no longer shows the edit, so there is no change to keep. Choose Put it back or Leave it for now for ${summary.notKept === 1 ? "it" : "those"}.`,
    );
  }
  if (summary.notPriced) {
    const one = summary.notPriced === 1;
    sentences.push(
      `${prices(summary.notPriced)} ${one ? "wasn't" : "weren't"} put back: ${name} has no price it can write for ${one ? "it" : "them"} -- ` +
        `${one ? "it is" : "they are"} outside its products now, or its guardrails leave ${one ? "it" : "them"} alone -- so ` +
        `${one ? "it is" : "they are"} still waiting. Put it back on ${one ? "the price" : "each one"} says why; or keep or leave ${one ? "it" : "them"} instead.`,
    );
  }
  if (summary.notConfirmed) {
    sentences.push(
      `Shopify did not confirm ${prices(summary.notConfirmed)}, so ${summary.notConfirmed === 1 ? "it is" : "they are"} still waiting. The campaign's Ledger tab shows why; put ${summary.notConfirmed === 1 ? "it" : "them"} back again to retry.`,
    );
  }
  if (summary.stopped) {
    sentences.push(summary.resolved > 0 ? `Then it stopped: ${summary.stopped}` : summary.stopped);
  }

  if (sentences.length === 0) {
    // A second copy of a decision, or one whose prices were all decided elsewhere first.
    sentences.push(`None of these prices for ${name} were waiting any more: they were resolved after the page loaded. Nothing was changed.`);
  }

  if (summary.released) {
    sentences.push(`Nothing else was waiting, so ${name} is running again.`);
  } else if (summary.stillWaiting > 0) {
    sentences.push(`${prices(summary.stillWaiting)} still ${summary.stillWaiting === 1 ? "waits" : "wait"} for a decision on ${name}.`);
  }

  return sentences.join(" ");
}

/** The verb phrase a decision is said with while it runs: "Keeping 1,113 changes". */
export function doing(resolution: DriftChoice, count: number): string {
  if (resolution === "adopt") return `Keeping ${count === 1 ? "1 change" : `${formatCount(count)} changes`}`;
  if (resolution === "ignore") return `Leaving ${prices(count)} as they are`;
  return `Putting back ${prices(count)}`;
}

/** A queued decision, while the worker has it. */
export interface BatchProgress {
  /** Prices the decision has resolved so far. */
  done: number;
  /** "Put back": prices its run has written and read back so far, once it has started. */
  written: number | null;
  /** "Put back": whether the run has started. */
  started: boolean;
}

export function describeProgress(ref: BatchRef, campaign: string, progress: BatchProgress): string {
  const head = `${doing(ref.resolution, ref.total)} for "${campaign}" in the background.`;
  const tail = "You can leave this page; it updates as they are done.";
  if (ref.resolution === "reassert") {
    if (!progress.started) return `${head} Waiting for the background worker to start the run. ${tail}`;
    return `${head} ${formatCount(progress.written ?? 0)} of ${formatCount(ref.total)} written and read back so far, in one run. ${tail}`;
  }
  const done = Math.min(progress.done, ref.total);
  return `${head} ${formatCount(done)} done, ${formatCount(ref.total - done)} to go. ${tail}`;
}
