/**
 * A form the merchant filled in wrong is not a failure of the app's (#741).
 *
 * Creating a segment with no name was logged at error level, sent to Sentry, written to
 * ErrorEvent and answered with a support reference -- shown in a banner at the top of the
 * page, above the fold from the button. Diagnostics filled with typos, and the error-spike
 * alerts counted them.
 *
 * Through the segments page's own action; then the alerts' own query.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { gather } from "../../app/services/alerting.server";
import { withChaos } from "../harness/scenario";

let pending = { shop: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pending.shop }, sessionToken: { sub: "42" }, admin: {} }),
  },
}));

describe("chaos: a segment with no name", () => {
  it("is refused on its field, with no reference, and writes no error event", async () => {
    await withChaos("validation-not-errors", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      pending = { shop: domain };
      const { action } = await import("../../app/routes/app.settings.segments");
      const body = new FormData();
      body.set("intent", "create-filter");
      body.set("name", "");
      body.set("kind", "DYNAMIC");
      body.set("vendor", "Chaos");

      const answer = (await action({
        request: new Request("https://example.invalid/app/settings/segments", { method: "POST", body }),
        params: {},
        context: {},
      } as never)) as { ok: boolean; message: string; field?: string; errorId?: string | null };

      expect(answer.ok).toBe(false);
      expect(answer.message).toMatch(/Give the segment a name/);
      expect(answer.field, "the refusal does not say which field").toBe("name");
      expect(answer.errorId ?? null, "a typo was given a support reference").toBeNull();
      expect(await prisma.errorEvent.count({ where: { shopId } }), "a typo was stored as a failure").toBe(0);
    });
  });

  it("is not counted by the error-spike alerts, even from rows written before", async () => {
    await withChaos("validation-not-alerted", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId } = chaos.fixture;
      const now = new Date();
      const before = await gather(now);
      for (let i = 0; i < 25; i++) {
        await prisma.errorEvent.create({
          data: {
            errorId: `ANC-VALID-${shopId}-${i}`,
            shopId,
            code: "VALIDATION",
            message: "Give the segment a name",
            userMessage: "Give the segment a name so you can find it when building a campaign.",
          },
        });
      }
      const after = await gather(now);
      expect(after.errors, "old VALIDATION rows counted towards error-spike").toBe(before.errors);
      expect((after.shopRates ?? []).find((rate) => rate.shopId === shopId), "and towards this shop's").toBeUndefined();
    });
  });
});
