/**
 * A typed amount with more decimals than its currency has is refused, not rounded (#1068).
 *
 * Each form turned the typed text into minor units with `Math.round(value * perMajor)`, and
 * `9.995 * 100` is 999.4999999999999: "Set an exact price 9.995" saved 9.99, 1.005 saved
 * 1.00, and 4.355 saved 4.36. The same half cent went either way by float error, through
 * the campaign editor, the bulk cost form and the minimum-price guardrail, and none of them
 * said that the third decimal was not a price.
 *
 * Through each route's own action, as the forms post. Only `authenticate.admin` is replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { draftCampaignFrom } from "../../app/services/campaigns/draft-input.server";
import { previewDraft } from "../../app/services/campaigns/draft-preview.server";
import { ruleOf } from "../../app/services/campaigns/model.server";
import { guardrailsFor, readSettings } from "../../app/services/settings.server";
import { withChaos } from "../harness/scenario";

let signedIn = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: signedIn }, sessionToken: undefined, admin: {} }),
  },
}));

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

const request = (path: string, fields: Record<string, string>) =>
  ({ request: new Request(`https://example.invalid${path}`, { method: "POST", body: formOf(fields) }), params: {}, context: {} }) as never;

/** The campaign editor's Create. A refusal is thrown, as the route's guard turns it into a page. */
async function create(fields: Record<string, string>): Promise<{ code?: string; userMessage?: string } | Response> {
  const { action } = await import("../../app/routes/app.campaigns.new");
  const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");
  try {
    return (await action(request("/app/campaigns/new", fields))) as Response;
  } catch (thrown) {
    return (thrown as { data?: Record<string, { userMessage?: string; code?: string }> }).data?.[ANCHOR_ERROR] ?? {};
  }
}

async function costs(fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.prices.costs");
  const response = await action(request("/app/prices/costs", fields));
  return (response instanceof Response ? await response.json() : response) as {
    ok: boolean;
    field?: string;
    message: string;
    check?: { key: string; changed: number };
  };
}

async function settings(fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.settings._index");
  return (await action(request("/app/settings", fields))) as { ok: boolean; message: string; problems: string[] };
}

async function campaignNamed(shopId: string, name: string) {
  return prisma.campaign.findFirst({ where: { shopId, name } });
}

async function storedCosts(shopId: string) {
  const rows = await prisma.baseline.findMany({ where: { shopId, supersededAt: null, surfaceKind: "BASE" }, select: { cost: true } });
  return rows.map((row) => row.cost);
}

describe("chaos: a typed amount with more decimals than its currency", () => {
  it("is refused in dollars by the campaign editor, its preview, the cost form and the price floor, and 9.99 is stored exactly", async () => {
    await withChaos("typed-decimals-usd", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      signedIn = domain;

      // The campaign editor. 9.995 rounded to 9.99 and 4.355 to 4.36 before this.
      const refusals: Array<[Record<string, string>, string]> = [
        [
          { name: "Exact 9.995", ruleKind: "set-exact", ruleValue: "9.995" },
          "The exact price 9.995 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 9.99 or 10.00. Nothing was created.",
        ],
        [
          { name: "Exact 1.005", ruleKind: "set-exact", ruleValue: "1.005" },
          "The exact price 1.005 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 1.00 or 1.01. Nothing was created.",
        ],
        [
          { name: "Off 4.355", ruleKind: "fixed-change", ruleValue: "4.355", ruleDirection: "down" },
          "The amount to change by 4.355 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 4.35 or 4.36. Nothing was created.",
        ],
      ];
      for (const [fields, message] of refusals) {
        const answer = (await create(fields)) as { code?: string; userMessage?: string };
        expect(answer.code, fields.name).toBe("VALIDATION");
        expect(answer.userMessage, fields.name).toBe(message);
        expect(await campaignNamed(shopId, fields.name), `${fields.name} was created`).toBeNull();
      }

      // The editor's live preview says the same sentence instead of pricing at 9.99.
      const preview = await previewDraft(shopId, await draftCampaignFrom(shopId, formOf({ ruleKind: "set-exact", ruleValue: "9.995" }), "USD"));
      expect(preview.ruleProblem).toBe("The exact price 9.995 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 9.99 or 10.00.");
      expect(preview.rows).toHaveLength(0);

      // An amount at the currency's precision is stored exactly.
      const created = await create({ name: "Exact 9.99", ruleKind: "set-exact", ruleValue: "9.99" });
      expect((created as Response).headers.get("Location")).toMatch(/^\/app\/campaigns\//);
      expect(ruleOf((await campaignNamed(shopId, "Exact 9.99"))!)).toEqual({ kind: "set-exact", amount: { amount: 999, currency: "USD" } });

      // The bulk cost form refuses for both buttons, and writes nothing.
      const before = await storedCosts(shopId);
      for (const intent of ["dry-run", "commit"]) {
        const refused = await costs({ ruleKind: "set-exact", value: "9.995", intent, checked: "x", expected: "2" });
        expect(refused, intent).toMatchObject({
          ok: false,
          field: "value",
          message: "The amount 9.995 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 9.99 or 10.00. Nothing was checked or changed.",
        });
      }
      expect(await storedCosts(shopId)).toEqual(before);
      const checked = await costs({ ruleKind: "set-exact", value: "9.99", intent: "dry-run" });
      expect(checked.message).toContain("Set every matching cost to 9.99:");

      // The minimum-price guardrail: refused, nothing saved; 9.99 saved and read as 999.
      const settingsBefore = await readSettings(shopId);
      const floor = await settings({ minPrice: "9.995", violationPolicy: "clamp" });
      expect(floor.ok).toBe(false);
      expect(floor.problems).toEqual([
        "Minimum price (USD) 9.995 has 3 decimal places, but USD has 2. Enter it to 2 decimal places, such as 9.99 or 10.00.",
      ]);
      expect(await readSettings(shopId)).toEqual(settingsBefore);

      expect((await settings({ minPrice: "9.99", violationPolicy: "clamp" })).ok).toBe(true);
      expect((await guardrailsFor(shopId)).minPrice).toEqual({ amount: 999, currency: "USD" });
    });
  });

  it("is refused in yen, which has no decimals, and 1500 is stored as 1500", async () => {
    await withChaos("typed-decimals-jpy", { catalog: { products: 2, variantsPerProduct: 1, currency: "JPY" }, percent: -10 }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      signedIn = domain;

      const answer = (await create({ name: "Yen 1500.5", ruleKind: "set-exact", ruleValue: "1500.5" })) as { code?: string; userMessage?: string };
      expect(answer.code).toBe("VALIDATION");
      expect(answer.userMessage).toBe(
        "The exact price 1500.5 has 1 decimal place, but JPY has none. Enter a whole number, such as 1500 or 1501. Nothing was created.",
      );
      expect(await campaignNamed(shopId, "Yen 1500.5")).toBeNull();

      await create({ name: "Yen 1500", ruleKind: "set-exact", ruleValue: "1500" });
      expect(ruleOf((await campaignNamed(shopId, "Yen 1500"))!)).toEqual({ kind: "set-exact", amount: { amount: 1_500, currency: "JPY" } });

      expect(await costs({ ruleKind: "set-exact", value: "1500.5", intent: "dry-run" })).toMatchObject({
        ok: false,
        message: expect.stringMatching(/^The amount 1500\.5 has 1 decimal place, but JPY has none\./),
      });
      expect((await settings({ minPrice: "1500.5" })).problems).toEqual([
        "Minimum price (JPY) 1500.5 has 1 decimal place, but JPY has none. Enter a whole number, such as 1500 or 1501.",
      ]);
    });
  });

  it("allows dinar its third decimal and refuses a fourth, storing 1.005 as 1005 fils", async () => {
    await withChaos("typed-decimals-kwd", { catalog: { products: 2, variantsPerProduct: 1, currency: "KWD" }, percent: -10 }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      signedIn = domain;

      expect(await costs({ ruleKind: "set-exact", value: "1.0005", intent: "dry-run" })).toMatchObject({
        ok: false,
        message:
          "The amount 1.0005 has 4 decimal places, but KWD has 3. Enter it to 3 decimal places, such as 1.000 or 1.001. Nothing was checked or changed.",
      });

      const dry = await costs({ ruleKind: "set-exact", value: "1.005", intent: "dry-run" });
      expect(dry.ok, dry.message).toBe(true);
      const done = await costs({
        ruleKind: "set-exact",
        value: "1.005",
        intent: "commit",
        checked: dry.check?.key ?? "",
        expected: String(dry.check?.changed ?? ""),
      });
      expect(done.ok, done.message).toBe(true);
      expect(await storedCosts(shopId)).toEqual([1_005n, 1_005n]);
    });
  });
});
