/**
 * A priority of 0 is saved as 0, and a revert buffer of 0 as 0 (#727).
 *
 * Both were read as `Number(value) || default`, and `0 || 100` is `100`: a merchant who
 * typed 0 to make a campaign the lowest priority got 100, which outranked their
 * priority-50 campaign, so on the variants they shared the wrong price won. A buffer of 0,
 * no early revert, became five minutes.
 *
 * Through the create action and the editor's preview, as the form posts them -- the two
 * must read the form the same way (rule 4).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { draftCampaignFrom } from "../../app/services/campaigns/draft-input.server";
import { chaosAdminContext } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };

// An `admin` the fake answers: a create with dates asks Shopify for the store's zone (#799).
vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: chaosAdminContext(pending.endpoint) }),
  },
}));

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

describe("chaos: a priority and a revert buffer of 0", () => {
  it("are saved as 0 by the create action, and read as 0 by the preview", async () => {
    await withChaos("zero-priority", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      const { action } = await import("../../app/routes/app.campaigns.new");

      const fields = {
        name: "Lowest priority",
        ruleKind: "percent-change",
        ruleValue: "10",
        ruleDirection: "down",
        priority: "0",
        startDate: "2030-01-10",
        startTime: "09:00",
        endDate: "2030-01-12",
        endTime: "09:00",
        revertBuffer: "0",
      };
      const response = (await action({
        request: new Request("https://example.invalid/app/campaigns/new", { method: "POST", body: formOf(fields) }),
        params: {},
        context: {},
      } as never)) as Response;
      expect(response.headers.get("Location")).toMatch(/^\/app\/campaigns\//);

      const saved = await prisma.campaign.findFirstOrThrow({ where: { shopId, name: "Lowest priority" } });
      expect(saved.priority, "priority 0 was saved as the default").toBe(0);
      expect((saved.schedule as { revertBufferMinutes?: number }).revertBufferMinutes, "a 0-minute buffer was saved as 5").toBe(0);

      // The preview reads the same form the same way.
      const draft = await draftCampaignFrom(shopId, formOf(fields), "USD");
      expect(draft.priority).toBe(0);
    });
  });
});
