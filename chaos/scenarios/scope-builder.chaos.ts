/**
 * The filter builder, through the real paths (#817, PRD A-2.1 and A-2.3, D32).
 *
 * The engine scoped by AND groups joined by OR, by stock, type and more, and no screen could
 * say any of it. A campaign is made here as the editor's form posts it -- one `scope` field --
 * with two "or" groups (two product types with a stock range; low stock not tagged
 * "no-sale"), one product picked to add and one to leave out. Its count, its preview and its
 * run must all cover exactly the same variants, and a segment saved from the same scope too.
 *
 * Replaced: `authenticate` (no signed requests), `adminClientForShop` and `toAdminClient` (the
 * fixture shop has no Shopify session), `notify` (a recorder) and the web queue (nothing here is
 * large enough to plan in the background).
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { encodeScope, type ScopeDraft } from "../../app/lib/segments/scope-builder";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { listSegments } from "../../app/services/segments-crud.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient, chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, withChaos } from "../harness/scenario";
import { judge } from "../harness/verdict";

let shop = "";
let endpoint = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop }, sessionToken: { sub: "91614707946" }, admin: chaosAdminContext(endpoint) }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return {
    ...actual,
    adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint),
    toAdminClient: (admin: unknown) => (admin as { __chaos?: unknown })?.__chaos ?? actual.toAdminClient(admin as never),
  };
});

vi.mock("../../app/services/notifications.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/services/notifications.server")>()),
  notify: async () => ({ sent: true }),
}));

vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  // Nothing here is large enough to plan in the background, so nothing is enqueued.
  webQueue: () => ({
    async enqueue(name: QueueName, ref: JobRef) {
      void name;
      void ref;
    },
    async depths() {
      return {};
    },
    async close() {},
  }),
}));

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

/** Six products, one variant each, every baseline $100. */
const CATALOG = { catalog: { products: 6, variantsPerProduct: 1 }, percent: -20 } as const;

/** Each variant's type, stock and tags, in fixture order. */
const MIRROR = [
  { productType: "Boots", inventoryQty: 80, tags: ["chaos"] }, // group 1
  { productType: "Boots", inventoryQty: 5, tags: ["chaos"] }, // a boot, but under the stock range
  { productType: "Gloves", inventoryQty: 60, tags: ["chaos"] }, // group 1
  { productType: "Hats", inventoryQty: 100, tags: ["chaos"] }, // picked to add
  { productType: "Hats", inventoryQty: 2, tags: ["chaos"] }, // group 2
  { productType: "Scarves", inventoryQty: 0, tags: ["chaos"] }, // group 2, but picked to leave out
];

async function useShop(chaos: ChaosContext) {
  endpoint = chaos.server.endpoint();
  shop = chaos.fixture.domain;
  const { shopId, variantGids } = chaos.fixture;
  await prisma.baseline.updateMany({ where: { shopId, supersededAt: null }, data: { basePrice: 10_000n } });
  await Promise.all(
    variantGids.map((variantGid, index) =>
      prisma.variantIndex.update({ where: { shopId_variantGid: { shopId, variantGid } }, data: MIRROR[index] }),
    ),
  );
}

/** The scope, as the builder holds it. */
function scopeFor(variantGids: readonly string[]): ScopeDraft {
  return {
    groups: [
      {
        conditions: [
          { field: "productType", values: ["Boots", "Gloves"] },
          { field: "inventoryMin", values: ["50"] },
          { field: "inventoryMax", values: ["90"] },
        ],
      },
      { conditions: [{ field: "inventoryMax", values: ["3"] }, { field: "excludeTag", values: ["no-sale"] }] },
    ],
    include: [variantGids[3]],
    exclude: [variantGids[5]],
  };
}

describe("chaos: a scope from the filter builder", () => {
  it("is counted, previewed, saved and applied over exactly the variants it matches", async () => {
    await withChaos("scope-builder", CATALOG, async (chaos) => {
      const { shopId, variantGids } = chaos.fixture;
      await useShop(chaos);
      const scope = encodeScope(scopeFor(variantGids));
      const matching = [variantGids[0], variantGids[2], variantGids[3], variantGids[4]];

      // The Segments form's live count, as its builder asks for it.
      const { action: count } = await import("../../app/routes/app.scope-count");
      const counted = await count({
        request: new Request("https://example.invalid/app/scope-count", { method: "POST", body: formOf({ scope }) }),
        params: {},
        context: {},
      } as never);
      expect(counted.matched).toBe(4);

      // The editor's live preview, from the same field.
      const { action: draft } = await import("../../app/routes/app.preview-draft");
      const fields = { ruleKind: "percent-change", ruleValue: "20", ruleDirection: "down", compareAt: "leave", scope };
      const previewed = await draft({
        request: new Request("https://example.invalid/app/preview-draft", { method: "POST", body: formOf(fields) }),
        params: {},
        context: {},
      } as never);
      expect(previewed).toMatchObject({ matched: 4, changing: 4, skipped: 0 });

      // Created as the editor posts it: the filter it stores is the builder's.
      const { action: create } = await import("../../app/routes/app.campaigns.new");
      const made = await create({
        request: new Request("https://example.invalid/app/campaigns/new", { method: "POST", body: formOf({ name: "Builder scope", ...fields }) }),
        params: {},
        context: {},
      } as never);
      expect(made).toBeInstanceOf(Response);
      const campaignId = (made as Response).headers.get("Location")!.split("/").pop()!;
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(stored.filter).toEqual({
        groups: [
          {
            conditions: [
              { field: "productType", value: ["Boots", "Gloves"] },
              { field: "inventoryMin", value: 50 },
              { field: "inventoryMax", value: 90 },
            ],
          },
          { conditions: [{ field: "inventoryMax", value: 3 }, { field: "excludeTag", value: "no-sale" }] },
          { conditions: [{ field: "variantGid", value: [variantGids[3]] }] },
        ],
        excludeVariantGids: [variantGids[5]],
        productStatuses: ["ACTIVE"],
      });

      // Its own preview plans the same four.
      const preview = await previewCampaign(shopId, campaignId, { limit: 100 });
      expect(preview.counts.planned).toBe(4);
      expect(preview.rows.map((row) => row.variantGid).sort()).toEqual([...matching].sort());

      // The run writes them, and nothing else.
      const before = variantGids.map((gid) => chaos.fake.priceOf(gid));
      const run = await runCampaign(shopId, campaignId, chaosAdminClient(endpoint), { actor: "chaos", verifySampleRate: 1 });
      expect(run.clean).toBe(true);
      expect(run.verified).toBe(4);
      // Judged as this campaign's run: verified clean, every row read back.
      const verdict = await judge({ ...chaos.fixture, campaignId }, chaos.fake, run.runId);
      expect(verdict.violations).toEqual([]);
      expect(verdict.outcome).toBe("clean");
      expect(variantGids.map((gid) => chaos.fake.priceOf(gid))).toEqual(["80.00", before[1], "80.00", "80.00", "80.00", before[5]]);
      expect(new Set(chaos.fake.writeLog.map((write) => write.variantGid))).toEqual(new Set(matching));

      // A segment saved from the same scope on the Segments form matches the same four.
      const { action: segments } = await import("../../app/routes/app.settings.segments");
      const saved = await segments({
        request: new Request("https://example.invalid/app/settings/segments", {
          method: "POST",
          body: formOf({ intent: "create-filter", name: `Builder ${chaos.seed}`, kind: "DYNAMIC", scope }),
        }),
        params: {},
        context: {},
      } as never);
      expect(saved).toMatchObject({ ok: true });
      const [segment] = (await listSegments(shopId)).filter((row) => row.name === `Builder ${chaos.seed}`);
      expect(segment.size).toBe(4);

      // A stock that is not a whole number is refused by name, and nothing is created.
      const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");
      const refused = await create({
        request: new Request("https://example.invalid/app/campaigns/new", {
          method: "POST",
          body: formOf({ name: "Refused", ...fields, scope: encodeScope({ ...scopeFor(variantGids), groups: [{ conditions: [{ field: "inventoryMin", values: ["lots"] }] }] }) }),
        }),
        params: {},
        context: {},
      } as never).then(
        () => null,
        (thrown: unknown) => (thrown as { data?: Record<string, { userMessage?: string }> }).data?.[ANCHOR_ERROR],
      );
      expect(refused?.userMessage).toBe('Stock at least "lots" is not a whole number. Enter one, such as 50. Nothing was created.');
      expect(await prisma.campaign.count({ where: { shopId, name: "Refused" } })).toBe(0);
    });
  });

  it("reads a form from before the builder as it always did", async () => {
    await withChaos("scope-builder-legacy", CATALOG, async (chaos) => {
      const { shopId } = chaos.fixture;
      await useShop(chaos);
      const { action: create } = await import("../../app/routes/app.campaigns.new");
      const made = await create({
        request: new Request("https://example.invalid/app/campaigns/new", {
          method: "POST",
          body: formOf({ name: "Old fields", ruleKind: "percent-change", ruleValue: "20", ruleDirection: "down", compareAt: "leave", tag: "chaos", excludeTag: "no-sale" }),
        }),
        params: {},
        context: {},
      } as never);
      const campaignId = (made as Response).headers.get("Location")!.split("/").pop()!;
      const stored = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
      expect(stored.filter).toEqual({
        groups: [{ conditions: [{ field: "tag", value: "chaos" }, { field: "excludeTag", value: "no-sale" }] }],
        productStatuses: ["ACTIVE"],
      });
      expect(stored.compareAtViolationPolicy).toBe("clear");
      expect((await previewCampaign(shopId, campaignId, { limit: 100 })).counts.planned).toBe(6);
    });
  });
});
