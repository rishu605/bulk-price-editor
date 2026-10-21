/**
 * What changes on screen after an action is said aloud (#798).
 *
 * Four things changed in front of a sighted merchant and in silence for anyone else: the
 * editor's "N of M variants would change price", a CSV landing in the drop zone (or
 * failing to), and the spreadsheet check's answer. Each was plain text that appeared or
 * changed, and plain text is only read when somebody goes looking for it.
 *
 * The rule these assert is the one live regions actually follow, which is narrower than it
 * looks: a screen reader announces a change to a region's **content**, in a region that
 * **already existed** when the change happened. An `aria-label` is not content, and a
 * region that mounts with its text already inside is, to most screen readers, not a
 * change at all. So every region here is rendered empty before there is anything to say,
 * and the sentence is its text.
 *
 * Navigation has its own file, `route-progress.test.tsx`, because it needs the router's
 * state stubbed and nothing here should share that stub.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveStatus } from "./LiveStatus";
import { DraftPreview, previewAnnouncement } from "./DraftPreview";
import { CsvDropZoneView } from "./imports/CsvDropZone";
import { ImportAnswer } from "./imports/ImportAnswer";
import type { DraftPreview as Preview, DraftPreviewRow } from "../services/campaigns/draft-preview.server";
import { sourceOf } from "../lib/testing/source";

/** Every live region in some markup: its attributes and the words inside it. */
function regions(html: string): Array<{ attrs: string; text: string }> {
  return [...html.matchAll(/<div([^>]*\brole="status"[^>]*)>([\s\S]*?)<\/div>/g)].map((match) => ({
    attrs: match[1],
    text: match[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  }));
}

/** The one live region a component renders. Fails loudly if there is none, or several. */
function region(html: string): { attrs: string; text: string } {
  const found = regions(html);
  expect(found, "expected exactly one role=status region").toHaveLength(1);
  return found[0];
}

describe("the live region itself", () => {
  it("is a polite status whose message is its content, not its label", () => {
    const { attrs, text } = region(renderToStaticMarkup(<LiveStatus message="3 of 5 variants would change price." />));

    expect(attrs).toContain('aria-live="polite"');
    expect(attrs, "the whole sentence, not just the words that changed").toContain('aria-atomic="true"');
    expect(text).toBe("3 of 5 variants would change price.");
    expect(attrs, "a live region announces content; a label is never spoken on change").not.toContain("aria-label");
  });

  it("exists, empty, before there is anything to say", () => {
    // A region that mounts with its sentence already in it is not a change, so it is not
    // announced. Rendering it empty first is what makes the first answer audible.
    expect(region(renderToStaticMarkup(<LiveStatus message="" />)).text).toBe("");
    expect(region(renderToStaticMarkup(<LiveStatus />)).text).toBe("");
  });

  it("is hidden from the eye and not from the screen reader", () => {
    const { attrs } = region(renderToStaticMarkup(<LiveStatus message="Loaded." />));

    expect(attrs).not.toContain("aria-hidden");
    expect(attrs).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(attrs, "visually hidden the way Polaris' own exclusive text is").toMatch(/clip-path:\s*inset\(50%\)/);
  });
});

const row = (over: Partial<DraftPreviewRow> = {}): DraftPreviewRow => ({
  variantGid: "gid://shopify/ProductVariant/1",
  title: "Cotton tee · M",
  imageUrl: null,
  before: "$40.00",
  live: null,
  after: "$32.00",
  beforeCompareAt: null,
  afterCompareAt: null,
  unchanged: false,
  skippedReason: null,
  ...over,
});

const preview = (over: Partial<Preview> = {}): Preview => ({
  matched: 5,
  changing: 3,
  alreadyCorrect: 2,
  skipped: 0,
  staleBaselines: 0,
  withoutBaseline: 0,
  leftOutByStatus: 0,
  rows: [row()],
  overlaps: [],
  blocked: null,
  ...over,
});

const panel = (value: Preview | null, pending = false) =>
  renderToStaticMarkup(<DraftPreview preview={value} pending={pending} />);

describe("the editor's preview says what it found", () => {
  it("has its region before the first answer arrives", () => {
    // The first answer comes from the client a second after the page draws (#468), so the
    // region has to be on the page, empty, by then.
    expect(region(panel(null, true)).text).toBe("");
  });

  it("says how many variants would change, once it knows", () => {
    expect(region(panel(preview())).text).toContain("3 of 5 variants would change price.");
  });

  it("agrees with one", () => {
    expect(region(panel(preview({ matched: 1, changing: 1 }))).text).toContain(
      "1 of 1 variant would change price.",
    );
  });

  it("says what the example product becomes, which changes when the counts do not", () => {
    // 20% off and 30% off reach the same 3 of 5. The example is what moves.
    expect(region(panel(preview())).text).toContain("Cotton tee · M would go from $40.00 to $32.00.");
  });

  it("names the rows it would leave alone or cannot price", () => {
    const text = region(panel(preview({ skipped: 2, withoutBaseline: 4 }))).text;

    expect(text).toContain("2 would be left alone.");
    // The panel's own sentence, word for word (#1097).
    expect(text).toContain("4 have no baseline yet, so they cannot be priced at all.");
  });

  it("empties while it recalculates, so the same answer twice is still heard twice", () => {
    // The visible panel keeps the old figures marked "updating…". The region does not: a
    // region whose text goes from X to X has not changed, and a merchant who changed the
    // rule would hear nothing back.
    expect(region(panel(preview(), true)).text).toBe("");
  });

  it("says why there is nothing to show, in every branch that shows nothing", () => {
    expect(region(panel(preview({ ruleProblem: "Enter an amount for the rule." }))).text).toBe(
      "Enter an amount for the rule.",
    );
    const blocked = "Cotton tee · M would be priced $8.00, below its floor of $10.00. Nothing would be written.";
    expect(
      region(panel(preview({ blocked: { reason: "floor", variantGid: "gid://shopify/ProductVariant/9", message: blocked } })))
        .text,
      "the banner's own sentence, which names the variant (#1076)",
    ).toBe(blocked);
    expect(region(panel(preview({ matched: 0, changing: 0, rows: [] }))).text).toBe("Nothing matches this scope.");
    expect(
      region(panel(preview({ matched: 0, changing: 0, rows: [], leftOutByStatus: 3 }))).text,
    ).toBe("Only draft or archived products match.");
    expect(region(panel(preview({ matched: 0, changing: 0, rows: [], catalogue: "unsynced" }))).text).toContain(
      "hasn't read your catalogue",
    );
  });

  it("is one region, first in the panel, whichever branch renders", () => {
    // The panel swaps between a banner, an empty state and a table. A region inside any
    // one of them would be a new region each time it swapped, and new regions are silent.
    for (const html of [
      panel(null, true),
      panel(preview()),
      panel(preview({ ruleProblem: "Enter an amount." })),
      panel(preview({ matched: 0, changing: 0, rows: [] })),
    ]) {
      expect(html, "the region is the panel's first element").toMatch(/^<div[^>]*\brole="status"/);
      expect(regions(html)).toHaveLength(1);
    }
  });

  it("is worked out from the same preview the panel draws", () => {
    expect(previewAnnouncement(null, false)).toBe("");
    expect(previewAnnouncement(preview(), false)).toBe(region(panel(preview())).text);
  });
});

const zone = (props: Partial<Parameters<typeof CsvDropZoneView>[0]> = {}) =>
  renderToStaticMarkup(<CsvDropZoneView loaded={null} problem={null} onFile={() => undefined} {...props} />);

describe("the CSV drop zone says what it read", () => {
  it("has its region before a file is dropped", () => {
    expect(region(zone()).text).toBe("");
  });

  it("says which file landed and how many lines", () => {
    expect(region(zone({ loaded: { name: "prices.csv", lines: 1_200 } })).text).toBe(
      "prices.csv — 1,200 lines loaded below. Nothing is imported until you run it.",
    );
  });

  it("says a read failure aloud", () => {
    const html = zone({ problem: "Could not read prices.csv. Open it and paste its contents instead." });

    expect(region(html).text).toBe("Could not read prices.csv. Open it and paste its contents instead.");
  });

  it("puts a read failure on the drop zone, so it belongs to the control that failed", () => {
    // It was a paragraph after the zone: nothing tied it to the control, and the zone's
    // own error slot sat empty.
    const html = zone({ problem: "Could not read prices.csv." });

    expect(html).toMatch(/<s-drop-zone[^>]*\serror="Could not read prices.csv."/);
    expect(html, "said once, by the control, not again in a paragraph beside it").not.toContain('tone="critical"');
  });
});

describe("the spreadsheet check's answer", () => {
  it("is a banner when the check passes, as on the other import pages", () => {
    const html = renderToStaticMarkup(
      <ImportAnswer answer={{ ok: true, message: "118 of 120 rows matched a product. Nothing has been created yet." }} />,
    );

    expect(html).toMatch(/^<s-banner tone="success">/);
    expect(html).toContain("118 of 120 rows matched a product.");
  });

  it("is a critical banner when the commit is refused", () => {
    const html = renderToStaticMarkup(
      <ImportAnswer answer={{ ok: false, message: "These rows were not checked. No campaign was created." }} />,
    );

    expect(html).toMatch(/^<s-banner tone="critical">/);
  });

  it("is nothing before a check has run", () => {
    expect(renderToStaticMarkup(<ImportAnswer answer={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<ImportAnswer answer={{ ok: true }} />)).toBe("");
  });

  it("is shown by the editor for a passed check too, under the form that asked", () => {
    // The route returns a message for every check. The editor's fetcher kept it only when
    // `ok === false`, so the one sentence a passing check produced was dropped, and the
    // only output was a report card below the import history table.
    const editor = sourceOf("app/routes/app.campaigns.new.tsx");
    const answer = editor.indexOf("<ImportAnswer answer={importFetcher.data}");

    expect(answer, "the editor does not render the check's answer").toBeGreaterThan(-1);
    // Unconditionally: `ImportAnswer` decides what an answer looks like, and a condition
    // around it here is how the passing check's sentence was dropped in the first place.
    const line = editor.slice(editor.lastIndexOf("\n", answer) + 1, editor.indexOf("\n", answer)).trim();
    expect(line).toBe("<ImportAnswer answer={importFetcher.data} />");
    expect(answer, "the answer belongs under the form, above the history table").toBeLessThan(
      editor.indexOf("<PriceImportHistory"),
    );
    expect(answer).toBeGreaterThan(editor.indexOf("<ImportForm"));
  });
});
