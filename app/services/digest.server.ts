/**
 * The weekly summary.
 *
 * Opt-in and quiet by design. Its job is to be the email a merchant can ignore for six
 * weeks and then read in ten seconds when something feels off — so it leads with what
 * is *waiting* for them, and says plainly when nothing is.
 *
 * Sent from the scheduler tick rather than a cron of its own, so there is one thing
 * that runs on a clock and one place to look when it stops.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { notify, readPreferences } from "./notifications.server";

const WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * Sends the digest to any shop that is due one.
 *
 * "Due" is tracked in the audit log rather than on the shop row: it needs no
 * migration, it is the same place every other "we told the merchant something" fact
 * lives, and a missed week leaves a visible gap rather than a silently reset counter.
 */
export async function sendDueDigests(now: Date = new Date()): Promise<number> {
  const shops = await prisma.shop.findMany({
    where: { uninstalledAt: null },
    select: { id: true, domain: true },
  });

  let sent = 0;

  for (const shop of shops) {
    try {
      const preferences = await readPreferences(shop.id);
      if (!preferences.weeklyDigest || !preferences.email) continue;

      const lastSent = await prisma.auditLogEntry.findFirst({
        where: { shopId: shop.id, action: "notification.digest" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });

      // A shop that has never had one waits a full week rather than getting a digest
      // covering the day they installed, which would be an empty email as a welcome.
      const since = lastSent?.createdAt ?? new Date(now.getTime() - WEEK_MS);
      if (now.getTime() - since.getTime() < WEEK_MS) {
        if (lastSent) continue;
      }

      const [campaignsRun, variantsChanged, driftOpen, partialRuns] = await Promise.all([
        prisma.campaignRun.count({ where: { shopId: shop.id, createdAt: { gte: since } } }),
        prisma.variantChange.count({
          where: { shopId: shop.id, status: "VERIFIED", createdAt: { gte: since } },
        }),
        prisma.driftEvent.count({ where: { shopId: shop.id, resolution: "PENDING" } }),
        prisma.campaignRun.count({
          where: { shopId: shop.id, status: "PARTIAL", createdAt: { gte: since } },
        }),
      ]);

      await prisma.auditLogEntry.create({
        data: {
          shopId: shop.id,
          action: "notification.digest",
          entity: "shop",
          entityId: shop.id,
          after: { campaignsRun, variantsChanged, driftOpen, partialRuns },
        },
      });

      const result = await notify(shop.id, {
        kind: "weekly-digest",
        shopName: shop.domain,
        campaignsRun,
        variantsChanged,
        driftOpen,
        partialRuns,
      });

      if (result.sent) sent++;
    } catch (error) {
      // One shop's digest failing must not stop the others, and must never stop a
      // tick that also has campaigns to run.
      logger.warn("digest failed", {
        shop: shop.domain,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return sent;
}
