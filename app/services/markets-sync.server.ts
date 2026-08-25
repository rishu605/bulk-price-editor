/**
 * Mirroring every market and B2B price list into `price_surface_entries`.
 *
 * Until this existed the app could not see a single market price. Every surface row was
 * written with an empty `priceListGid`, which is to say the base surface and nothing
 * else — so a product positioned as a multi-market price campaign manager had no read
 * side for the markets at all.
 *
 * Two decisions carry the design:
 *
 *   **Base rows live here too.** It is tempting to read base prices from `variant_index`
 *   and reserve this table for markets. Resist it. One uniform shape for "the live value
 *   on surface X" is what lets the resolver, preview, planner and reconciliation treat
 *   base, market and B2B identically instead of branching in four places — and four
 *   branches is four chances for the market path to disagree with the base one about a
 *   merchant's prices.
 *
 *   **A relative list is stored as its rule, never expanded.** Most market lists do not
 *   hold prices; they hold a percentage against the base list and Shopify derives the
 *   rest. Mirroring those per variant would turn one number into two million rows on a
 *   500K-variant catalogue across four markets, all restating the same percentage, all
 *   needing to be kept in step. Only `FIXED` entries — the ones somebody set by hand —
 *   carry information the rule does not already have.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import type { AdminClient } from "../lib/execution/sync-executor";
import { isFixedOrigin, toBasisPoints } from "../lib/markets/adjustment";
import { parseMoney } from "../lib/money/money";
import { isThrottledError, withRetry } from "../lib/shopify/budget";

export const PRICE_LISTS_QUERY = `#graphql
  query AnchorPriceLists($cursor: String) {
    priceLists(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        currency
        parent { adjustment { type value } }
        catalog { id title __typename }
      }
    }
  }
`;

export const PRICE_LIST_PRICES_QUERY = `#graphql
  query AnchorPriceListPrices($id: ID!, $cursor: String) {
    priceList(id: $id) {
      id
      prices(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          originType
          variant { id }
          price { amount currencyCode }
          compareAtPrice { amount currencyCode }
        }
      }
    }
  }
`;

interface PriceListNode {
  id: string;
  name: string;
  currency: string;
  parent?: { adjustment?: { type: string; value: number } | null } | null;
  catalog?: { id: string; title: string; __typename?: string } | null;
}

interface PricesNode {
  originType?: string | null;
  variant?: { id: string } | null;
  price?: { amount: string; currencyCode: string } | null;
  compareAtPrice?: { amount: string; currencyCode: string } | null;
}

export interface MarketsSyncResult {
  priceLists: number;
  relative: number;
  fixed: number;
  /** Per-variant rows written for lists that store prices rather than deriving them. */
  entries: number;
  errors: string[];
}

/**
 * Reads the shop's price-list topology and mirrors what it holds.
 *
 * Serialised against the catalogue bulk query: Shopify permits one bulk operation per
 * shop at a time, and a market sync racing a catalogue sync would have one of them
 * fail with an error about the other that says nothing useful about either.
 */
export async function syncMarkets(
  client: AdminClient,
  shopId: string,
): Promise<MarketsSyncResult> {
  const result: MarketsSyncResult = {
    priceLists: 0,
    relative: 0,
    fixed: 0,
    entries: 0,
    errors: [],
  };

  const running = await prisma.bulkOperationRecord.findFirst({
    where: { shopId, status: { in: ["CREATED", "RUNNING"] } },
    select: { shopifyGid: true },
  });
  if (running) {
    result.errors.push(
      "A catalogue sync is already running for this shop. Market prices are mirrored " +
        "once it finishes — Shopify allows one bulk operation at a time.",
    );
    return result;
  }

  const lists = await readPriceLists(client);
  const seen: string[] = [];

  for (const list of lists) {
    const adjustmentBps = toBasisPoints(list.parent?.adjustment ?? null);

    // A catalog is a market catalog or a company-location one. Absent means B2B in
    // practice: the list is attached to companies rather than to a market.
    const surfaceKind =
      list.catalog?.__typename === "CompanyLocationCatalog" || !list.catalog ? "B2B" : "MARKET";

    await prisma.priceListRecord.upsert({
      where: { shopId_priceListGid: { shopId, priceListGid: list.id } },
      create: {
        shopId,
        priceListGid: list.id,
        name: list.name,
        currency: list.currency,
        surfaceKind,
        catalogGid: list.catalog?.id ?? null,
        catalogTitle: list.catalog?.title ?? null,
        adjustmentBps,
      },
      update: {
        name: list.name,
        currency: list.currency,
        surfaceKind,
        catalogGid: list.catalog?.id ?? null,
        catalogTitle: list.catalog?.title ?? null,
        adjustmentBps,
        syncedAt: new Date(),
      },
    });

    result.priceLists++;
    seen.push(list.id);

    if (adjustmentBps !== null) {
      // Derived. The rule is the mirror; expanding it would restate one percentage
      // once per variant per market.
      result.relative++;
      continue;
    }

    result.fixed++;
    try {
      result.entries += await mirrorFixedPrices(client, shopId, list, surfaceKind);
    } catch (error) {
      result.errors.push(
        `Could not read prices for "${list.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // Lists the merchant deleted in Shopify. Their mirrored rows go too, or a campaign
  // would keep resolving against a surface that no longer exists.
  if (seen.length > 0) {
    const gone = await prisma.priceListRecord.findMany({
      where: { shopId, priceListGid: { notIn: seen } },
      select: { priceListGid: true },
    });
    if (gone.length > 0) {
      const gids = gone.map((row) => row.priceListGid);
      await prisma.priceSurfaceEntry.deleteMany({ where: { shopId, priceListGid: { in: gids } } });
      await prisma.priceListRecord.deleteMany({ where: { shopId, priceListGid: { in: gids } } });
    }
  }

  logger.info("markets mirrored", {
    shopId,
    priceLists: result.priceLists,
    relative: result.relative,
    fixed: result.fixed,
    entries: result.entries,
  });

  return result;
}

async function readPriceLists(client: AdminClient): Promise<PriceListNode[]> {
  const lists: PriceListNode[] = [];
  let cursor: string | null = null;

  for (;;) {
    const response: { data?: { priceLists?: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PriceListNode[] } } } =
      await withRetry(
        () => client.request(PRICE_LISTS_QUERY, cursor ? { cursor } : {}),
        isThrottledError,
      );

    const page = response.data?.priceLists;
    if (!page) break;

    lists.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return lists;
}

/**
 * Mirrors the per-variant prices a fixed list actually stores.
 *
 * `RELATIVE` entries are skipped even here. Shopify returns them alongside fixed ones —
 * they are the parent adjustment already applied — and storing them would make the
 * mirror disagree with itself about whether the list is derived.
 */
async function mirrorFixedPrices(
  client: AdminClient,
  shopId: string,
  list: PriceListNode,
  surfaceKind: "MARKET" | "B2B",
): Promise<number> {
  let cursor: string | null = null;
  let written = 0;

  for (;;) {
    const response: { data?: { priceList?: { prices: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: PricesNode[] } } } } =
      await withRetry(
        () => client.request(PRICE_LIST_PRICES_QUERY, { id: list.id, ...(cursor ? { cursor } : {}) }),
        isThrottledError,
      );

    const page = response.data?.priceList?.prices;
    if (!page) break;

    for (const node of page.nodes) {
      if (!isFixedOrigin(node.originType) || !node.variant?.id || !node.price) continue;

      const currency = node.price.currencyCode ?? list.currency;
      const price = parseMoney(node.price.amount, currency);
      const compareAt = node.compareAtPrice
        ? parseMoney(node.compareAtPrice.amount, node.compareAtPrice.currencyCode ?? currency)
        : null;

      await prisma.priceSurfaceEntry.upsert({
        where: {
          shopId_variantGid_surfaceKind_priceListGid: {
            shopId,
            variantGid: node.variant.id,
            surfaceKind,
            priceListGid: list.id,
          },
        },
        create: {
          shopId,
          variantGid: node.variant.id,
          surfaceKind,
          priceListGid: list.id,
          currency,
          livePrice: BigInt(price.amount),
          liveCompareAt: compareAt ? BigInt(compareAt.amount) : null,
        },
        update: {
          currency,
          livePrice: BigInt(price.amount),
          liveCompareAt: compareAt ? BigInt(compareAt.amount) : null,
          syncedAt: new Date(),
        },
      });

      written++;
    }

    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }

  return written;
}

/** The shop's mirrored surfaces, for the dashboard and the surfaces wizard step. */
export async function surfaces(shopId: string) {
  return prisma.priceListRecord.findMany({
    where: { shopId },
    orderBy: [{ surfaceKind: "asc" }, { name: "asc" }],
  });
}
