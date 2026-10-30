/**
 * No query in a run passes an `IN` list it did not chunk, and no insert takes rows it did not
 * batch (#810).
 *
 * The class keeps coming back because each instance looks harmless where it is written: an
 * `IN` of "the variants this market settled" reads as a handful, and is 102,132 on
 * anchor-perf. Prisma splits a long list at exactly the bind ceiling and adds the where
 * clause's other binds on top, so one more filter is a P2035 before a price is written
 * (#346) -- and below the ceiling it is still one statement holding a connection for as
 * long as the biggest list takes, which is what starved every page during #803's run.
 * `recordResults` and `revertMarketSurfaces` were both unbounded when #810 was filed.
 *
 * So this reads the run's modules and accepts exactly three shapes for an `in:`:
 *
 *   - `batch`, the name every chunk helper here hands its callback (`inRunChunks`,
 *     `inChunks`, `chunk(...)`), so a list that came through one reads as one;
 *   - a literal list of constants -- statuses, kinds -- or a spread of an UPPER_CASE one;
 *   - an expression in `BOUNDED_ELSEWHERE`, with the reason it cannot grow with the catalogue.
 *
 * And every `createMany` takes `batch.map(...)` or `chunk.map(...)`, a request-sized chunk an
 * executor hands its ledger callback. Anything else fails, naming the file and the line.
 */

import { describe, expect, it } from "vitest";

import { rawSource, sourceOf } from "../testing/source";

/** The modules a run's apply or revert reaches with a query, from plan to settle. */
const RUN_PATH = [
  "app/services/campaigns/run.server.ts",
  "app/services/campaigns/execute.server.ts",
  "app/services/campaigns/market-surfaces.server.ts",
  "app/services/campaigns/market-wide.server.ts",
  "app/services/campaigns/market-plan.server.ts",
  "app/services/campaigns/mirror.server.ts",
  "app/services/campaigns/b2b-surfaces.server.ts",
  "app/services/campaigns/b2b-plan.server.ts",
  "app/services/campaigns/tags.server.ts",
  "app/services/campaigns/candidates.server.ts",
  "app/services/campaigns/handover.server.ts",
  "app/services/live-prices.server.ts",
];

/**
 * Lists bounded by something other than the catalogue, by file. Each needs its reason here,
 * not a comment at the call site: an exemption nobody has to justify centrally is how this
 * rule erodes.
 */
const BOUNDED_ELSEWHERE: Record<string, Record<string, string>> = {
  "app/services/campaigns/run.server.ts": {
    "surfaces.priceLists": "the price lists a campaign targets: markets a merchant picked, not one per variant",
  },
  "app/services/campaigns/market-surfaces.server.ts": {
    "surfaces.priceLists": "the price lists a campaign targets: markets a merchant picked, not one per variant",
  },
  "app/services/campaigns/market-plan.server.ts": {
    retiringInBatch: "the superseded baselines of one RUN_CHUNK batch of variants, at most one per variant in it",
  },
  "app/services/campaigns/candidates.server.ts": {
    "[...importIds]": "the price imports a campaign's rules name, a handful at most",
  },
};

/**
 * The expression after each match of `pattern`, up to the comma or brace that ends it, with
 * its line. Comments stripped first, so a note explaining an old unbounded list cannot trip
 * this; lines found in the file as written, so a failure points at the right one.
 */
function valuesAfter(file: string, pattern: RegExp, label: string): Array<{ value: string; line: number }> {
  const source = sourceOf(file);
  const raw = rawSource(file).split("\n");
  const found: Array<{ value: string; line: number }> = [];

  for (const match of source.matchAll(pattern)) {
    let depth = 0;
    let value = "";
    for (let at = match.index! + match[0].length; at < source.length; at++) {
      const c = source[at]!;
      if ("([{".includes(c)) depth++;
      if (")]}".includes(c)) {
        if (depth === 0) break;
        depth--;
      }
      if (c === "," && depth === 0) break;
      value += c;
    }
    const text = value.trim();
    const head = `${label} ${text.split("\n")[0]}`;
    found.push({ value: text, line: raw.findIndex((line) => line.includes(head)) + 1 });
  }
  return found;
}

/** Every `in:` list's expression. */
const inLists = (file: string) => valuesAfter(file, /\bin:\s*/g, "in:");

/** Every `createMany({ data: ... })`'s rows. */
const createManyData = (file: string) => valuesAfter(file, /createMany\(\{\s*data:\s*/g, "data:");

const LITERAL_LIST = /^\[\s*(?:(?:"[^"]*"|'[^']*'|\.\.\.[A-Z][A-Z0-9_]*)\s*,?\s*)*\]$/;

function chunkedIn(file: string, value: string): boolean {
  return value === "batch" || /^[A-Z][A-Z0-9_]*$/.test(value) || LITERAL_LIST.test(value) || value in (BOUNDED_ELSEWHERE[file] ?? {});
}

describe("a run's queries stay bounded", () => {
  it("reads every run-path module, so this cannot pass over nothing", () => {
    const lists = RUN_PATH.flatMap((file) => inLists(file));
    expect(lists.length).toBeGreaterThan(40);
    expect(RUN_PATH.flatMap(createManyData).length).toBeGreaterThan(5);
  });

  it("catches an unchunked list, so a pass means something", () => {
    // The shape `recordResults` had in market-surfaces before #810.
    expect(chunkedIn("app/services/campaigns/market-surfaces.server.ts", "gids")).toBe(false);
    expect(chunkedIn("app/services/campaigns/market-surfaces.server.ts", "already.map((row) => row.variantGid)")).toBe(false);
    expect(chunkedIn("app/services/campaigns/market-surfaces.server.ts", "[...rewrite]")).toBe(false);
    expect(chunkedIn("app/services/campaigns/run.server.ts", '["APPLIED", ...LANDED]')).toBe(true);
  });

  it.each(RUN_PATH)("%s passes no `in:` list it did not chunk", (file) => {
    const unbounded = inLists(file)
      .filter(({ value }) => !chunkedIn(file, value))
      .map(({ value, line }) => `${file}:${line}  in: ${value.replace(/\s+/g, " ")}`);

    expect(
      unbounded,
      "an `in:` list that grows with the catalogue: put it through `inRunChunks` (writes) or `inChunks` " +
        "(reads) from app/lib/db so it reaches the query as `batch`, or add it to BOUNDED_ELSEWHERE with why it cannot grow",
    ).toEqual([]);
  });

  it.each(RUN_PATH)("%s inserts rows only a batch at a time", (file) => {
    const unbatched = createManyData(file)
      .filter(({ value }) => !/^(batch|chunk)\.map\(/.test(value))
      .map(({ value, line }) => `${file}:${line}  createMany({ data: ${value.split("\n")[0]}`);

    expect(unbatched, "a createMany of every row the run has: write it through `inRunChunks` (#810)").toEqual([]);
  });

  it("names a real list in every exemption, so none outlives the code it excused", () => {
    for (const [file, exempt] of Object.entries(BOUNDED_ELSEWHERE)) {
      const values = inLists(file).map(({ value }) => value);
      for (const expression of Object.keys(exempt)) {
        expect(values, `${file} no longer has \`in: ${expression}\`; remove its exemption`).toContain(expression);
      }
    }
  });
});
