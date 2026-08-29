/**
 * Support is reachable from where the problem is, not only from the nav.
 *
 * NA puts a contact line in the footer of every page. Ours was a nav item, which is one
 * navigation away from whatever just went wrong — and on an error screen or a held
 * campaign that is exactly the wrong moment to ask somebody to go and find it.
 *
 * A source-level check because the surfaces are the point: these three are the ones a
 * merchant is on when they need a person, and it is the *linking* that keeps regressing,
 * not the route.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const SURFACES: { file: string; why: string }[] = [
  {
    file: "app/components/ErrorScreen.tsx",
    why: "the screen with the error id on it, which is the thing support needs quoted",
  },
  {
    file: "app/components/campaign/CampaignHeader.tsx",
    why: "a Held or Partial campaign — the two states this product is about",
  },
  {
    file: "app/routes/app.help.tsx",
    why: "the help page, for a question the articles do not answer",
  },
];

/**
 * A control a merchant can press, not merely the string somewhere in the file.
 *
 * The first version of this checked for `/app/support` anywhere in the source, and a
 * mutation that deleted the entire button passed — because the helper that builds the URL
 * was still sitting there with the path in it. A guard that a deletion cannot fail is not
 * guarding anything.
 */
const LINKED = /<s-button[^>]*href=\{?(?:"\/app\/support|`\/app\/support|supportHref\()/s;

describe("the surfaces that link to support", () => {
  it.each(SURFACES)("$file — $why", ({ file }) => {
    expect(sourceOf(file)).toMatch(LINKED);
  });

  it("carries context rather than dropping the merchant on an empty form", () => {
    // A contact form reached with no context is the nav item again. The error screen
    // attaches the error id, the campaign header the campaign, and both attach the page.
    expect(sourceOf("app/components/ErrorScreen.tsx")).toContain("error");
    expect(sourceOf("app/components/campaign/CampaignHeader.tsx")).toContain("campaign:");
  });
});
