/**
 * Every reply the campaign page's action gives, rendered in its banner (#714).
 *
 * The banner mapped `result.details` unconditionally, and the route asserted a reply type
 * that promised it. Saving or clearing a note, asking for approval, approving, declining
 * and refusing a self-approval reply without `details`, so each one did its work and
 * then replaced the campaign page with the error screen.
 *
 * Archiving and restoring reply the same way.
 *
 * Driven through the page's own action -- only `authenticate.admin` is replaced, with a
 * staff member chosen per press -- and each real reply rendered through `ResultBanner`.
 */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { ResultBanner } from "../../app/components/ResultBanner";
import { withChaos } from "../harness/scenario";

let pending = { shop: "", staff: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: pending.staff },
      admin: {
        async graphql() {
          throw new Error("no Admin API call is expected from these intents");
        },
      },
    }),
  },
}));

async function press(campaignId: string, staff: string, fields: Record<string, string>) {
  pending.staff = staff;
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  const reply = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  if (reply instanceof Response) throw new Error(`${fields.intent} redirected instead of replying`);
  return reply;
}

/** Rendered as the page renders it. Throws where the page would have fallen over. */
const shown = (reply: Awaited<ReturnType<typeof press>>) =>
  renderToStaticMarkup(createElement(ResultBanner, { result: reply }));

describe("chaos: the campaign page's result banner", () => {
  it("renders every reply the housekeeping and approval intents give", async () => {
    await withChaos("campaign-action-banner", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain, campaignId } = chaos.fixture;
      pending = { shop: domain, staff: "" };
      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      await prisma.shop.update({
        where: { id: shopId },
        data: { settings: { ...((shop.settings ?? {}) as object), approvalThreshold: 1 } as never },
      });

      const replies = [
        await press(campaignId, "alice", { intent: "note", note: "Hold until the catalogue is in" }),
        await press(campaignId, "alice", { intent: "note", note: "" }),
        await press(campaignId, "alice", { intent: "request-approval" }),
        await press(campaignId, "alice", { intent: "approve" }),
        await press(campaignId, "bob", { intent: "decline", note: "Not this week" }),
        await press(campaignId, "alice", { intent: "request-approval" }),
        await press(campaignId, "bob", { intent: "approve" }),
        await press(campaignId, "alice", { intent: "archive" }),
        await press(campaignId, "alice", { intent: "unarchive" }),
      ];

      const [saved, cleared, requested, selfApproved, declined, , approved] = replies;
      expect(saved.message).toBe("Note saved.");
      expect(cleared.message).toBe("Note cleared.");
      expect(requested.ok).toBe(true);
      expect(selfApproved.ok, "approving your own request").toBe(false);
      expect(declined.message).toMatch(/Declined/);
      expect(approved.message).toBe("Approved.");

      for (const reply of replies) {
        const markup = shown(reply);
        expect(markup).toContain(reply.message);
        expect(markup).toContain(reply.ok ? 'tone="success"' : 'tone="critical"');
      }
    });
  });
});
