import { describe, expect, it } from "vitest";

import { DEFAULT_THRESHOLD, selectWritePath } from "./write-path";

/**
 * These guard the decision that a large campaign never runs synchronously.
 *
 * A 1,615-row campaign on the sync path is roughly one variant every two seconds
 * against a standard shop's bucket -- not slow, infeasible. The regression that
 * matters is preview reporting "bulk" while execution quietly uses sync.
 */
describe("write path at realistic catalogue sizes", () => {
  it("sends a whole-catalogue campaign to bulk", () => {
    const decision = selectWritePath(1_615);
    expect(decision.path).toBe("bulk");
    expect(decision.reason).toContain("no rate-limit cost");
  });

  it("keeps a genuinely small campaign on sync", () => {
    // The budget check, not the row threshold, is what actually decides most
    // campaigns. At ~100 points per variant write against 80 usable points/second,
    // sixty seconds buys roughly 48 variants on Plus -- so "small" means dozens,
    // not hundreds.
    const decision = selectWritePath(30, {
      restoreRatePerSecond: 100,
      availablePoints: 2_000,
    });
    expect(decision.path).toBe("sync");
  });

  it("sends even a vendor-sized campaign to bulk once the budget says so", () => {
    // 152 variants is 15,200 points; at 80/s usable that is 165 seconds, past the
    // 60-second ceiling. Row count alone would have called this "small".
    const decision = selectWritePath(152, {
      restoreRatePerSecond: 100,
      availablePoints: 2_000,
    });
    expect(decision.path).toBe("bulk");
    expect(decision.reason).toContain("rate-limit budget");
  });

  it("is stricter on a throttled standard shop than on Plus", () => {
    const plus = selectWritePath(40, { restoreRatePerSecond: 100, availablePoints: 2_000 });
    const standard = selectWritePath(40, { restoreRatePerSecond: 50, availablePoints: 0 });
    expect(plus.path).toBe("sync");
    expect(standard.path).toBe("bulk");
  });

  it("treats the threshold as inclusive", () => {
    expect(selectWritePath(DEFAULT_THRESHOLD).path).toBe("sync");
    expect(selectWritePath(DEFAULT_THRESHOLD + 1).path).toBe("bulk");
  });
});
