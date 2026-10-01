import { describe, expect, it } from "vitest";

import { recaptureScopeFrom, STALE_SCOPE } from "./recapture-scope";

describe("the scope a recapture page value names (#745)", () => {
  it("reads blank as the whole catalogue, a cuid as a segment, and the sentinel as stale baselines", () => {
    expect(recaptureScopeFrom("")).toEqual({});
    expect(recaptureScopeFrom(null)).toEqual({});
    expect(recaptureScopeFrom("  ")).toEqual({});
    expect(recaptureScopeFrom("cmuoi6hk70001x973xi1v2xao")).toEqual({ segmentId: "cmuoi6hk70001x973xi1v2xao" });
    expect(recaptureScopeFrom(STALE_SCOPE)).toEqual({ stale: true });
  });
});
