/**
 * The two merchant actions that used to leave no trace.
 *
 * On `dartmode-labs`, within four minutes: a catalogue re-sync from Home, a practice
 * campaign, and a real draft. `/app/activity` then still listed ten entries whose newest
 * was seventeen days old, and Home's Recent activity panel had not moved. On a product
 * whose differentiator is the audit trail — no competitor has one — the panel reads as
 * broken rather than as a quiet shop.
 *
 * ## Why a source check
 *
 * Both writes happen inside a Shopify-authenticated action against a real database, and
 * the thing worth guarding is not the shape of the row — it is that the write is there
 * at all, and that it carries who did it. A test that mocked Prisma to assert an object
 * was passed to it would be asserting the mock.
 */

import { describe, expect, it } from "vitest";

import { iconForAction } from "./action";
import { isHousekeeping } from "./housekeeping";
import { sourceOf } from "../testing/source";

const HOME = sourceOf("app/routes/app._index.tsx");
const MODEL = sourceOf("app/services/campaigns/model.server.ts");

describe("creating a campaign", () => {
  it("writes an entry", () => {
    expect(MODEL).toContain('action: "campaign.created"');
  });

  it("records who, so the log can answer the question it exists for", () => {
    // Not `actor: null` unconditionally: a campaign attributed to nobody on a shop
    // where four people have admin access is a row that cannot settle an argument.
    expect(MODEL).toContain("actor: options.actor ?? null");
  });

  it("is asked for by every route that creates one", () => {
    for (const route of [
      "app/routes/app._index.tsx",
      "app/routes/app.campaigns.new.tsx",
      "app/routes/app.price-import.tsx",
    ]) {
      expect(sourceOf(route), `${route} creates a campaign anonymously`).toMatch(
        /createCampaign\([\s\S]*?\{ actor/,
      );
    }
  });
});

describe("syncing the catalogue", () => {
  it("writes an entry", () => {
    expect(HOME).toContain('action: "catalogue.synced"');
  });

  it("records who pressed the button", () => {
    expect(HOME).toMatch(/action: "catalogue.synced"[\s\S]{0,200}|actor: actorFor\(sessionToken/);
    expect(HOME).toContain("actor: actorFor(sessionToken, session.shop)");
  });
});

describe("both reach the dashboard", () => {
  it.each([["campaign.created"], ["catalogue.synced"]])(
    "%s is not filtered out as the app talking to itself",
    (action) => {
      // `merchantFacing` is a deny-list, so a new namespace arrives on Home by default —
      // this is the check that it has not been added to the wrong side of it.
      expect(isHousekeeping(action)).toBe(false);
    },
  );

  it.each([["campaign.created"], ["catalogue.synced"]])("%s has a glyph of its own", (action) => {
    // The fallback is a blank note icon, which in a column of real glyphs reads as a
    // row the app does not recognise.
    expect(iconForAction(action)).not.toBe("note");
  });
});
