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
import { evaluate, type AlertSeverity, type SignalWindow } from "./alerts";

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

/**
 * The on-call summary and the severities it summarises.
 *
 * Two halves of a contract validated by nobody, and they had drifted in three directions
 * at once. Four of the six alerts that page were absent from the document telling somebody
 * what pages them — including `unpriceable-variants`, which the code's own comment calls
 * "how a whole catalogue was once importable and unpriceable at the same time". The one
 * condition the doc *did* call page-worthy was the single one deliberately made a notice.
 * And its "next business day" list named conditions from `NOT_ALERTS`, which never fire, so
 * somebody was told to expect notifications that cannot arrive.
 *
 * Keyed by alert id rather than matched against prose. A bijection over sentences is a
 * bijection over spelling, and the spelling is what changes.
 */
describe("on-call expectations", () => {
  const section = runbooks.slice(runbooks.indexOf("## On-call expectations"));

  /**
   * Every alert the app can raise.
   *
   * Derived by tripping all of them at once rather than restated here. A list written out
   * in the test is a third copy of the contract, and it would drift from the other two the
   * same way they drifted from each other.
   */
  const everythingWrong: SignalWindow = {
    secondsSinceTick: 10_000,
    webhookLagMs: 10 * 60_000,
    errors: 100,
    requests: 100,
    divergenceRate: 0.5,
    executionQueueDepth: 5_000,
    unpriceableVariants: 400,
    shopRates: [{ shopId: "shop-1", errors: 40, requests: 100 }],
  };

  const raisable = evaluate(everythingWrong);

  /** The `id` of every alert named in a table row, with the response beside it. */
  const documented = new Map<string, string>(
    [...section.matchAll(/^\|\s*`([a-z-]+)`\s*\|\s*\*\*(\w+)\*\*\s*\|/gm)].map(
      (row) => [row[1], row[2].toLowerCase()],
    ),
  );

  it("finds the alerts it is protecting", () => {
    // A floor, so this cannot pass by parsing nothing — the failure mode of every census
    // check, and the reason the others in this repo carry a number.
    expect(raisable.length).toBeGreaterThanOrEqual(7);
    expect(documented.size).toBeGreaterThanOrEqual(7);
  });

  it("documents every alert the app can raise", () => {
    const missing = raisable.map((alert) => alert.id).filter((id) => !documented.has(id));

    expect(
      missing,
      "an alert nobody documented will wake somebody who has never heard of it",
    ).toEqual([]);
  });

  it("documents no alert the app cannot raise", () => {
    // The other direction, and the one a one-way check misses: a stale row left beside a
    // correct one reads as coverage. Somebody waits for a page that will never come.
    const ids = new Set(raisable.map((alert) => alert.id));
    const phantom = [...documented.keys()].filter((id) => !ids.has(id));

    expect(phantom, "documented as an alert but nothing raises it").toEqual([]);
  });

  it("gives each one the response its severity says it deserves", () => {
    const expected: Record<AlertSeverity, string> = { page: "page", notice: "notice" };
    const wrong = raisable
      .filter((alert) => documented.get(alert.id) !== expected[alert.severity])
      .map((alert) => `${alert.id}: code says ${alert.severity}, runbook says ${documented.get(alert.id)}`);

    expect(
      wrong,
      "being woken by something the runbook called routine is how people stop reading it",
    ).toEqual([]);
  });

  it("does not promise a notification for anything that never fires", () => {
    // `NOT_ALERTS` records conditions deliberately left un-alerted. Listing one under
    // "next business day" tells somebody to watch a channel that will stay empty.
    const notUrgent = section.slice(section.indexOf("Look at these next working day"));
    const rows = [...notUrgent.matchAll(/^\|\s*`([a-z-]+)`/gm)].map((row) => row[1]);
    const ids = new Set(raisable.map((alert) => alert.id));

    for (const id of rows) expect(ids, `${id} is documented but never raised`).toContain(id);
  });
});
