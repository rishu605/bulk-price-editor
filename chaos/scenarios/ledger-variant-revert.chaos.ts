/**
 * "Revert this variant" through the campaign page's own loader and action (#764).
 *
 * On dartmode-labs, *QA · apply-revert* was Completed: applied, then reverted. Its Ledger
 * tab opened on the revert and offered the button on every row; a press wrote nothing
 * visible and took the variant out of the campaign for good, so the next apply skipped
 * it. The action checked nothing -- not the campaign's state, not whether the campaign had
 * ever priced the variant, not even that a variant was named: a missing field arrived as
 * the string "null" and was excluded like any other. And `?run=` was taken as given, so
 * one campaign's page would draw another's ledger and post that campaign's variants here.
 *
 * The button's half is rendered in `campaign-ledger-tab.test.tsx`. This is the server's:
 * every press the page would not offer is refused, and refused without changing anything
 * -- which is the part that matters, because the exclusion it would have made is silent.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      admin: {
        async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
          const response = await fetch(pending.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: options?.variables ?? {} }),
          });
          return { json: () => response.json() };
        },
      },
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(pending.endpoint) };
});

type Reply = { ok: boolean; message: string; errorId?: string | null };

/** A press on the campaign page, with exactly the fields given -- nothing filled in. */
async function press(campaignId: string, fields: Record<string, string>): Promise<Reply> {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as Reply;
}

async function open(campaignId: string, query: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  return loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}${query}`),
    params: { id: campaignId },
    context: {},
  } as never);
}

/** What a refused press must leave exactly as it was. */
async function untouched(chaos: ChaosContext) {
  const { campaignId } = chaos.fixture;
  const [campaign, runs] = await Promise.all([
    prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { excludedVariantGids: true, status: true } }),
    prisma.campaignRun.count({ where: { campaignId } }),
  ]);
  return { excluded: campaign.excludedVariantGids, status: campaign.status, runs, prices: chaos.livePrices() };
}

const sale = (chaos: ChaosContext, gid: string) => (Math.round(chaos.fixture.baseline.get(gid)! * 0.75) / 100).toFixed(2);
const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -25 } as const;

describe("chaos: Revert this variant on a campaign that has already been reverted", () => {
  it("is refused, excludes nothing, and the next apply still prices the variant", async () => {
    await withChaos("ledger-variant-revert-completed", CATALOG, async (chaos) => {
      const { domain, campaignId, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      const [victim] = variantGids;

      expect((await press(campaignId, { intent: "apply", confirmation: "apply" })).ok).toBe(true);
      expect((await press(campaignId, { intent: "revert" })).ok).toBe(true);
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("COMPLETED");

      // The live case: the tab opened on the revert, and that is the run its button was on.
      const page = await open(campaignId, "?tab=ledger");
      expect(page.ledgerRun?.kind).toBe("REVERT");

      const before = await untouched(chaos);
      const reply = await press(campaignId, { intent: "revert-variant", variantGid: victim });

      expect(reply.ok).toBe(false);
      expect(reply.message).toMatch(/has been reverted, so its prices are already off your storefront/);
      expect(reply.message, "the refusal does not say what to do instead").toMatch(/edit which products the campaign applies to/);
      expect(reply.errorId ?? null, "a refusal was filed as a fault").toBeNull();
      expect(await untouched(chaos), "a refused press changed something").toEqual(before);

      // The consequence the issue is about: applied again, the variant is priced like the rest.
      expect((await press(campaignId, { intent: "apply", confirmation: "apply" })).ok).toBe(true);
      expect(chaos.fake.priceOf(victim), "the variant was silently left out of the re-apply").toBe(sale(chaos, victim));
      expect(chaos.fake.priceOf(victim)).not.toBe((baseline.get(victim)! / 100).toFixed(2));
    });
  });
});

describe("chaos: Revert this variant on a campaign that is not live", () => {
  it("is refused on a draft, whose prices were never written", async () => {
    await withChaos("ledger-variant-revert-draft", CATALOG, async (chaos) => {
      const { domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };

      const before = await untouched(chaos);
      const reply = await press(campaignId, { intent: "revert-variant", variantGid: variantGids[0] });

      expect(reply.ok).toBe(false);
      expect(reply.message).toMatch(/has not been applied/);
      expect(await untouched(chaos)).toEqual(before);
    });
  });

  it("is refused while another run writes the campaign", async () => {
    await withChaos("ledger-variant-revert-applying", CATALOG, async (chaos) => {
      const { domain, campaignId, variantGids } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      await chaos.expectHonest((await chaos.apply()).runId);
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "APPLYING" } });

      const before = await untouched(chaos);
      const reply = await press(campaignId, { intent: "revert-variant", variantGid: variantGids[0] });

      expect(reply.ok).toBe(false);
      expect(reply.message).toMatch(/is being applied right now.*Wait for that run to finish/);
      expect(await untouched(chaos)).toEqual(before);
    });
  });
});

describe("chaos: a press that does not name a variant this campaign priced", () => {
  it("rejects a missing or malformed variant instead of excluding the string 'null'", async () => {
    await withChaos("ledger-variant-revert-malformed", CATALOG, async (chaos) => {
      const { domain, campaignId } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      await chaos.expectHonest((await chaos.apply()).runId);
      const before = await untouched(chaos);

      const presses: Record<string, string>[] = [
        { intent: "revert-variant" },
        { intent: "revert-variant", variantGid: "null" },
        { intent: "revert-variant", variantGid: "" },
        { intent: "revert-variant", variantGid: "gid://shopify/Product/1" },
        { intent: "reinstate-variant" },
      ];
      for (const fields of presses) {
        const reply = await press(campaignId, fields);
        expect(reply.ok, JSON.stringify(fields)).toBe(false);
        expect(reply.message).toMatch(/did not name a variant, so nothing was changed/);
        expect(reply.errorId ?? null).toBeNull();
      }

      const after = await untouched(chaos);
      expect(after.excluded, '"null" was excluded from the campaign').toEqual([]);
      expect(after).toEqual(before);
    });
  });

  it("refuses a variant this campaign never wrote", async () => {
    await withChaos("ledger-variant-revert-stranger", CATALOG, async (chaos) => {
      const { domain, campaignId } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      await chaos.expectHonest((await chaos.apply()).runId);
      const before = await untouched(chaos);

      const reply = await press(campaignId, {
        intent: "revert-variant",
        variantGid: "gid://shopify/ProductVariant/priced-by-another-campaign",
      });

      expect(reply.ok).toBe(false);
      expect(reply.message).toMatch(/has never written a price for this variant/);
      expect(await untouched(chaos)).toEqual(before);
    });
  });
});

describe("chaos: a run the URL names that belongs to another campaign", () => {
  it("is ignored, and the page shows this campaign's newest run", async () => {
    await withChaos("ledger-variant-revert-foreign-run", CATALOG, async (chaos) => {
      const { domain, shopId, campaignId } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      const client = chaosAdminClient(chaos.server.endpoint());

      // Another sale over the same products, applied first so its ledger has rows of its own.
      const other = await createCampaign(shopId, {
        name: "chaos/other-sale",
        priority: 50,
        rule: { kind: "percent-change", percent: -10 },
        compareAtPolicy: { kind: "leave" },
        rounding: { default: "none", byCurrency: {} },
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        schedule: { kind: "manual" },
      } as never);
      const theirs = await runCampaign(shopId, other.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(theirs.verified, "the other campaign wrote nothing, so this tests nothing").toBeGreaterThan(0);
      const ours = await chaos.apply();
      await chaos.expectHonest(ours.runId);

      const page = await open(campaignId, `?tab=ledger&run=${theirs.runId}`);

      expect(page.selectedRunId, "another campaign's ledger drawn under this one's name").toBe(ours.runId);
      expect(page.ledgerRun?.kind).toBe("APPLY");
      const ourRows = await prisma.variantChange.count({ where: { runId: ours.runId } });
      expect(page.ledgerTotal).toBe(ourRows);

      // And a run that is this campaign's is still honoured.
      const revert = await chaos.revert();
      expect((await open(campaignId, `?tab=ledger&run=${ours.runId}`)).selectedRunId).toBe(ours.runId);
      expect((await open(campaignId, "?tab=ledger")).selectedRunId).toBe(revert.runId);
    });
  });
});

describe("chaos: the press the page does offer", () => {
  it("still reverts the variant out of a running campaign", async () => {
    await withChaos("ledger-variant-revert-live", CATALOG, async (chaos) => {
      const { domain, campaignId, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };
      await chaos.expectHonest((await chaos.apply()).runId);
      const [victim, ...others] = variantGids;

      const reply = await press(campaignId, { intent: "revert-variant", variantGid: victim });

      expect(reply.ok, reply.message).toBe(true);
      expect(chaos.fake.priceOf(victim)).toBe((baseline.get(victim)! / 100).toFixed(2));
      for (const gid of others) expect(chaos.fake.priceOf(gid)).toBe(sale(chaos, gid));
      const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(campaign.excludedVariantGids).toEqual([victim]);
      expect(campaign.status).toBe("ACTIVE");
    });
  });
});
