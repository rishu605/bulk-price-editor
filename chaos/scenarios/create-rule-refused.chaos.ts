/**
 * A campaign whose rule amount is blank or not a number is refused, not priced at 0.01 (#696).
 *
 * `Number("")` is 0, so an exact price left blank saved a campaign setting every price to
 * 0.00, which the resolver clamped to one minor unit: the whole scope previewed, and would
 * have applied, at 0.01, reported as "below your floor". "Reduce by 150%" did the same, and
 * a decimal comma ("1,5") crashed the create action with an unclassified error.
 *
 * Through the create action and the editor's preview, as the form posts them.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { draftCampaignFrom } from "../../app/services/campaigns/draft-input.server";
import { previewDraft } from "../../app/services/campaigns/draft-preview.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: undefined, admin: {} }),
  },
}));

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

describe("chaos: a rule amount the merchant has not given", () => {
  it("is refused at create and said in the preview, and a real amount still creates", async () => {
    await withChaos("create-rule-refused", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      pending = { shop: domain };
      const { action } = await import("../../app/routes/app.campaigns.new");
      const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");

      const create = async (fields: Record<string, string>) => {
        try {
          return await action({
            request: new Request("https://example.invalid/app/campaigns/new", { method: "POST", body: formOf(fields) }),
            params: {},
            context: {},
          } as never);
        } catch (thrown) {
          return (thrown as { data?: Record<string, { userMessage?: string; code?: string }> }).data?.[ANCHOR_ERROR];
        }
      };

      const refusals: Array<[Record<string, string>, RegExp]> = [
        [{ name: "Blank", ruleKind: "set-exact", ruleValue: "" }, /^The exact price is empty\. Enter a number\. Nothing was created\.$/],
        [{ name: "Comma", ruleKind: "set-exact", ruleValue: "1,5" }, /^The exact price "1,5" is not a number\. Use a full stop for decimals, as in 1\.5\. Nothing was created\.$/],
        [{ name: "Free", ruleKind: "percent-change", ruleValue: "150", ruleDirection: "down" }, /^A 150% reduction would make every price free or negative/],
      ];
      for (const [fields, message] of refusals) {
        const answer = (await create(fields)) as { userMessage?: string; code?: string };
        expect(answer?.code, fields.name).toBe("VALIDATION");
        expect(answer?.userMessage, fields.name).toMatch(message);
        expect(await prisma.campaign.count({ where: { shopId, name: fields.name } }), `${fields.name} was created`).toBe(0);
      }

      // The editor's preview says the same, rather than pricing the scope at 0.01.
      const preview = await previewDraft(shopId, await draftCampaignFrom(shopId, formOf({ ruleKind: "set-exact", ruleValue: "" }), "USD"));
      expect(preview.ruleProblem).toBe("The exact price is empty. Enter a number.");
      expect(preview.rows).toHaveLength(0);

      const created = await create({ name: "Real price", ruleKind: "set-exact", ruleValue: "9.99" });
      expect((created as Response).headers.get("Location")).toMatch(/^\/app\/campaigns\//);
    });
  });
});
