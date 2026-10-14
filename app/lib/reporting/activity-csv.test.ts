/**
 * The activity log as a file.
 *
 * The module states the one thing worth pinning and nothing enforced it:
 *
 *   "system" rather than blank: an empty cell in an exported audit log reads as missing
 *    data rather than as unattended work.
 *
 * Blanking it passed all 2,991 tests. Someone reconciling an audit trail then cannot tell
 * "nobody was attributed" from "the scheduler did it" — the difference between an
 * unexplained change and a routine one.
 */

import { describe, expect, it } from "vitest";

import { activityCsv, type ActivityEntry } from "./activity-csv";

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: "a1",
  at: "2026-08-30T09:00:00.000Z",
  actor: "staff:42",
  action: "campaign.applied",
  entity: "campaign",
  entityId: "c1",
  variantGid: null,
  summary: "Applied Summer Sale to 412 variants",
  ...over,
});

const lines = (csv: string) => csv.trimEnd().split("\n");

describe("the exported audit log", () => {
  it("names every column in the header", () => {
    expect(lines(activityCsv([]))[0]).toBe(
      '"timestamp","actor","action","entity","entity_id","change","variant_gid"',
    );
  });

  it("writes one line per entry", () => {
    expect(lines(activityCsv([entry(), entry({ id: "a2" })]))).toHaveLength(3);
  });

  it("carries the actor, the action and the summary", () => {
    const csv = activityCsv([entry()]);

    expect(csv).toContain('"staff:42"');
    expect(csv).toContain('"campaign.applied"');
    expect(csv).toContain('"Applied Summer Sale to 412 variants"');
  });
});

describe("unattended work", () => {
  it('is exported as "system", never as a blank cell', () => {
    // A blank reads as missing data. The scheduler acting is not missing data — it is the
    // answer to "who did this", and the export has to be able to say it.
    expect(activityCsv([entry({ actor: null })])).toContain('"system"');
  });

  it("does not leave the actor column empty for any entry", () => {
    const csv = activityCsv([entry({ actor: null }), entry({ actor: "staff:7" })]);

    for (const line of lines(csv).slice(1)) {
      expect(line.split(",")[1], `blank actor in: ${line}`).not.toBe('""');
    }
  });
});

describe("columns that legitimately have nothing in them", () => {
  it("writes an empty cell for a missing entity, rather than the word null", () => {
    // Unlike the actor, an entry with no entity genuinely has none — a settings change
    // is not about an object. `null` would read as a value the app assigned.
    const csv = activityCsv([entry({ entity: null, entityId: null })]);

    expect(csv).not.toContain("null");
    expect(lines(csv)[1]).toContain('"","",');
  });

  it("survives a summary containing a comma and a quote", () => {
    // Summaries quote merchant text — campaign names, product titles. A log that
    // corrupts itself on one is not a record of anything.
    expect(activityCsv([entry({ summary: 'Renamed to "Winter, Final"' })])).toContain(
      '"Renamed to ""Winter, Final"""',
    );
  });

  it("writes an empty variant cell for an entry about no one variant", () => {
    expect(lines(activityCsv([entry()]))[1].endsWith(',""')).toBe(true);
  });

  it("exports a header-only file when there is no activity", () => {
    expect(lines(activityCsv([]))).toHaveLength(1);
  });
});

describe("an entry about a variant (#757)", () => {
  const drift = entry({
    action: "drift.ignore",
    entity: "DriftEvent",
    entityId: "d1",
    variantGid: "gid://shopify/ProductVariant/45725717004522",
    summary: "variant: The Minimal Snowboard, observedPrice: $701.00",
  });

  it("carries the GID in a column of its own", () => {
    // The page names the variant by title and nothing else. The export is where somebody
    // joins the log to another file, so the GID has to survive there -- and only there.
    expect(lines(activityCsv([drift]))[1].split(",").at(-1)).toBe(
      '"gid://shopify/ProductVariant/45725717004522"',
    );
  });

  it("keeps the summary the merchant read on the page", () => {
    expect(activityCsv([drift])).toContain('"variant: The Minimal Snowboard, observedPrice: $701.00"');
  });
});
