/**
 * Reads named variants' base prices from Shopify and corrects the mirror where it differs
 * (#828).
 *
 * A revert plans from the mirror, and leaves alone any variant the mirror says is already
 * where resolution puts it. A scheduled sale's end planned zero rows and marked the
 * campaign "Completed · prices are back" while every sale price was still live: the mirror
 * said baseline and nothing asked Shopify. For the variants a campaign wrote, that answer
 * is too important to take from a copy, so a revert asks Shopify about the ones it is
 * about to skip.
 *
 * The same query and parsing as the nightly mirror audit. Variants Shopify does not know,
 * or whose price cannot be read, are left as they are: this corrects prices, and
 * tombstoning is the audit's business.
 */

import prisma from "../db.server";
import { parseMoney } from "../lib/money/money";
import type { AdminClient } from "../lib/execution/sync-executor";
import { isThrottledError, withRetry } from "../lib/shopify/budget";
import { inChunks } from "../lib/db/chunk";
import { AUDIT_VARIANTS_QUERY } from "./mirror-audit.server";
import { shopCurrency } from "./settings.server";
import type { AnchorAuditVariantsQuery } from "../types/admin.generated";

const BATCH = 100;

/** The variants whose mirrored base price was wrong, now corrected. */
export async function refreshBasePrices(shopId: string, client: AdminClient, variantGids: readonly string[]): Promise<Set<string>> {
  const changed = new Set<string>();
  if (variantGids.length === 0) return changed;

  const fallback = await shopCurrency(shopId);
  const mirrored = await inChunks([...variantGids], (batch) =>
    prisma.priceSurfaceEntry.findMany({
      where: { shopId, variantGid: { in: batch }, surfaceKind: "BASE", priceListGid: "" },
      select: { variantGid: true, livePrice: true, liveCompareAt: true, currency: true },
    }),
  );
  const byGid = new Map(mirrored.map((row) => [row.variantGid, row]));

  for (let i = 0; i < variantGids.length; i += BATCH) {
    const ids = variantGids.slice(i, i + BATCH);
    const response = await withRetry(() => client.request<AnchorAuditVariantsQuery>(AUDIT_VARIANTS_QUERY, { ids }), isThrottledError);

    for (const node of response.data?.nodes ?? []) {
      if (!node || !("price" in node)) continue;
      const row = byGid.get(node.id);
      const currency = row?.currency || fallback;
      const price = minor(node.price, currency);
      const compareAt = minor(node.compareAtPrice, currency);
      if (price === undefined || price === null || compareAt === undefined) continue;
      if (row && row.livePrice === price && row.liveCompareAt === compareAt) continue;

      const now = new Date();
      await prisma.priceSurfaceEntry.updateMany({
        where: { shopId, variantGid: node.id, surfaceKind: "BASE", priceListGid: "" },
        data: { livePrice: price, liveCompareAt: compareAt, syncedAt: now },
      });
      await prisma.variantIndex.updateMany({
        where: { shopId, variantGid: node.id },
        data: { price, compareAt, syncedAt: now },
      });
      changed.add(node.id);
    }
  }
  return changed;
}

function minor(value: string | null | undefined, currency: string): bigint | null | undefined {
  if (!value) return null;
  try {
    return BigInt(parseMoney(value, currency).amount);
  } catch {
    return undefined;
  }
}
