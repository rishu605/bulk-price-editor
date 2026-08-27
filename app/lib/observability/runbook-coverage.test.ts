/**
 * The stuck-run runbook covers the case with no run.
 *
 * Every diagnostic step in that section began from `campaign_runs`, and a campaign can be
 * stuck without having one: `runCampaign` moves it to APPLYING before it plans, so a
 * failure between the transition and the run row leaves a campaign claiming to be
 * applying with nothing behind it.
 *
 * The reaper reads `campaign_runs`, so it cannot see this. An operator following the
 * runbook found nothing in flight and concluded nothing was stuck, while the merchant
 * looked at a campaign that had been "applying" for hours with revert refused.
 *
 * A runbook is only as good as the failure it anticipates, and this one is the failure
 * that actually happened (#325), so it needs to be findable by someone searching the doc
 * at the moment it bites.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PRICES_MAY_BE_LIVE } from "../lifecycle/transitions";

const runbooks = readFileSync(join(process.cwd(), "docs", "runbooks.md"), "utf8");
const section = runbooks.slice(
  runbooks.indexOf("## Stuck run recovery"),
  runbooks.indexOf("## Data restore"),
);

describe("stuck run recovery", () => {
  it("has a section at all", () => {
    expect(section.length).toBeGreaterThan(500);
  });

  it("tells an operator how to find a campaign with no run", () => {
    // The query has to start from `campaigns`, because starting from `campaign_runs` is
    // exactly what misses this.
    expect(section).toMatch(/FROM campaigns/i);
    expect(section).toMatch(/HAVING count\(/i);
  });

  it("says the reaper cannot fix it, so nobody waits for a tick that never helps", () => {
    expect(section).toMatch(/reaper cannot help|reaper cannot|invisible to it/i);
  });

  it("names both claim states, not only the one that is easier to hit", () => {
    // A revert strands the same way an apply does. A runbook that named only APPLYING
    // would leave the operator with no match for the state in front of them.
    // Read from the state machine itself. A second list here would be the same
    // contract-drift shape this codebase keeps paying for — two halves nothing
    // validates — in a test written to guard against exactly that.
    const claimStates = [...PRICES_MAY_BE_LIVE].filter(
      (state) => state === "APPLYING" || state === "REVERTING",
    );
    expect(claimStates).toHaveLength(2);

    for (const state of claimStates) {
      expect(section, `${state} is not mentioned`).toContain(state);
    }
  });

  it("warns against the fix that looks obvious and is wrong", () => {
    // Moving the campaign out of APPLYING by hand, while a run may be writing prices.
    expect(section).toMatch(/Do not.*UPDATE|UPDATE.*Do not/is);
  });
});
