import { describe, expect, it } from "vitest";

import { endMissed, withEndMissed } from "./end-missed";

const window = { kind: "window", startAt: "2026-10-01T09:00:00.000Z", endAt: "2026-10-02T09:00:00.000Z" };

describe("a missed scheduled end (#1005)", () => {
  it("is read back for the end it was recorded against", () => {
    const marked = withEndMissed(window, "Shopify didn't answer.", new Date("2026-10-02T09:01:00.000Z"));
    expect(endMissed(marked)).toBe("Shopify didn't answer.");
  });

  it("is forgotten once the end moves, and absent when never recorded", () => {
    const marked = withEndMissed(window, "Shopify didn't answer.", new Date());
    expect(endMissed({ ...marked, endAt: "2026-10-09T09:00:00.000Z" })).toBeNull();
    expect(endMissed(window)).toBeNull();
    expect(endMissed({ kind: "manual" })).toBeNull();
  });
});
