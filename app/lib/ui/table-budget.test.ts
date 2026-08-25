/**
 * The cell budget that keeps `s-table` rendering.
 *
 * Worth testing rather than trusting because the failure it prevents is silent: the
 * page goes blank with no error anywhere a developer would look.
 */

import { describe, expect, it } from "vitest";

import { CELL_BUDGET, rowsThatFit } from "./table-budget";

describe("fitting rows into the table budget", () => {
  it("gives fewer rows as columns grow", () => {
    // The point of the whole module: adding a market must cost rows, not the page.
    expect(rowsThatFit(6)).toBeLessThan(rowsThatFit(3));
  });

  it("never exceeds the budget", () => {
    for (const columns of [1, 2, 3, 5, 8, 13, 40]) {
      expect(rowsThatFit(columns) * columns).toBeLessThanOrEqual(CELL_BUDGET);
    }
  });

  it("still shows one row for an absurdly wide table", () => {
    // Zero rows would read as "nothing to change", which is a different and much worse
    // message than "here is a sample".
    expect(rowsThatFit(500)).toBe(1);
  });

  it("respects a caller's own maximum", () => {
    expect(rowsThatFit(1, 25)).toBe(25);
  });
});
