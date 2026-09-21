/**
 * Whether the campaign page hands its components everything the loader loaded.
 *
 * #611: the props bundle was an object literal listing fields by hand, finished with
 * `as CampaignDetailProps`. The literal had drifted six fields behind the loader —
 * `rule`, `scope`, `notifyEmail`, `campaignId`, `note`, `archived` — and the cast is what
 * kept the compiler quiet about it.
 *
 * What it cost was visible in the apply confirmation, the screen that restates a campaign
 * before prices are written: **Rule** and **Applies to** rendered as labels with nothing
 * after them, and **When it finishes** said "Nobody is emailed" on a shop that had an
 * address saved.
 *
 * ## Why this is a source check and not a render
 *
 * The real guard is the type system: with the cast gone, a loader field this bundle drops
 * stops compiling. That is the fix, and it needs no test. What a test can add is the one
 * thing the compiler cannot — stopping the cast from coming back. `tsc` is perfectly
 * happy with `as`, which is the whole problem with it.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";

const route = sourceOf("app/routes/app.campaigns.$id.tsx");

describe("the campaign page's props bundle", () => {
  it("is not cast into shape", () => {
    // `as CampaignDetailProps` silences exactly the check that catches a dropped field.
    expect(
      route,
      "casting the bundle turns a missing loader field back into an empty sentence in the apply dialog",
    ).not.toMatch(/as\s+CampaignDetailProps/);
  });

  it("is spread from the loader payload rather than listed by hand", () => {
    // A hand-written list compiles for as long as somebody remembers to extend it.
    expect(route).toMatch(/const detail: CampaignDetailProps = \{\s*\.\.\.data,/);
  });

  it("still supplies the names the loader does not have", () => {
    // `attention` is the components' shorter name for `needsAttention`, and the fetcher,
    // busy flag, apply gate and revert keepers are all computed here.
    for (const extra of ["fetcher", "busy", "canApply", "attention", "keepers", "keepersPending"]) {
      expect(route, `${extra} is declared on the props type and has to be passed`).toContain(
        `\n    ${extra},`,
      );
    }
  });
});
