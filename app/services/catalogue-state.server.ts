import prisma from "../db.server";
import { catalogueStateFrom, type CatalogueState } from "../lib/catalogue/state";

/** Whether this shop has a catalogue to price yet (#800). One count and one row. */
export async function catalogueState(shopId: string): Promise<CatalogueState> {
  const [shop, variants] = await Promise.all([
    prisma.shop.findUnique({ where: { id: shopId }, select: { initialSyncCompletedAt: true, syncStartedAt: true } }),
    prisma.variantIndex.count({ where: { shopId, deletedAt: null } }),
  ]);
  return catalogueStateFrom({
    variants,
    synced: Boolean(shop?.initialSyncCompletedAt),
    syncing: Boolean(shop?.syncStartedAt),
  });
}
