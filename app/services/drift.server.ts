/**
 * Drift detection: noticing when someone changes a price outside the app while a
 * campaign is running.
 *
 * The merchant made that edit on purpose. Naive apps either clobber it on the next
 * run or restore the wrong value on revert; neither is acceptable. So the app
 * detects the change and asks, offering three resolutions that mean genuinely
 * different things:
 *
 *   adopt     — the new price becomes the baseline. The edit was a permanent
 *               repricing, and future campaigns should compute from it.
 *   reassert  — the campaign price is rewritten. The edit was a mistake.
 *   ignore    — leave it alone this time.
 *
 * Self-echo suppression is what makes any of this possible. Every price we write
 * produces a products/update webhook moments later; without a record of intent the
 * app would flag its own writes as drift and generate a flood of false events.
 */

import { createHash } from "node:crypto";

import prisma from "../db.server";
import { formatMinorUnits } from "../lib/money/format";
import { holdForDrift } from "./campaigns/lifecycle.server";

/** How long a write intent stays valid. Generous: webhook delivery is not instant. */
const INTENT_TTL_MS = 15 * 60 * 1000;

function hashValue(price: bigint | null, compareAt: bigint | null): string {
  return createHash("sha256")
    .update(`${price ?? "null"}|${compareAt ?? "null"}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Records that we are about to write a value, so the resulting webhook can be
 * recognised as our own echo rather than a merchant edit.
 */
export async function recordWriteIntents(
  shopId: string,
  intents: Array<{
    variantGid: string;
    priceListGid?: string;
    price: bigint | null;
    compareAt: bigint | null;
  }>,
): Promise<void> {
  if (intents.length === 0) return;

  await prisma.writeIntent.createMany({
    data: intents.map((intent) => ({
      shopId,
      variantGid: intent.variantGid,
      surfaceKind: "BASE" as const,
      priceListGid: intent.priceListGid ?? "",
      valueHash: hashValue(intent.price, intent.compareAt),
    })),
  });
}

/** True when this value matches something we wrote recently. */
export async function isOurEcho(
  shopId: string,
  variantGid: string,
  price: bigint | null,
  compareAt: bigint | null,
): Promise<boolean> {
  const match = await prisma.writeIntent.findFirst({
    where: {
      shopId,
      variantGid,
      valueHash: hashValue(price, compareAt),
      writtenAt: { gte: new Date(Date.now() - INTENT_TTL_MS) },
    },
    select: { id: true },
  });
  return match !== null;
}

/**
 * Examines an incoming price for a variant and records drift if warranted.
 *
 * Drift is deliberately narrow: it means the price changed *while a campaign
 * controls the variant*. Outside a campaign a price change is just the merchant
 * running their store, and flagging that would make the queue useless noise.
 */
export async function checkForDrift(
  shopId: string,
  variantGid: string,
  incomingPrice: bigint | null,
  incomingCompareAt: bigint | null,
): Promise<boolean> {
  if (incomingPrice === null) return false;

  const entry = await prisma.priceSurfaceEntry.findUnique({
    where: {
      shopId_variantGid_surfaceKind_priceListGid: {
        shopId,
        variantGid,
        surfaceKind: "BASE",
        priceListGid: "",
      },
    },
    select: { livePrice: true, currency: true },
  });

  // Nothing recorded yet, or unchanged from what we last saw: not drift.
  if (!entry || entry.livePrice === null) return false;
  if (entry.livePrice === incomingPrice) return false;

  if (await isOurEcho(shopId, variantGid, incomingPrice, incomingCompareAt)) return false;

  // Only meaningful while a campaign controls this variant.
  const activeCampaign = await prisma.campaign.findFirst({
    where: { shopId, status: "ACTIVE" },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });
  if (!activeCampaign) return false;

  // Collapse repeats: one open event per variant, updated rather than duplicated.
  const existing = await prisma.driftEvent.findFirst({
    where: { shopId, variantGid, surfaceKind: "BASE", resolution: "PENDING" },
    select: { id: true },
  });

  if (existing) {
    await prisma.driftEvent.update({
      where: { id: existing.id },
      data: { observedPrice: incomingPrice, detectedAt: new Date() },
    });
    await holdForDrift(shopId, activeCampaign.id, variantGid);
    return true;
  }

  await prisma.driftEvent.create({
    data: {
      shopId,
      variantGid,
      surfaceKind: "BASE",
      priceListGid: "",
      campaignId: activeCampaign.id,
      observedPrice: incomingPrice,
      expectedPrice: entry.livePrice,
      currency: entry.currency,
      resolution: "PENDING",
    },
  });

  // Hold the campaign as well as recording the event. Recording alone would leave the
  // campaign looking healthy while it quietly stopped controlling one of its prices.
  await holdForDrift(shopId, activeCampaign.id, variantGid);

  return true;
}

export interface DriftRow {
  id: string;
  variantGid: string;
  title: string;
  observed: string | null;
  expected: string | null;
  campaignName: string | null;
  detectedAt: string;
}

export async function pendingDrift(shopId: string, limit = 100): Promise<DriftRow[]> {
  const events = await prisma.driftEvent.findMany({
    where: { shopId, resolution: "PENDING" },
    orderBy: { detectedAt: "desc" },
    take: limit,
    include: { campaign: { select: { name: true } } },
  });

  const titles = await prisma.variantIndex.findMany({
    where: { shopId, variantGid: { in: events.map((e) => e.variantGid) } },
    select: { variantGid: true, title: true },
  });
  const titleBy = new Map(titles.map((t) => [t.variantGid, t.title ?? t.variantGid]));

  return events.map((event) => ({
    id: event.id,
    variantGid: event.variantGid,
    title: titleBy.get(event.variantGid) ?? event.variantGid,
    observed: formatMinorUnits(event.observedPrice, event.currency),
    expected: formatMinorUnits(event.expectedPrice, event.currency),
    campaignName: event.campaign?.name ?? null,
    detectedAt: event.detectedAt.toISOString(),
  }));
}

export type DriftResolution = "adopt" | "reassert" | "ignore";

/**
 * Resolves a drift event.
 *
 * "adopt" supersedes the current baseline with the observed price, which is the only
 * one of the three that changes what future campaigns compute from — so it is the
 * one worth being sure about. "reassert" only marks the event; the campaign's next
 * run rewrites the price, because writing here would bypass the ledger.
 */
export async function resolveDrift(
  shopId: string,
  eventId: string,
  resolution: DriftResolution,
  actor?: string,
): Promise<void> {
  const event = await prisma.driftEvent.findFirstOrThrow({
    where: { id: eventId, shopId },
  });

  if (resolution === "adopt" && event.observedPrice !== null) {
    await prisma.$transaction(async (tx) => {
      await tx.baseline.updateMany({
        where: {
          shopId,
          variantGid: event.variantGid,
          surfaceKind: "BASE",
          priceListGid: event.priceListGid,
          supersededAt: null,
        },
        data: { supersededAt: new Date() },
      });

      await tx.baseline.create({
        data: {
          shopId,
          variantGid: event.variantGid,
          surfaceKind: "BASE",
          priceListGid: event.priceListGid,
          currency: event.currency,
          basePrice: event.observedPrice!,
          source: "DRIFT_ADOPTION",
          capturedBy: actor ?? null,
        },
      });
    });
  }

  await prisma.driftEvent.update({
    where: { id: eventId },
    data: {
      resolution:
        resolution === "adopt"
          ? "ADOPTED"
          : resolution === "reassert"
            ? "REASSERTED"
            : "IGNORED",
      resolvedAt: new Date(),
      resolvedBy: actor ?? null,
    },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: actor ?? null,
      action: `drift.${resolution}`,
      entity: "DriftEvent",
      entityId: eventId,
      after: { variantGid: event.variantGid, observedPrice: String(event.observedPrice) },
    },
  });
}

/** Removes expired write intents so the table stays bounded. */
export async function pruneWriteIntents(): Promise<number> {
  const result = await prisma.writeIntent.deleteMany({
    where: { writtenAt: { lt: new Date(Date.now() - INTENT_TTL_MS) } },
  });
  return result.count;
}
