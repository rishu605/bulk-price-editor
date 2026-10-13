/**
 * The sentence no competitor can write.
 *
 * RUBIX's editor warns merchants not to create a second task over the same products, and
 * its FAQ works the arithmetic: 30% off, then 50% off without reverting, leaves a $1000
 * product at $350 for ever — because "initial price" means whatever it happened to be
 * when the second task started. NA and Sami share the fault and say nothing.
 *
 * We resolve by priority and revert by recomputing, so the right rendering is a statement
 * rather than a warning. Two properties are load-bearing:
 *
 * - **Silence when nothing overlaps.** A panel that says "no overlaps" on every draft is
 *   one a merchant stops reading before the draft where it matters.
 * - **The claim about reverting.** It is the difference between our model and theirs, and
 *   it is only true because a revert recomputes.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { OverlapPanel } from "./OverlapPanel";
import type { Overlap } from "../lib/planning/overlaps";

const overlap = (over: Partial<Overlap> = {}): Overlap => ({
  campaignId: "c_autumn",
  name: "Autumn sale",
  keeps: 1240,
  yields: 0,
  priority: 200,
  status: "ACTIVE",
  ...over,
});

const render = (overlaps: Overlap[]) =>
  renderToStaticMarkup(
    <StaticRouter location="/app/campaigns/new">
      <OverlapPanel overlaps={overlaps} />
    </StaticRouter>,
  );

describe("when something overlaps", () => {
  const html = render([overlap()]);

  it("leads with how much of the scope is already spoken for", () => {
    expect(html).toContain("1,240");
    expect(html).toContain("already priced by another campaign");
  });

  it("names the campaign and links to it", () => {
    expect(html).toContain("Autumn sale");
    expect(html).toContain("/app/campaigns/c_autumn");
  });

  it("says who wins, and what to change to win instead", () => {
    // A merchant reading "these overlap" and nothing else has been given a problem.
    expect(html).toContain("outranks this campaign");
    expect(html).toContain("200");
  });

  it("makes the claim that separates us from all three of them", () => {
    expect(html).toContain("never stack");
    expect(html).toContain("recomputes");
    expect(html, "their revert restores a saved price; ours does not").toContain(
      "rather than restoring a saved price",
    );
  });
});

describe("when nothing overlaps", () => {
  it("renders nothing at all", () => {
    // Not an empty banner, and not "no overlapping campaigns" — either is a thing to
    // read and dismiss on every draft.
    expect(render([])).toBe("");
  });
});

describe("more than one", () => {
  const html = render([overlap(), overlap({ campaignId: "c_clear", name: "Clearance", keeps: 12, priority: 150 })]);

  it("counts them together at the top", () => {
    expect(html).toContain("1,252");
  });

  it("gives each its own line, so each can be opened", () => {
    expect(html).toContain("/app/campaigns/c_autumn");
    expect(html).toContain("/app/campaigns/c_clear");
  });
});

describe("one variant", () => {
  it("does not say 1 variants are", () => {
    const html = render([overlap({ keeps: 1 })]);

    expect(html).toContain("1 variant in this scope is");
    expect(html).not.toContain("1 variants");
  });

  it("says keeps it, not keeps 1 of them", () => {
    expect(render([overlap({ keeps: 1 })])).toContain("keeps it");
  });
});

describe("a campaign this one outranks, and one that is held (#821)", () => {
  it("says this campaign takes the variants, and that reverting gives them back", () => {
    const html = render([overlap({ name: "Clearance", campaignId: "c_clear", keeps: 0, yields: 12, priority: 50 })]);
    expect(html).toContain("also in another campaign, which this one outranks");
    expect(html).toContain("This campaign outranks");
    expect(html).toContain("Reverting this campaign hands");
  });

  it("names a held campaign as held, because it still keeps its prices", () => {
    expect(render([overlap({ status: "HELD" })])).toContain("(held for a hand edit)");
  });
});
