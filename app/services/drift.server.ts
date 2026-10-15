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
import { adoptBaselines } from "./baseline-adopt.server";
import { AppError } from "../lib/errors/app-error";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { notify } from "./notifications.server";
import { formatMinorUnits, formatPrice } from "../lib/money/format";
import { auditMoney } from "../lib/audit/money";
import { holdForDrift, releaseHold } from "./campaigns/lifecycle.server";
import { LANDED } from "../lib/execution/landed";
import { endingAmong } from "./campaigns/model.server";

/** Campaigns that keep their prices live, so a hand edit to one of them is drift (#878). */
const DRIFT_CONTROLLING = ["ACTIVE", "PARTIAL", "HELD"] as const;

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
 * Whether a products delivery stamped in the same second as one of our writes to this
 * variant describes it from before that write (#985).
 *
 * A product with more than 250 variants in scope is written in several calls, and each
 * one sends its own `products/update`. Shopify stamps `updated_at` to the second, so two
 * calls a moment apart carry the same time, and deliveries are not ordered. The first
 * call's snapshot shows a variant the second call wrote at its old price. Arriving after
 * that write was recorded, it is not older to the second, so it was applied: the old price
 * went back into the mirror and was taken for a hand edit, and a revert planned from that
 * mirror found the variant already back at its baseline and left the sale price live.
 *
 * The ledger recognises it: a landed write of ours to this variant, stamped this second,
 * replacing exactly this price. A merchant's edit in the same second sets some other price
 * and is still drift (#932). The one case it cannot tell apart is an edit within that
 * second back to the very price the write replaced.
 */
export async function predatesOurWrite(
  shopId: string,
  variantGid: string,
  stamp: Date,
  price: bigint | null,
): Promise<boolean> {
  if (price === null) return false;
  const write = await prisma.variantChange.findFirst({
    where: {
      shopId,
      variantGid,
      surfaceKind: "BASE",
      priceListGid: "",
      status: { in: [...LANDED] },
      remoteUpdatedAt: stamp,
      beforePrice: price,
      intendedPrice: { not: price },
    },
    select: { id: true },
  });
  return write !== null;
}

/**
 * Which of these values are the echo of something we wrote recently: `isOurEcho` for a
 * whole webhook's variants in one query.
 */
export async function ourEchoes(
  shopId: string,
  values: Array<{ variantGid: string; price: bigint | null; compareAt: bigint | null }>,
): Promise<Set<string>> {
  const priced = values.filter((value) => value.price !== null);
  if (priced.length === 0) return new Set();

  const hashesOf = (value: (typeof priced)[number]) => [
    hashValue(value.price, value.compareAt),
    hashValue(value.price, ANY_COMPARE_AT),
  ];
  const matches = await prisma.writeIntent.findMany({
    where: {
      shopId,
      variantGid: { in: priced.map((value) => value.variantGid) },
      valueHash: { in: priced.flatMap(hashesOf) },
      writtenAt: { gte: new Date(Date.now() - INTENT_TTL_MS) },
    },
    select: { variantGid: true, valueHash: true },
  });

  // The query matched any variant's hash against any variant; only a variant's own counts.
  const found = new Set(matches.map((match) => `${match.variantGid}|${match.valueHash}`));
  return new Set(
    priced
      .filter((value) => hashesOf(value).some((hash) => found.has(`${value.variantGid}|${hash}`)))
      .map((value) => value.variantGid),
  );
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
  //
  // Any campaign keeping its prices live, not only an ACTIVE one (#878). A held campaign
  // still controls its variants, and taking ACTIVE alone meant every edit after the first
  // was dropped: a second edit left its event showing a price the storefront no longer
  // had, and an edit to another of its variants recorded nothing, so the queue never asked
  // about it and the next Apply wrote over it unrecorded. Partial is included for the same
  // reason, and is what `holdForDrift` already holds. A campaign being ended is not: it is
  // handing its variants back, not keeping them.
  const controlling = await prisma.variantChange.findFirst({
    where: {
      shopId,
      variantGid,
      surfaceKind: "BASE",
      status: { in: [...LANDED] },
      run: { campaign: { status: { in: [...DRIFT_CONTROLLING] } } },
    },
    orderBy: { createdAt: "desc" },
    select: { run: { select: { campaignId: true, campaign: { select: { name: true, status: true } } } } },
  });
  if (!controlling) return false;
  if ((await endingAmong([controlling.run.campaignId])).size > 0) return false;

  const activeCampaign = {
    id: controlling.run.campaignId,
    name: controlling.run.campaign.name,
  };
  // Already held: the merchant has been told, and holding it again would change nothing.
  const alreadyHeld = controlling.run.campaign.status === "HELD";

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

  if (!alreadyHeld) await notifyDrift(shopId, activeCampaign.id, activeCampaign.name);

  // Hold the campaign as well as recording the event. Recording alone would leave the
  // campaign looking healthy while it quietly stopped controlling one of its prices.
  await holdForDrift(shopId, activeCampaign.id, variantGid);

  return true;
}

export interface DriftRow {
  id: string;
  variantGid: string;
  title: string;
  sku: string | null;
  observed: string | null;
  expected: string | null;
  currency: string;
  /** Whether the edit raised or lowered the campaign's price; null when either is unknown. */
  direction: "up" | "down" | null;
  campaignId: string | null;
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
  return driftRowsFor(shopId, events);
}

type EventWithCampaign = Awaited<ReturnType<typeof prisma.driftEvent.findMany>>[number] & {
  campaign: { name: string } | null;
};

/**
 * Events as the queue and its export show them: the variant by its title, both prices in
 * their currency, and whether the edit is still on the storefront. Two lookups however many
 * events there are; the caller has already chosen which.
 */
export async function driftRowsFor(shopId: string, events: readonly EventWithCampaign[]): Promise<DriftRow[]> {
  const gids = [...new Set(events.map((e) => e.variantGid))];
  const [titles, live] = await Promise.all([
    prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: gids } },
      select: { variantGid: true, title: true, sku: true },
    }),
    prisma.priceSurfaceEntry.findMany({
      where: { shopId, surfaceKind: "BASE", priceListGid: "", variantGid: { in: gids } },
      select: { variantGid: true, livePrice: true },
    }),
  ]);
  const variantBy = new Map(titles.map((t) => [t.variantGid, t]));
  const liveBy = new Map(live.map((entry) => [entry.variantGid, entry.livePrice]));

  return events.map((event) => ({
    id: event.id,
    variantGid: event.variantGid,
    title: variantBy.get(event.variantGid)?.title ?? event.variantGid,
    sku: variantBy.get(event.variantGid)?.sku ?? null,
    observed: formatMinorUnits(event.observedPrice, event.currency),
    expected: formatMinorUnits(event.expectedPrice, event.currency),
    currency: event.currency,
    direction:
      event.observedPrice === null || event.expectedPrice === null || event.observedPrice === event.expectedPrice
        ? null
        : event.observedPrice > event.expectedPrice
          ? "up"
          : "down",
    campaignId: event.campaignId,
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
  kind: "APPLY" | "REVERT",
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
        after: {
          events: ids.length,
          kind,
          reason:
            kind === "REVERT"
              ? "the revert wrote the price without this campaign over an edit made outside Anchor"
              : "the run wrote the campaign's price over an edit made outside Anchor",
        } as never,
      },
    }),
  ]);
  return ids.length;
}

/**
 * The variant a drift event is about, by its title, for the sentence that says what a
 * decision did (#796): "Ignored." twice in a row was the same words twice, so a screen
 * reader did not announce the second, and neither said which price it was about.
 */
export async function driftTitle(shopId: string, eventId: string): Promise<string | null> {
  const event = await prisma.driftEvent.findFirst({ where: { id: eventId, shopId }, select: { variantGid: true } });
  if (!event) return null;
  const variant = await prisma.variantIndex.findFirst({
    where: { shopId, variantGid: event.variantGid },
    select: { title: true },
  });
  return variant?.title ?? null;
}

export type DriftResolution = "adopt" | "reassert" | "ignore";

/**
 * Resolves a drift event by keeping the merchant's price: as the new baseline, or as is.
 *
 * "adopt" supersedes the current baseline with the observed price, which is the only
 * one of the three that changes what future campaigns compute from — so it is the
 * one worth being sure about.
 *
 * "reassert" is not here. It used to only mark the event, on the promise that the
 * campaign's next run would rewrite the price -- a run that never came for a manual
 * campaign, or for a held one the scheduler skips (#756). Putting the price back is a
 * write, so it is a run: `reassertDrift`.
 *
 * Either way the decision the hold was waiting for has been made, so a campaign with
 * nothing left pending runs again.
 */
export async function resolveDrift(
  shopId: string,
  eventId: string,
  resolution: Exclude<DriftResolution, "reassert">,
  actor: string,
): Promise<{ released: boolean }> {
  const event = await prisma.driftEvent.findFirstOrThrow({
    where: { id: eventId, shopId },
  });
  // A second answer to a question already answered -- a stale page, a double click, a
  // run that wrote over the edit in the meantime -- must not rewrite the first.
  if (event.resolution !== "PENDING") {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        `This price drift was already resolved (${event.resolution.toLowerCase()}${event.resolvedBy ? ` by ${event.resolvedBy}` : ""}). ` +
        "Nothing was changed. Reload the page to see what is still waiting.",
    });
  }

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
          `The storefront no longer shows ${formatPrice(event.observedPrice, event.currency)} for this variant ` +
          `-- it shows ${formatPrice(entry.livePrice, event.currency)} -- so there is no change to keep. Nothing was adopted. ` +
          "Choose Put it back or Leave it for now.",
      });
    }
  }

  if (resolution === "adopt" && event.observedPrice !== null) {
    // With the old baseline's compare-at and cost carried over (#1013), as the bulk keep does.
    await prisma.$transaction((tx) =>
      adoptBaselines(
        tx,
        shopId,
        [{ variantGid: event.variantGid, priceListGid: event.priceListGid, currency: event.currency, observedPrice: event.observedPrice! }],
        actor ?? null,
      ),
    );
  }

  await prisma.driftEvent.update({
    where: { id: eventId },
    data: {
      resolution: resolution === "adopt" ? "ADOPTED" : "IGNORED",
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
      // The price with its currency, so the log can say "$701.00" rather than "70100" (#757).
      // `String(...)` wrote the bare minor units, which read as $70,100 -- and as the right
      // answer in a zero-decimal currency, so a merchant could not tell which they had.
      after: { variantGid: event.variantGid, observedPrice: auditMoney(event.observedPrice, event.currency) } as never,
    },
  });

  const released = event.campaignId ? await releaseHold(shopId, event.campaignId, actor) : null;
  return { released: released?.changed ?? false };
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
 * The limit is a claim, not a check (#806). It used to count this hour's notifications
 * and send when there were none -- but a bulk edit's webhooks arrive together, and
 * every one of them counted before the first had written its entry. On anchor-perf one
 * burst logged 219 notifications for one campaign inside a minute; a shop with an alert
 * address would have had 219 emails. Reading the last notification still decides whether
 * one is due. Which caller sends it is decided by the primary key: every caller that read
 * the same last notification inserts the same next one, the database admits exactly one
 * of them, and only that one sends. A caller whose read was stale tries an id the winner
 * already holds, and stops there. No lock and no transaction, so a burst that is already
 * short of connections (#803) spends one more statement on this, not a held connection.
 *
 * The count is read at send time rather than incremented, so the one email that does
 * go out reports the whole burst rather than the first of it.
 */
async function notifyDrift(shopId: string, campaignId: string, campaignName: string): Promise<void> {
  const HOUR = 60 * 60_000;
  const since = new Date(Date.now() - HOUR);

  // Newest first with `id` breaking ties, so every caller agrees which one is last even
  // among entries written in the same millisecond, as a burst from before this fix could be.
  const last = await prisma.auditLogEntry.findFirst({
    where: { shopId, action: "notification.drift", entityId: campaignId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, createdAt: true },
  });
  if (last && last.createdAt >= since) return;

  const pending = await prisma.driftEvent.count({ where: { shopId, campaignId, resolution: "PENDING" } });

  // `ON CONFLICT DO NOTHING`: a caller that lost the race inserts nothing and is told so,
  // rather than failing a webhook over an email somebody else is already sending.
  const claimed = await prisma.auditLogEntry.createMany({
    data: [
      {
        id: driftNoticeId(campaignId, last?.id ?? null),
        shopId,
        action: "notification.drift",
        entity: "campaign",
        entityId: campaignId,
        after: { pending },
      },
    ],
    skipDuplicates: true,
  });
  if (claimed.count === 0) return;

  void notify(shopId, { kind: "drift-hold", campaignId, campaignName, driftedCount: pending });
}

/**
 * The id of the drift notification that follows `previousId` for this campaign (#806).
 *
 * Derived, not generated, which is the whole of the rate limit's concurrency: callers that
 * saw the same last notification compute the same id, so only one of their inserts lands.
 * Keyed on the predecessor rather than on an hour bucket, so the window stays a rolling
 * hour -- a burst straddling 09:00 is one burst, not two emails a second apart -- and so a
 * pruned or erased log cannot leave an id taken that nobody can see. Hashed because the
 * predecessor's id is usually one of these, and nesting them would grow without bound.
 */
function driftNoticeId(campaignId: string, previousId: string | null): string {
  const digest = createHash("sha256")
    .update(`${campaignId}|${previousId ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  return `drift-notice-${digest}`;
}
