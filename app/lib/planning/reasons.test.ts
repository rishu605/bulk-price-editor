/**
 * Both phrasings cover every reason the resolver can produce.
 *
 * A reason added to `ResolutionReason` and phrased in only one map renders as "unknown"
 * or "Not written" in the other — a merchant told nothing about a case the app
 * understands perfectly well. TypeScript catches a missing key because both maps are
 * `Record<ResolutionReason, string>`; what it cannot catch is an *extra* key that no
 * longer corresponds to a reason, or the two maps describing different things.
 */

import { describe, expect, it } from "vitest";

import { SKIP_REASON_GROUP, SKIP_REASON_ROW, skipReasonForRow } from "./reasons";

describe("the two phrasings stay in step", () => {
  it("cover the same reasons", () => {
    expect(Object.keys(SKIP_REASON_ROW).sort()).toEqual(Object.keys(SKIP_REASON_GROUP).sort());
  });

  it("phrases every reason, with nothing left blank", () => {
    for (const [reason, text] of [
      ...Object.entries(SKIP_REASON_GROUP),
      ...Object.entries(SKIP_REASON_ROW),
    ]) {
      expect(text.trim(), `${reason} has no wording`).not.toBe("");
    }
  });

  it("keeps the group phrasing plural and the row phrasing not", () => {
    // The group form completes "14 variants ...", the row form stands alone. Getting
    // these the wrong way round produces "14 variants No cost recorded".
    for (const text of Object.values(SKIP_REASON_GROUP)) {
      expect(text[0], `"${text}" should continue a sentence, so it starts lowercase`).toBe(
        text[0].toLowerCase(),
      );
    }
    for (const text of Object.values(SKIP_REASON_ROW)) {
      expect(text[0], `"${text}" stands alone, so it starts capitalised`).toBe(
        text[0].toUpperCase(),
      );
    }
  });
});

describe("a reason the planner did not attach", () => {
  it("still says something rather than rendering undefined", () => {
    expect(skipReasonForRow(undefined)).toBe("Not written");
    expect(skipReasonForRow("something-new")).toBe("Not written");
  });

  it("uses the real wording when there is one", () => {
    expect(skipReasonForRow("below-floor")).toBe("Below your price floor");
  });
});
