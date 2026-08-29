/**
 * Every notification about a campaign carries a way back to it.
 *
 * The bug this covers was invisible in both halves. `campaignUrl` was optional on the
 * notification type, so nothing complained that no caller set it; the template's `link()`
 * helper rendered an empty string for a missing URL, so nothing looked wrong in the
 * output either. The result was an email that said "Open the campaign to review and
 * resume" and then stopped — sent to somebody who by definition was not looking at the
 * app, about a run that had gone partial.
 *
 * The same shape as every other contract bug here: two halves that only a third party
 * ever checks. So the link is built inside `notify`, where the shop is already being
 * read, and this is the third party.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: { shop: { findUnique: vi.fn() } },
}));
vi.mock("../db.server", () => ({ default: prisma }));

import { notify } from "./notifications.server";

const KEY = "5401aeddaf37aac5c9e1650bf6abb462";

const COUNTS = { verified: 3, failed: 1, unverified: 0, skipped: 0, clamped: 0 };

/** The body Resend was asked to send, or null if it was never called. */
function sentBody(fetchMock: ReturnType<typeof vi.fn>): { text: string; subject: string } | null {
  const call = fetchMock.mock.calls[0];
  return call ? JSON.parse(String((call[1] as { body: string }).body)) : null;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("NOTIFICATION_FROM_EMAIL", "anchor@example.com");
  vi.stubEnv("SHOPIFY_API_KEY", KEY);
  // One mock for both reads `notify` makes: the preferences, and the domain the link is
  // built from. The real `readPreferences` runs against it rather than being stubbed —
  // a stub there would have hidden that the shop row is read twice.
  prisma.shop.findUnique.mockResolvedValue({
    domain: "boltify-apps.myshopify.com",
    settings: { notifications: { email: "ops@shop.com", onCompletion: true } },
  });
});

describe("a run notification", () => {
  it("carries a link into the campaign it is about", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notify("shop", {
      kind: "run-partial",
      campaignId: "c1",
      campaignName: "Summer sale",
      counts: COUNTS,
    });

    expect(sentBody(fetchMock)?.text).toContain(
      `https://admin.shopify.com/store/boltify-apps/apps/${KEY}/app/campaigns/c1`,
    );
  });

  it("still sends when there is no link to include", async () => {
    // Local development and self-hosted installs have no API key. The email losing one
    // line is fine; the email not arriving because of a missing link would not be.
    vi.stubEnv("SHOPIFY_API_KEY", "");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await notify("shop", {
      kind: "run-partial",
      campaignId: "c1",
      campaignName: "Summer sale",
      counts: COUNTS,
    });

    expect(result.sent).toBe(true);
    expect(sentBody(fetchMock)?.text).not.toContain("admin.shopify.com");
  });
});

describe("a drift notification", () => {
  it("links to the queue, not to a campaign page", async () => {
    // Drift is a queue of variants a merchant edited under running campaigns. Sending
    // them to one campaign would answer a narrower question than the one being raised.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    await notify("shop", {
      kind: "drift-hold",
      campaignId: "c1",
      campaignName: "Summer sale",
      driftedCount: 4,
    });

    expect(sentBody(fetchMock)?.text).toContain("/app/prices/drift");
  });
});
