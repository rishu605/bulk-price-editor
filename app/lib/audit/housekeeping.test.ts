/**
 * What the dashboard leads with, and what it leaves to the log.
 *
 * Live on `dartmode-labs` the Recent activity card read "Mirror audited / Mirror audit /
 * Market added ×3", all attributed to Scheduler — two entries a merchant cannot tell
 * apart, both naming an internal concept, on the first screen after installing.
 *
 * The direction of the filter is the decision worth testing. An allow-list would go stale
 * by silently dropping a new merchant-facing action from Home, which nobody would ever
 * notice; a deny-list goes stale by leaking a new internal one onto the dashboard, which
 * is visible immediately. So: deny-list, and this pins that a stranger is shown.
 */

import { describe, expect, it } from "vitest";

import { isHousekeeping, merchantFacing } from "./housekeeping";

describe("what counts as the app talking to itself", () => {
  it("hides the mirror auditing itself", () => {
    expect(isHousekeeping("mirror.audit")).toBe(true);
    expect(isHousekeeping("mirror.audited")).toBe(true);
  });

  it("keeps everything a merchant did or decided", () => {
    for (const action of [
      "campaign.transition",
      "campaign.applied",
      "drift.accepted",
      "baselines.recaptured",
      "settings.guardrails.update",
      "cost.imported",
    ]) {
      expect(isHousekeeping(action), action).toBe(false);
    }
  });

  it("keeps market changes, which are the merchant's business even when we noticed them", () => {
    // Written by the scheduler, but a new market is a thing to know about: it changes
    // what a campaign can price.
    expect(isHousekeeping("market.added")).toBe(false);
  });

  it("shows an action from a namespace nobody has seen before", () => {
    // The deny-list's whole point. A new *internal* namespace leaking here is visible and
    // one line to fix; a new merchant-facing one silently missing is not.
    expect(isHousekeeping("something.new")).toBe(false);
  });

  it("does not match a namespace that merely starts with the same letters", () => {
    expect(isHousekeeping("mirrors.thing")).toBe(false);
  });
});

describe("choosing the entries for the dashboard", () => {
  const entry = (action: string) => ({ action });

  it("drops housekeeping and keeps the order it was given", () => {
    const shown = merchantFacing(
      [entry("mirror.audited"), entry("campaign.applied"), entry("mirror.audit"), entry("drift.accepted")],
      5,
    );

    expect(shown.map((row) => row.action)).toEqual(["campaign.applied", "drift.accepted"]);
  });

  it("counts the limit after filtering, not before", () => {
    // Filtering a page of five and then showing what survives is how a busy scheduler
    // empties the card: three housekeeping rows left two entries where five were asked
    // for.
    const entries = [
      ...Array.from({ length: 6 }, () => entry("mirror.audit")),
      ...Array.from({ length: 4 }, (_, i) => entry(`campaign.step${i}`)),
    ];

    expect(merchantFacing(entries, 3)).toHaveLength(3);
  });

  it("returns nothing rather than padding when there is nothing to show", () => {
    expect(merchantFacing([entry("mirror.audit")], 5)).toEqual([]);
  });
});
