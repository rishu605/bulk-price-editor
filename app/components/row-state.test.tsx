/**
 * The ordinary outcome is not worth a badge.
 *
 * A campaign's ledger after a clean run is sixty rows all reading "Verified". Badged, that
 * is sixty green pills, each drawing the eye to a variant that needs nothing, and the one
 * FAILED row competing with fifty-nine that succeeded. The same shape was in the
 * reconciliation table (every row matching), the rollback report (every row unchanged) and
 * the review step's preview (every row pending).
 *
 * The catalogue page reached this conclusion first and fixed only itself. `RowState` is
 * that decision made once, and this file is the part of it that cannot be un-made by
 * accident — because the failure is not an exception or a broken layout, it is a page
 * that looks busy, which nobody files a bug about.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RowState } from "./RowState";
import { sourceOf } from "../lib/testing/source";

describe("RowState", () => {
  const ordinary = renderToStaticMarkup(<RowState label="Verified" tone="success" ordinary />);
  const exceptional = renderToStaticMarkup(<RowState label="Failed" tone="critical" />);

  it("renders the ordinary state without a badge", () => {
    // Subdued text rather than a neutral badge, which is the distinction that matters: a
    // badge is a shape as well as a colour, so recolouring forty pills grey still leaves
    // forty things that look like forty things to look at.
    expect(ordinary).not.toContain("s-badge");
    expect(ordinary).toContain('color="subdued"');
  });

  it("still says the state's own name, so nothing is carried by colour alone", () => {
    // WCAG 1.4.1, the rule `colour-signal.test.ts` enforces. De-emphasis is allowed;
    // dropping the word would not be.
    expect(ordinary).toContain("Verified");
    expect(exceptional).toContain("Failed");
  });

  it("badges a state that is not the expected outcome", () => {
    expect(exceptional).toContain("s-badge");
    expect(exceptional).toContain('tone="critical"');
  });
});

describe("no table badges its own ordinary state", () => {
  /**
   * The four that did. Listed by name rather than discovered by pattern: the check is
   * that these specific tables went through `RowState`, and a new table that badges
   * everything is a review comment rather than something this file can see.
   */
  const TABLES = [
    "app/components/LedgerTable.tsx",
    "app/components/ReconciliationTable.tsx",
    "app/components/RollbackReportTable.tsx",
    "app/components/PreviewTable.tsx",
  ];

  it.each(TABLES)("%s renders its state through RowState", (path) => {
    const source = sourceOf(path);

    expect(source, `${path} should import RowState`).toContain('from "./RowState"');
    expect(
      source,
      `${path} still writes an <s-badge> for its state column — the ordinary outcome then gets a pill on every row`,
    ).not.toContain("<s-badge");
  });
});
