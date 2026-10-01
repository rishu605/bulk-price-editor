/**
 * What's live never calls a price nobody's campaign set "what a running campaign looks
 * like" (#745). Checked against the source, because the page needs a data router.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

const LIVE = sourceOf("app/routes/app.prices.live.tsx");
const HOME = sourceOf("app/routes/app._index.tsx");
const RECAPTURE = sourceOf("app/routes/app.prices.baselines.recapture.tsx");

describe("What's live, about prices away from their baseline", () => {
  it("credits a campaign only with the cells a campaign put there", () => {
    expect(LIVE).not.toContain("which is what a running campaign looks like");
    expect(LIVE).toContain("counts.offBaseline - counts.staleBaseline > 0");
    expect(LIVE).toContain("away from their baseline because a campaign is running on them.");
  });

  it("names the rest as out-of-date baselines, with a recapture scoped to them", () => {
    expect(LIVE).toContain("counts.staleBaseline > 0 ?");
    expect(LIVE).toContain('href="/app/prices/baselines/recapture?segment=stale"');
    expect(LIVE).toContain('value="stale-baseline"');
  });
});

describe("Home and recapture, about the same prices", () => {
  it("Home says how many of \"Not at baseline\" were changed outside a campaign, only when some were", () => {
    expect(HOME).toContain("staleBaselineCount(shop.id)");
    expect(HOME).toContain("health.staleBaselines > 0 ?");
    expect(HOME).toContain('href="/app/prices/live?state=stale-baseline"');
  });

  it("recapture offers them as a scope of their own", () => {
    expect(RECAPTURE).toContain("<s-option value={STALE_SCOPE} defaultSelected={segmentId === STALE_SCOPE}>");
    expect(RECAPTURE).toContain("recaptureScopeFrom(segmentId)");
  });
});
