/**
 * The activity feed's words, and why they are computed rather than looked up.
 *
 * Several audit actions are built at the call site from a variable — `market.${kind}`,
 * `drift.${resolution}` — so there is no closed list of them to write a table against.
 * A table would therefore be permanently one release behind the app, and its failure
 * mode is silent: an unmapped action falls through to the raw string and the merchant
 * reads `mirror.divergence_rate` in their sidebar.
 */

import { describe, expect, it } from "vitest";

import { describeAction, iconForAction } from "./action";

describe("describing an action", () => {
  it("turns the dotted machine string into a phrase", () => {
    expect(describeAction("market.added")).toBe("Market added");
    expect(describeAction("baselines.recapture")).toBe("Baselines recapture");
  });

  it("treats hyphens and underscores as word breaks too", () => {
    expect(describeAction("market.notice-resolved")).toBe("Market notice resolved");
    expect(describeAction("campaign.auto_enroll")).toBe("Campaign auto enroll");
  });

  it("reads a three-part namespace as one phrase", () => {
    expect(describeAction("settings.guardrails.update")).toBe("Settings guardrails update");
  });

  it("has an answer for an action nobody has written yet", () => {
    // The property that a lookup table cannot have: this cannot be missing an entry.
    expect(describeAction("something.entirely.new")).toBe("Something entirely new");
  });

  it("does not blank out on an empty or punctuation-only action", () => {
    expect(describeAction("")).toBe("");
    expect(describeAction("...")).toBe("...");
  });
});

describe("choosing an icon", () => {
  it("keys on the namespace, which is the stable half of the string", () => {
    expect(iconForAction("market.added")).toBe("markets");
    expect(iconForAction("market.removed")).toBe("markets");
    expect(iconForAction("drift.accepted")).toBe("alert-triangle");
  });

  it("gives an unknown namespace a real icon rather than nothing", () => {
    // A feed where some rows have a glyph and others have a hole reads as a failure to
    // load, which is worse than a feed with no glyphs at all.
    expect(iconForAction("something.new")).toBe("note");
    expect(iconForAction("")).toBe("note");
  });
});
