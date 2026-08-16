/**
 * Shop record lookup and creation.
 *
 * Every other service keys off a Shop row, so this is the one place that decides a
 * shop exists. Reinstalls reuse the existing row rather than creating a second one:
 * baselines captured before an uninstall are the merchant's history, and losing them
 * would mean every campaign silently re-anchoring to whatever prices happened to be
 * live at reinstall (edge case E18).
 */

import prisma from "../db.server";

export interface ShopRecord {
  id: string;
  domain: string;
  timezone: string;
  initialSyncCompletedAt: Date | null;
}

export async function ensureShop(domain: string): Promise<ShopRecord> {
  const existing = await prisma.shop.findUnique({ where: { domain } });

  if (existing) {
    // Clear the uninstall tombstone on reinstall, keeping all prior data.
    if (existing.uninstalledAt) {
      return prisma.shop.update({
        where: { domain },
        data: { uninstalledAt: null, installedAt: new Date() },
      });
    }
    return existing;
  }

  return prisma.shop.create({ data: { domain } });
}

export async function markSyncComplete(shopId: string): Promise<void> {
  await prisma.shop.update({
    where: { id: shopId },
    data: { initialSyncCompletedAt: new Date() },
  });
}

/** Soft-delete on uninstall. Data is retained for 30 days per RFC-001 §10. */
export async function markUninstalled(domain: string): Promise<void> {
  await prisma.shop
    .update({ where: { domain }, data: { uninstalledAt: new Date() } })
    .catch(() => {
      // Uninstall for a shop we never recorded is not an error worth failing on.
    });
}
