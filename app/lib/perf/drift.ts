/**
 * Comparing a perf measurement against the one on record.
 *
 * `docs/perf/README.md` said reconciliation took 7ms. It took 1,006ms, and had done for
 * days. Nothing noticed, because nothing compared the two — the document recorded a number
 * and then had no further relationship with reality.
 *
 * It was found by accident while measuring something else, and it was invisible by design:
 * the regression grew with *ledger* size rather than catalogue size, so every
 * catalogue-scaled measurement stayed flat throughout.
 *
 * **A stale perf number is worse than no perf number**, because it is the one somebody
 * quotes — `docs/built-for-shopify.md` cites this directory, and a Built for Shopify review
 * is where it would be quoted.
 *
 * ## Why a ratio *and* an absolute floor
 *
 * A 5ms query becoming 12ms is 2.4x and means nothing: timer granularity, a cold cache, an
 * autovacuum passing through. Ratio alone would cry wolf on every fast query until somebody
 * stopped reading the output, which is how a check stops working.
 *
 * A 400ms query becoming 700ms is 1.75x and matters. Absolute alone would miss it while
 * catching every trivial wobble on the slow ones.
 *
 * So: a regression has to be **both** proportionally large and absolutely noticeable. The
 * 7ms → 1,006ms case clears both by two orders of magnitude, which is the point — the check
 * exists for the regression nobody was looking for, not for tuning noise.
 */

/** One timing, as measured or as recorded. */
export interface Timing {
  label: string;
  p50: number;
  max: number;
}

export interface PerfBaseline {
  /** When these numbers were accepted, so an old record reads as old. */
  recordedAt: string;
  /** The store they came from. Numbers from a different store are not comparable. */
  shop: string;
  /** Catalogue size, for the same reason. */
  variants: number;
  timings: Timing[];
}

/** How much slower a query may get before it counts as a regression. */
export const REGRESSION_RATIO = 1.5;

/**
 * And by how many milliseconds, so a fast query wobbling cannot trip it.
 *
 * Set above the noise a warm p50 shows between runs on the same data — the catalogue's
 * first page has been seen at 26ms and 35ms on consecutive runs with nothing changed.
 */
export const REGRESSION_FLOOR_MS = 25;

export type Movement = "regressed" | "improved" | "held" | "new" | "missing";

export interface Comparison {
  label: string;
  movement: Movement;
  /** Absent for a query with no counterpart on the other side. */
  before?: number;
  after?: number;
}

function movementOf(before: number, after: number): Movement {
  const slower = after - before;

  // Both tests, deliberately. See the note above on why either alone is useless.
  if (slower >= REGRESSION_FLOOR_MS && after >= before * REGRESSION_RATIO) return "regressed";

  // Improvement uses the same two tests mirrored, so "improved" means the same size of
  // move that "regressed" would. A query reported as improved is one somebody should
  // re-record, and a trivial wobble is not worth that.
  if (-slower >= REGRESSION_FLOOR_MS && before >= after * REGRESSION_RATIO) return "improved";

  return "held";
}

/**
 * Every query, and what happened to it since the record.
 *
 * Queries present on only one side are reported rather than skipped. A renamed measurement
 * silently drops its own history otherwise — the record keeps a number nobody will ever
 * compare again, and the new name starts with no baseline, so a regression can hide in a
 * rename.
 */
export function compare(
  recorded: readonly Timing[],
  measured: readonly Timing[],
): Comparison[] {
  const before = new Map(recorded.map((timing) => [timing.label, timing]));
  const after = new Map(measured.map((timing) => [timing.label, timing]));

  const comparisons: Comparison[] = measured.map((timing) => {
    const was = before.get(timing.label);
    return was
      ? {
          label: timing.label,
          movement: movementOf(was.p50, timing.p50),
          before: was.p50,
          after: timing.p50,
        }
      : { label: timing.label, movement: "new" as const, after: timing.p50 };
  });

  for (const timing of recorded) {
    if (!after.has(timing.label)) {
      comparisons.push({ label: timing.label, movement: "missing", before: timing.p50 });
    }
  }

  return comparisons;
}

/** What the comparison proved, in the shape the other drills print. */
export function verdict(comparisons: readonly Comparison[]): string[] {
  const lines: string[] = [];
  const of = (movement: Movement) => comparisons.filter((c) => c.movement === movement);

  const regressed = of("regressed");
  lines.push(
    comparisons.length === 0
      ? "FAIL  compared nothing, so no drift was observed"
      : regressed.length === 0
        ? `PASS  ${comparisons.length} queries checked, none slower than the record`
        : `FAIL  ${regressed
            .map((c) => `${c.label} ${c.before}ms → ${c.after}ms`)
            .join(", ")}`,
  );

  const missing = of("missing");
  if (missing.length > 0) {
    // Not a failure — deleting a page deletes its measurement, legitimately. But silence
    // would let a *rename* drop a query's history, and a regression can hide in a rename.
    lines.push(
      `WARN  on record but not measured: ${missing.map((c) => c.label).join(", ")}`,
    );
  }

  const added = of("new");
  if (added.length > 0) {
    lines.push(`      not yet on record: ${added.map((c) => c.label).join(", ")}`);
  }

  const improved = of("improved");
  if (improved.length > 0) {
    // Worth saying out loud rather than passing quietly. An improvement nobody records
    // leaves the next comparison measuring against a number the app has already beaten,
    // which is how a later regression back to the old figure reads as "held".
    lines.push(
      `      faster than the record, re-record with --record: ` +
        improved.map((c) => `${c.label} ${c.before}ms → ${c.after}ms`).join(", "),
    );
  }

  return lines;
}

export const passed = (lines: readonly string[]): boolean =>
  !lines.some((line) => line.startsWith("FAIL"));

/**
 * Whether two runs are comparable at all.
 *
 * A baseline from a different store, or from the same store at a different size, is not a
 * baseline — it is a different measurement wearing the same labels. Comparing them would
 * report a regression that is only a change of subject, and the first such false alarm is
 * what teaches people to pass `--record` without reading.
 */
export function comparable(
  recorded: Pick<PerfBaseline, "shop" | "variants">,
  measured: Pick<PerfBaseline, "shop" | "variants">,
  tolerance = 0.05,
): string | null {
  if (recorded.shop !== measured.shop) {
    return `recorded against ${recorded.shop}, measured against ${measured.shop}`;
  }

  const drift = Math.abs(measured.variants - recorded.variants);
  if (recorded.variants > 0 && drift > recorded.variants * tolerance) {
    return `catalogue changed from ${recorded.variants} to ${measured.variants} variants`;
  }

  return null;
}
