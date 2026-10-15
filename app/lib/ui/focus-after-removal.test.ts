/**
 * Focus after a row leaves its table goes to the row that took its place, or the fallback
 * when none is left (#796). Stand-in elements, since the suite has no DOM.
 */

import { describe, expect, it, vi } from "vitest";

import { focusAfterRemoval } from "./focus-after-removal";

const control = () => ({ focus: vi.fn() });
const tableOf = (controls: Array<ReturnType<typeof control>>) =>
  ({ querySelectorAll: () => controls.map((c) => ({ querySelector: () => c })) }) as unknown as Element;

describe("focus after a row is removed", () => {
  it("lands on the row now in the removed one's place", () => {
    const rows = [control(), control(), control()];
    focusAfterRemoval(tableOf(rows), 1, null);
    expect(rows[1].focus).toHaveBeenCalled();
  });

  it("lands on the last row when the removed one was the end", () => {
    const rows = [control(), control()];
    focusAfterRemoval(tableOf(rows), 2, null);
    expect(rows[1].focus).toHaveBeenCalled();
  });

  it("lands on the fallback when no row is left", () => {
    const fallback = control();
    focusAfterRemoval(tableOf([]), 0, fallback as unknown as HTMLElement);
    focusAfterRemoval(null, 0, fallback as unknown as HTMLElement);
    expect(fallback.focus).toHaveBeenCalledTimes(2);
  });
});
