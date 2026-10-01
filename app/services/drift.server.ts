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
import { AppError } from "../lib/errors/app-error";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { notify } from "./notifications.server";
import { formatMinorUnits } from "../lib/money/format";
import { isKnownCurrency } from "../lib/money/currency";
import { formatMoneyForDisplay, money } from "../lib/money/money";
import { holdForDrift } from "./campaigns/lifecycle.server";

/** How long a write intent stays valid. Generous: webhook delivery is not instant. */
const INTENT_TTL_MS = 15 * 60 * 1000;

/**
 * Stands in for the compare-at of a write that left it alone (#731).
 *
 * A campaign whose compare-at policy is "leave" does not send one, so the echo carries
 * whatever the variant already had -- a value the run never decided and the intent could
 * not know. Hashing `null` for it meant Anchor's own write on any variant with a
 * compare-at failed to match its own intent, was taken for a merchant edit, and held the
 * campaign that had priced the variant before.
 */
const ANY_COMPARE_AT = "any";

function hashValue(price: bigint | null, compareAt: bigint | null | typeof ANY_COMPARE_AT): string {
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
    /** What this write sets it to, or `"leave"` when the write does not touch it. */
    compareAt: bigint | null | "leave";
  }>,
): Promise<void> {
  if (intents.length === 0) return;

  await prisma.writeIntent.createMany({
    data: intents.map((intent) => ({
      shopId,
      variantGid: intent.variantGid,
      surfaceKind: "BASE" as const,
      priceListGid: intent.priceListGid ?? "",
      valueHash: hashValue(intent.price, intent.compareAt === "leave" ? ANY_COMPARE_AT : intent.compareAt),
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
      // This exact value, or this price from a write that left compare-at alone.
      valueHash: { in: [hashValue(price, compareAt), hashValue(price, ANY_COMPARE_AT)] },
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

  // The campaign that controls *this variant*, which is the one that last priced it and
  // is still running.
  //
  // This used to take any ACTIVE campaign on the shop, highest priority first, with no
  // reference to the variant at all — while the doc above claimed the opposite. So a
  // merchant editing one product by hand stopped whichever unrelated campaign happened to
  // be running, and the drift event named a variant that campaign had never priced. On a
  // store running several campaigns at once, which is what this product is for, the
  // highest-priority one absorbed every hand edit in the catalogue.
  //
  // The ledger answers it exactly: a VERIFIED base-surface row is us having written this
  // variant, and its run carries the campaign. Newest first, because a variant repriced by
  // a later campaign is controlled by that one.
  const controlling = await prisma.variantChange.findFirst({
    where: {
      shopId,
      variantGid,
      surfaceKind: "BASE",
      status: "VERIFIED",
      run: { campaign: { status: "ACTIVE" } },
    },
    orderBy: { createdAt: "desc" },
    select: { run: { select: { campaignId: true, campaign: { select: { name: true } } } } },
  });
  if (!controlling) return false;

  const activeCampaign = {
    id: controlling.run.campaignId,
    name: controlling.run.campaign.name,
  };

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

  await notifyDrift(shopId, activeCampaign.id, activeCampaign.name);

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
  /**
   * Whether the storefront still shows the observed price, as far as the mirror knows.
   * A run may have written over it since; then there is no change left to keep (#755).
   */
  stillShown: boolean;
}

export async function pendingDrift(shopId: string, limit = ROWS_PER_VIEW): Promise<DriftRow[]> {
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
  const live = await prisma.priceSurfaceEntry.findMany({
    where: { shopId, surfaceKind: "BASE", priceListGid: "", variantGid: { in: events.map((e) => e.variantGid) } },
    select: { variantGid: true, livePrice: true },
  });
  const liveBy = new Map(live.map((entry) => [entry.variantGid, entry.livePrice]));

  return events.map((event) => ({
    id: event.id,
    variantGid: event.variantGid,
    title: titleBy.get(event.variantGid) ?? event.variantGid,
    observed: formatMinorUnits(event.observedPrice, event.currency),
    expected: formatMinorUnits(event.expectedPrice, event.currency),
    campaignName: event.campaign?.name ?? null,
    detectedAt: event.detectedAt.toISOString(),
    // Unknown counts as still shown: refusing a merchant's choice needs evidence. Only the
    // base price is mirrored here, so an event on another surface is never judged by it.
    stillShown:
      event.priceListGid !== "" ||
      (liveBy.get(event.variantGid) ?? event.observedPrice) === event.observedPrice,
  }));
}

/**
 * Closes the pending drift events a run has just written over (#755).
 *
 * A held campaign could still be applied, and its run wrote the campaign's price over the
 * merchant's edit -- leaving the drift queue asking about a price no longer on the
 * storefront, with "Keep the change" one click from adopting it as the baseline. Whatever
 * the run wrote and read back now stands, so each such event is the campaign's price
 * reasserted: said so, with who ran it, and written to the audit log.
 */
export async function resolveOverwrittenDrift(
  shopId: string,
  runId: string,
  variantGids: readonly string[],
  actor?: string,
): Promise<number> {
  if (variantGids.length === 0) return 0;

  const ids: string[] = [];
  for (let i = 0; i < variantGids.length; i += 5_000) {
    const pending = await prisma.driftEvent.findMany({
      where: {
        shopId,
        resolution: "PENDING",
        surfaceKind: "BASE",
        priceListGid: "",
        variantGid: { in: variantGids.slice(i, i + 5_000) },
      },
      select: { id: true },
    });
    ids.push(...pending.map((event) => event.id));
  }
  if (ids.length === 0) return 0;

  // Together, so an event never closes without the entry that says why.
  await prisma.$transaction([
    prisma.driftEvent.updateMany({
      where: { id: { in: ids }, resolution: "PENDING" },
      data: { resolution: "REASSERTED", resolvedAt: new Date(), resolvedBy: actor ?? `run:${runId}` },
    }),
    prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: actor ?? null,
        action: "drift.overwritten",
        entity: "CampaignRun",
        entityId: runId,
        after: { events: ids.length, reason: "the run wrote the campaign's price over an edit made outside Anchor" } as never,
      },
    }),
  ]);
  return ids.length;
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

  // Adopting makes the observed price the baseline, so it must still be the price on the
  // storefront. A run that wrote over it since left an event describing a price that is
  // gone, and adopting that would have every later campaign compute from it (#755).
  if (resolution === "adopt" && event.observedPrice !== null) {
    const entry = await prisma.priceSurfaceEntry.findFirst({
      where: { shopId, variantGid: event.variantGid, surfaceKind: "BASE", priceListGid: event.priceListGid },
      select: { livePrice: true },
    });
    if (entry?.livePrice != null && entry.livePrice !== event.observedPrice) {
      throw new AppError({
        code: "VALIDATION",
        userMessage:
          `The storefront no longer shows ${shown(event.observedPrice, event.currency)} for this variant ` +
          `-- it shows ${shown(entry.livePrice, event.currency)} -- so there is no change to keep. Nothing was adopted. ` +
          "Choose Put it back or Leave it for now.",
      });
    }
  }

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

/**
 * Tells the merchant that prices are being changed underneath a running campaign.
 *
 * Rate-limited to one email per campaign per hour, and it has to be. A bulk edit in
 * Shopify's admin fires a webhook per product; without this, retagging a collection
 * during a sale would put several hundred identical emails in somebody's inbox, and
 * the next real one would arrive somewhere below them.
 *
 * The count is read at send time rather than incremented, so the one email that does
 * go out reports the whole burst rather than the first of it.
 */
async function notifyDrift(shopId: string, campaignId: string, campaignName: string): Promise<void> {
  const HOUR = 60 * 60_000;
  const since = new Date(Date.now() - HOUR);

  const [pending, alreadyTold] = await Promise.all([
    prisma.driftEvent.count({ where: { shopId, campaignId, resolution: "PENDING" } }),
    prisma.auditLogEntry.count({
      where: {
        shopId,
        action: "notification.drift",
        entityId: campaignId,
        createdAt: { gte: since },
      },
    }),
  ]);

  if (alreadyTold > 0) return;

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      action: "notification.drift",
      entity: "campaign",
      entityId: campaignId,
      after: { pending },
    },
  });

  void notify(shopId, { kind: "drift-hold", campaignId, campaignName, driftedCount: pending });
}

/** A price as a merchant reads it in a sentence: "$2.34", not "2.34". */
function shown(amount: bigint, currency: string): string {
  return isKnownCurrency(currency)
    ? formatMoneyForDisplay(money(Number(amount), currency))
    : `${formatMinorUnits(amount, currency)} ${currency}`;
}
