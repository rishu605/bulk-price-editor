/**
 * What a run actually did, as opposed to what it planned to do.
 *
 * The preview answers "what will this cost me". This answers "what did it cost me", and
 * the two are not the same number: guardrails clamp rows, Shopify rejects rows, and a run
 * can finish partial. A campaign that ends with a table of two hundred ledger lines and no
 * summary has technically told the merchant everything and practically told them nothing.
 *
 * **Computed from verified rows only.** A row we wrote but could not read back is not
 * evidence of a price, and averaging it in would make a partial run look complete. Those
 * rows are counted separately and named as unverified, which is the honest reading of
 * invariant I5.
 *
 * **This is arithmetic, not attribution.** It says what the margin on each product became.
 * It says nothing about units sold or revenue earned — that needs order data, is gated on
 * Protected Customer Data approval, and conflating the two is how a merchant makes an
 * expensive decision on bad inference.
 */

import { marginImpact, type MarginImpact, type MarginInput } from "../pricing/margin";

/** The ledger statuses that describe an outcome rather than work still in progress. */
export interface RunCounts {
  /** Written and read back. The only rows that prove a price. */
  verified: number;
  /** Written, but the read-back has not confirmed them. */
  unverified: number;
  /** A guardrail moved the price away from what the campaign asked for. */
  clamped: number;
  /** Deliberately not written — already correct, or excluded. */
  skipped: number;
  /** Shopify refused, or we gave up after retries. */
  failed: number;
  /** Written by this run, and taken back since by a revert. */
  reverted: number;
  /** Still queued or in flight. */
  pending: number;
  total: number;
}

export interface RunResult {
  counts: RunCounts;
  margin: MarginImpact;
  /** True when every row reached a terminal, successful state. */
  clean: boolean;
}

/**
 * Ledger rows reduced to what a summary needs.
 *
 * `after` is the price that is actually live — for a verified row, the one the read-back
 * confirmed. A row whose write we could not confirm is excluded by its status, which is
 * what keeps it out of the margin average.
 */
export interface ResultRow {
  variantGid: string;
  title: string;
  status: string;
  /** Minor units, as stored. */
  beforeMinor: bigint | null;
  afterMinor: bigint | null;
  costMinor: bigint | null;
  currency: string;
}

/**
 * Ledger statuses tallied into the buckets a merchant is shown.
 *
 * Takes counts rather than rows because the same classification has to serve two callers:
 * this module, walking rows, and the result service, handing over a database aggregate
 * over a run too large to load. Two implementations of "which bucket is REVERTED" is
 * exactly the drift that makes one screen contradict another.
 *
 * Anything unrecognised lands in `pending`. That is the safe direction: a status added
 * later makes a run look unfinished rather than quietly making a stuck one look clean.
 */
export function tallyStatuses(
  entries: ReadonlyArray<{ status: string; count: number }>,
): RunCounts {
  const counts: RunCounts = {
    verified: 0,
    unverified: 0,
    clamped: 0,
    skipped: 0,
    failed: 0,
    reverted: 0,
    pending: 0,
    total: 0,
  };

  for (const { status, count } of entries) {
    counts.total += count;

    switch (status) {
      case "VERIFIED":
        counts.verified += count;
        break;
      case "APPLIED":
        counts.unverified += count;
        break;
      case "CLAMPED":
        // Clamped rows were still written, and the price a shopper sees is the clamped
        // one — so they belong in the margin picture, not only in a warning.
        counts.clamped += count;
        break;
      case "SKIPPED":
        counts.skipped += count;
        break;
      case "FAILED":
        counts.failed += count;
        break;
      case "REVERTED":
        // Settled, not outstanding. This run did write the price; a later revert took it
        // back. Counting it as pending would report a finished run as still going.
        counts.reverted += count;
        break;
      default:
        counts.pending += count;
    }
  }

  return counts;
}

export function summariseRun(rows: readonly ResultRow[], targetPercent: number | null): RunResult {
  const counts = tallyStatuses(rows.map((row) => ({ status: row.status, count: 1 })));

  const marginRows: MarginInput[] = [];

  for (const row of rows) {
    // Only rows whose price we can actually stand behind, and which are still live. A
    // reverted row's price is gone, so including it would describe a margin the store no
    // longer has.
    if (row.beforeMinor === null || row.afterMinor === null) continue;
    if (row.status !== "VERIFIED" && row.status !== "CLAMPED") continue;

    marginRows.push({
      variantGid: row.variantGid,
      title: row.title,
      cost:
        row.costMinor === null
          ? undefined
          : { amount: Number(row.costMinor), currency: row.currency },
      before: { amount: Number(row.beforeMinor), currency: row.currency },
      after: { amount: Number(row.afterMinor), currency: row.currency },
    });
  }

  return {
    counts,
    // The same function the preview uses. A result that could disagree with the preview
    // about what "margin" means would make both of them useless.
    margin: marginImpact(marginRows, targetPercent),
    clean: isClean(counts),
  };
}

/**
 * Nothing outstanding: no failures, nothing unverified, nothing still to do.
 *
 * Exported because the counts can also be produced by a database aggregate, and two
 * definitions of "clean" that can disagree is precisely the bug this is here to prevent.
 */
export function isClean(counts: RunCounts): boolean {
  return counts.failed === 0 && counts.pending === 0 && counts.unverified === 0;
}

/**
 * One sentence saying what happened, in the order a merchant cares about.
 *
 * Bad news first and never softened: a partial run that opens by congratulating itself on
 * the rows that worked is the failure mode this whole product exists to avoid.
 */
export function describeRun(result: RunResult): string {
  const { counts } = result;
  const parts: string[] = [];

  if (counts.failed > 0) {
    parts.push(`${counts.failed} row${counts.failed === 1 ? "" : "s"} failed`);
  }
  if (counts.unverified > 0) {
    parts.push(
      `${counts.unverified} ${counts.unverified === 1 ? "was" : "were"} written but not read back`,
    );
  }
  if (counts.pending > 0) {
    parts.push(`${counts.pending} still to run`);
  }

  const wrote = counts.verified + counts.clamped;
  const reverted =
    counts.reverted > 0
      ? ` ${counts.reverted} ${counts.reverted === 1 ? "has" : "have"} been reverted since.`
      : "";
  // "0 prices changed and verified" is accurate and reads like a template that failed to
  // fill in. A run that wrote nothing should say so in words.
  const good =
    wrote === 0
      ? "Nothing has been written"
      : `${wrote} price${wrote === 1 ? "" : "s"} changed and verified`;

  if (parts.length === 0) {
    return counts.skipped > 0
      ? `${good}. ${counts.skipped} needed no change.${reverted}`
      : `${good}.${reverted}`;
  }

  return `${capitalise(parts.join(", "))}. ${good}.${reverted}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
