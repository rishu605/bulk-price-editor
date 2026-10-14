/**
 * Paging the full preview shows every row exactly once, in the same order on every load
 * (#769).
 *
 * The full preview re-plans the whole scope on every page and shows that page's slice of
 * it, so the slices only add up to the whole if the plan comes back in the same order
 * each time. It came back in whatever order Postgres returned `variant_index` rows, which
 * nothing fixed: on a live store two variants a sync had just rewritten jumped to the
 * front of page 1 between two loads a few minutes apart, and a merchant paging through
 * would have seen some rows twice and others never. That page exists to keep one
 * promise -- "showing the first 25" need not be taken on trust -- and it could not.
 *
 * Driven through the route's own loader, so the slicing is the page's and not a copy of
 * it. The catalogue is retitled so that title order is neither the order the rows were
 * inserted nor the order of their ids, two products share a name so the tie-break is
 * exercised, and page 1's rows are then rewritten the way a sync rewrites them, which is
 * what moved them on the store.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { draftCampaignFrom } from "../../app/services/campaigns/draft-input.server";
import { previewDraft } from "../../app/services/campaigns/draft-preview.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { ROWS_PER_VIEW } from "../../app/lib/ui/table-budget";
import { withChaos } from "../harness/scenario";

/** Who the next request authenticates as. Mutable, because the mock is bound once. */
let pendingShop = "";

// The one boundary that needs a real Shopify session. Everything past it -- the query
// string, the draft, the resolver, Prisma -- is the real code.
vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pendingShop }, sessionToken: undefined }),
  },
}));

/**
 * One name per fixture product, in fixture order. Neither alphabetical nor id order, with
 * "Cascade Gloves" twice so equal titles have to be told apart by something, and a 2 and
 * a 12 so the order is a person's ("2" before "12") rather than a byte comparison's.
 */
const PRODUCT_NAMES = [
  "Summit Jacket",
  "Cascade Gloves",
  "Alpine Boots 12",
  "Glacier Pack",
  "Cascade Gloves",
  "Alpine Boots 2",
  "Everest Helmet",
  "Basecamp Tent",
];
const SIZES = ["XS", "S", "M", "L", "XL"];

/** Forty variants: two full pages and a partial third, so the last slice is short. */
const CATALOG = { products: PRODUCT_NAMES.length, variantsPerProduct: SIZES.length };

/** The editor's fields for 20% off the whole catalogue, as its full-preview link carries them. */
const FIELDS = "ruleKind=percent-change&ruleValue=20&ruleDirection=down";

interface PreviewPage {
  rows: Array<{ variantGid: string; title: string }>;
  total: number;
  page: number;
  pages: number;
}

type Loader = (args: never) => Promise<unknown>;

async function open(loader: Loader, page: number): Promise<PreviewPage> {
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/preview?${FIELDS}&page=${page}`),
    params: {},
    context: {},
  } as never)) as PreviewPage;
}

/** Every page from the first to the last, as a merchant clicking Next would see them. */
async function pageThrough(loader: Loader): Promise<PreviewPage[]> {
  const first = await open(loader, 1);
  const rest = [];
  for (let page = 2; page <= first.pages; page++) rest.push(await open(loader, page));
  return [first, ...rest];
}

describe("chaos: the full preview pages through a fixed order", () => {
  it("shows every variant exactly once, in title order, and the same order after a sync", async () => {
    await withChaos("preview-order", { catalog: CATALOG, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids } = chaos.fixture;
      pendingShop = domain;

      // Retitled last product first, so the rows' physical order is the reverse of the
      // order they were created in as well as different from their titles' order.
      const titleOf = new Map<string, string>();
      for (const [index, variantGid] of [...variantGids.entries()].reverse()) {
        const title = `${PRODUCT_NAMES[Math.floor(index / SIZES.length)]} · ${SIZES[index % SIZES.length]}`;
        titleOf.set(variantGid, title);
        await prisma.variantIndex.update({
          where: { shopId_variantGid: { shopId, variantGid } },
          data: { title },
        });
      }

      const loader = (await import("../../app/routes/app.campaigns.preview")).loader as Loader;
      const pages = await pageThrough(loader);
      const paged = pages.flatMap((page) => page.rows.map((row) => row.variantGid));

      expect(pages.map((page) => page.rows.length), "two full pages and a short third").toEqual([
        ROWS_PER_VIEW,
        ROWS_PER_VIEW,
        variantGids.length - 2 * ROWS_PER_VIEW,
      ]);
      expect(pages.every((page) => page.total === variantGids.length)).toBe(true);
      expect(new Set(paged).size, "a variant appeared on more than one page").toBe(paged.length);
      expect(new Set(paged), "a variant appeared on no page").toEqual(new Set(variantGids));

      // The pages, end to end, are the preview: the same plan with no limit at all.
      const draft = await draftCampaignFrom(shopId, new URLSearchParams(FIELDS), "USD");
      const whole = await previewDraft(shopId, draft, variantGids.length);
      expect(paged, "the pages put together are not the whole preview").toEqual(
        whole.rows.map((row) => row.variantGid),
      );

      // Title order, spelled out rather than recomputed with the comparator under test. A
      // shared title is broken by the variant's id, so the two "Cascade Gloves" products
      // interleave size by size, the one created first leading each pair.
      const names = ["Alpine Boots 2", "Alpine Boots 12", "Basecamp Tent", "Cascade Gloves", "Cascade Gloves", "Everest Helmet", "Glacier Pack", "Summit Jacket"];
      const sizes = ["L", "M", "S", "XL", "XS"];
      const expected: string[] = [];
      for (const name of new Set(names)) {
        const copies = names.filter((n) => n === name).length;
        for (const size of sizes) for (let i = 0; i < copies; i++) expected.push(`${name} · ${size}`);
      }
      expect(paged.map((gid) => titleOf.get(gid)), "rows are not in title order").toEqual(expected);
      const gloves = paged.filter((gid) => titleOf.get(gid) === "Cascade Gloves · M");
      expect(gloves, "equal titles are not ordered by variant id").toEqual(
        [...gloves].sort((a, b) => (a < b ? -1 : 1)),
      );

      // The editor's panel shows the first rows of the same list, not another 25.
      const panel = await previewDraft(shopId, draft);
      expect(panel.rows.map((row) => row.variantGid), "the panel's rows are not the full preview's first rows").toEqual(
        paged.slice(0, panel.rows.length),
      );

      // And the campaign page, previewing a campaign with the same rule over the same
      // variants, lists them in the same order.
      const campaignPage = await previewCampaign(shopId, campaignId, { limit: variantGids.length });
      expect(campaignPage.rows.map((row) => row.variantGid), "the campaign page orders its preview differently").toEqual(
        paged,
      );

      // A sync rewrites page 1's rows, as one did on the store this was found on. Their
      // titles are unchanged, so nothing a merchant can see about them moved -- and neither
      // may their place in the list.
      for (const variantGid of paged.slice(0, ROWS_PER_VIEW)) {
        await prisma.variantIndex.update({
          where: { shopId_variantGid: { shopId, variantGid } },
          data: { syncedAt: new Date(), remoteUpdatedAt: new Date() },
        });
      }

      const again = (await pageThrough(loader)).flatMap((page) => page.rows.map((row) => row.variantGid));
      expect(again, "a sync that changed no title moved rows between pages").toEqual(paged);
    });
  });
});
