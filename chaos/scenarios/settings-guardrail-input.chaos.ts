/**
 * The Settings save refuses a guardrail it would otherwise have bent (#739).
 *
 * "150" in Minimum margin was saved as 99.9 and "-5" in Minimum price as 0, under
 * "Settings saved." -- a floor of a thousand times cost, and the next 20%-off draft priced
 * a $68.86 jacket at $36,160.01. The save also read an approval threshold no control on
 * the page renders, so every save switched approvals off.
 *
 * Driven through the page's own action; only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { readSettings } from "../../app/services/settings.server";
import { readPreferences } from "../../app/services/notifications.server";
import { withChaos } from "../harness/scenario";

let signedIn = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: signedIn }, sessionToken: undefined, admin: {} }),
  },
}));

async function save(fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.settings._index");
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return (await action({
    request: new Request("https://example.invalid/app/settings", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as { ok: boolean; message: string; problems: string[] };
}

describe("chaos: saving guardrails", () => {
  it("refuses 150% and -5 by name, writes nothing, and keeps approvals on through a good save", async () => {
    await withChaos("settings-guardrail-input", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      signedIn = domain;
      const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
      await prisma.shop.update({
        where: { id: shopId },
        data: { settings: { ...((shop.settings ?? {}) as object), approvalThreshold: 50, minMarginPercent: 20 } as never },
      });
      const before = await readSettings(shopId);
      const emailBefore = (await readPreferences(shopId)).email;

      const refused = await save({ minMarginPercent: "150", minPrice: "-5", email: "someone-new@example.com" });
      expect(refused.ok, "a 150% margin was saved").toBe(false);
      expect(refused.problems).toHaveLength(2);
      expect(refused.problems.join(" ")).toMatch(/Minimum margin \(%\) must be a number from 0 to 99\.9/);
      expect(refused.problems.join(" ")).toMatch(/Minimum price \(USD\) must be zero or more/);
      expect(await readSettings(shopId)).toEqual(before);
      expect((await readPreferences(shopId)).email, "a refused save still wrote the notifications").toBe(emailBefore);

      const saved = await save({ minMarginPercent: "25", minPrice: "4.99", violationPolicy: "skip" });
      expect(saved.ok).toBe(true);
      const after = await readSettings(shopId);
      expect(after.minMarginPercent).toBe(25);
      expect(after.minPrice).toBe(4.99);
      expect(after.approvalThreshold, "an ordinary save switched approvals off").toBe(50);
    });
  });
});
