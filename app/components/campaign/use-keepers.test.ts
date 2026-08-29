/**
 * When the app is willing to plan the whole scope a second time.
 *
 * Answering "who would keep these variants if this campaign went away" means running the
 * planner again with the campaign excluded. That is the same work the campaign page
 * already does once, and doing it unconditionally would put it in front of every visit to
 * a campaign for the sake of a modal most visits never open — which is #468 in a new
 * place.
 *
 * The predicate is separate from the hook because `useFetcher` throws outside a data
 * router and these components are rendered under a `StaticRouter`. The hook cannot be
 * tested here; the decision inside it can, and the decision is the part with a wrong
 * answer available.
 */

import { describe, expect, it } from "vitest";

import { shouldAskForKeepers } from "./useKeepers";

const rollback = (over: Partial<Parameters<typeof shouldAskForKeepers>[0] & object> = {}) => ({
  campaignId: "c1",
  straightforward: true,
  counts: { total: 812 },
  ...over,
});

describe("asking for the keepers", () => {
  it("asks when a revert would run straight from the header", () => {
    expect(shouldAskForKeepers(rollback())).toBe(true);
  });

  it("does not ask when there is no rollback report at all", () => {
    // A draft campaign has written nothing, so there is nothing to revert.
    expect(shouldAskForKeepers(null)).toBe(false);
  });

  it("does not ask when drifted rows send the merchant to the tab", () => {
    // The header refuses a one-click revert in that case, so the modal never opens.
    expect(shouldAskForKeepers(rollback({ straightforward: false }))).toBe(false);
  });

  it("does not ask when the campaign holds nothing", () => {
    expect(shouldAskForKeepers(rollback({ counts: { total: 0 } }))).toBe(false);
  });
});
