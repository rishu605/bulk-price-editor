/**
 * The campaigns index's filters, and the one count that must ignore them.
 *
 * The list used to load every campaign a shop had ever created, unpaged, with no search
 * and no filter. Fine at twelve; at a few hundred the row that needs a decision is the
 * one that gets lost.
 *
 * Which is why `attentionCount` is deliberately *not* filtered. A merchant who has
 * narrowed to DRAFT still needs to know a run went partial — hiding that behind an
 * unrelated filter is how a half-applied campaign goes unnoticed, and a half-applied
 * campaign is the failure this product exists to prevent.
 */

import { describe, expect, it } from "vitest";

import { filtersFrom, PAGE_SIZE } from "./list.server";

const from = (query: string) => filtersFrom(new URLSearchParams(query));

describe("reading the filters", () => {
  it("defaults to the first page, no search, no status", () => {
    expect(from("")).toEqual({ q: "", status: "", page: 1 });
  });

  it("trims a search someone typed and mostly deleted", () => {
    expect(from("q=%20%20").q).toBe("");
  });

  it("keeps a real search", () => {
    expect(from("q=summer+sale").q).toBe("summer sale");
  });

  it("reads a status", () => {
    expect(from("status=PARTIAL").status).toBe("PARTIAL");
  });

  it("treats 'attention' as a filter, since it spans several states", () => {
    expect(from("status=attention").status).toBe("attention");
  });

  it.each(["0", "-3", "not-a-number", ""])("never pages below one (%s)", (page) => {
    expect(from(`page=${page}`).page).toBe(1);
  });

  it("reads a real page number", () => {
    expect(from("page=4").page).toBe(4);
  });

  it("pages at a size a merchant can scan", () => {
    expect(PAGE_SIZE).toBeGreaterThan(10);
    expect(PAGE_SIZE).toBeLessThanOrEqual(50);
  });
});
