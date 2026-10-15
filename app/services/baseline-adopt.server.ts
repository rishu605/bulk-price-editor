import type { Prisma } from "@prisma/client";

/** A drifted price being kept: the variant, its surface, and the price it now shows. */
export interface Adoption {
  variantGid: string;
  priceListGid: string;
  currency: string;
  observedPrice: bigint;
}

/**
 * Makes kept prices the new baselines, carrying over what the old baselines knew (#1013).
 *
 * "Keep the change" made a baseline with only the price, so the superseded baseline's
 * compare-at and cost were dropped: a later campaign's compare-at policy found none, and
 * a cost imported into the baseline (#737) was gone. One function for the single and the
 * bulk keep (#822), so they cannot disagree.
 *
 * - **Compare-at** comes from the superseded baseline, not the storefront: the live
 *   compare-at may be a campaign's own strike-through, and adopting that would make a
 *   sale's artefact the price every later campaign computes from -- the compounding this
 *   product exists to prevent.
 * - **Cost** is Shopify's where it holds one (the base price's mirrored cost, as #737
 *   carries it on sync), and the superseded baseline's otherwise.
 *
 * Inside the caller's transaction, with the drift events it is resolving.
 */
export async function adoptBaselines(
  tx: Prisma.TransactionClient,
  shopId: string,
  adoptions: readonly Adoption[],
  actor: string | null,
  now: Date = new Date(),
): Promise<void> {
  if (adoptions.length === 0) return;
  const variantGids = [...new Set(adoptions.map((row) => row.variantGid))];
  const key = (variantGid: string, priceListGid: string) => `${variantGid}@${priceListGid}`;

  const [current, mirrored] = await Promise.all([
    tx.baseline.findMany({
      where: { shopId, surfaceKind: "BASE", supersededAt: null, variantGid: { in: variantGids } },
      select: { variantGid: true, priceListGid: true, baseCompareAt: true, cost: true },
    }),
    tx.variantIndex.findMany({
      where: { shopId, variantGid: { in: variantGids } },
      select: { variantGid: true, cost: true },
    }),
  ]);
  const previous = new Map(current.map((row) => [key(row.variantGid, row.priceListGid), row]));
  const shopifyCost = new Map(mirrored.map((row) => [row.variantGid, row.cost]));

  for (const priceListGid of new Set(adoptions.map((row) => row.priceListGid))) {
    await tx.baseline.updateMany({
      where: {
        shopId,
        surfaceKind: "BASE",
        priceListGid,
        supersededAt: null,
        variantGid: { in: adoptions.filter((row) => row.priceListGid === priceListGid).map((row) => row.variantGid) },
      },
      data: { supersededAt: now },
    });
  }

  await tx.baseline.createMany({
    data: adoptions.map((row) => {
      const old = previous.get(key(row.variantGid, row.priceListGid));
      // A market's cost is in its own currency, and Shopify's mirrored cost is the shop's.
      const live = row.priceListGid === "" ? shopifyCost.get(row.variantGid) : null;
      return {
        shopId,
        variantGid: row.variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: row.priceListGid,
        currency: row.currency,
        basePrice: row.observedPrice,
        baseCompareAt: old?.baseCompareAt ?? null,
        cost: live ?? old?.cost ?? null,
        source: "DRIFT_ADOPTION" as const,
        capturedBy: actor,
      };
    }),
  });
}
