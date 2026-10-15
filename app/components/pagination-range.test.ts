/**
 * A page past the end reads as the last page, and the range never runs backwards (#775).
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { pageRange } from "./Pagination";

describe("a pager's range", () => {
  it("reads a page past the end as the last page, and says the URL needs correcting", () => {
    // `/app/prices?page=99999` on 3,669 variants, 15 a page: it read "1499971–3669".
    const range = pageRange(99_999, 3_669, 15);
    expect(range).toMatchObject({ lastPage: 245, shown: 245, from: 3_661, to: 3_669, beyond: true });
    expect(range.from).toBeLessThanOrEqual(range.to);
  });

  it("is unchanged inside the list", () => {
    expect(pageRange(2, 3_669, 15)).toMatchObject({ shown: 2, from: 16, to: 30, beyond: false });
    expect(pageRange(245, 3_669, 15)).toMatchObject({ from: 3_661, to: 3_669, beyond: false });
  });

  it("does not ask to correct an empty list or a nonsense page", () => {
    expect(pageRange(5, 0, 15)).toMatchObject({ from: 0, to: 0, beyond: false });
    expect(pageRange(0, 100, 15)).toMatchObject({ shown: 1, from: 1, beyond: false });
  });

  it("formats the range like the total, and goes to the last page in place of the URL", () => {
    const source = sourceOf("app/components/Pagination.tsx");
    expect(source).toContain("{formatCount(from)}–{formatCount(to)} of {formatCount(total)}");
    expect(source).toContain("if (beyond) goTo(lastPage, true);");
  });
});
