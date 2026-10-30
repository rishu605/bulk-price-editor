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
import { inRunChunks } from "../lib/db/run-writes.server";
import { adoptBaselines } from "./baseline-adopt.server";
import { AppError } from "../lib/errors/app-error";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { notify } from "./notifications.server";
import { formatMinorUnits, formatPrice } from "../lib/money/format";
import { auditMoney } from "../lib/audit/money";
import { holdForDrift, releaseHold } from "./campaigns/lifecycle.server";
import { LANDED } from "../lib/execution/landed";
import { endingAmong } from "./campaigns/model.server";
import { inheritorOf } from "./campaigns/handover.server";

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

  // A run records every price it is about to write here, so this was one createMany of the
  // whole plan -- 102,132 rows, split by Prisma into one long transaction. `RUN_CHUNK` rows
  // a statement now, each retried on a transient error (#810). A retried batch cannot
  // double up: P2024 and P2034 mean it never committed.
  await inRunChunks("drift.write-intents", intents, (batch) =>
    prisma.writeIntent.createMany({
      data: batch.map((intent) => ({
        shopId,
        variantGid: intent.variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: intent.priceListGid ?? "",
        valueHash: hashValue(intent.price, intent.compareAt === "leave" ? ANY_COMPARE_AT : intent.compareAt),
      })),
    }),
  );
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

/** One products delivery, as the mirror would record it, for `deliveryIsOurEcho`. */
export interface DeliveryEchoCheck {
  productGid: string;
  /** The product's own fields, as the webhook would write them to every variant's row. */
  status: string;
  vendor: string | null;
  productType: string | null;
  tags: readonly string[];
  variants: ReadonlyArray<{
    variantGid: string;
    price: bigint | null;
    compareAt: bigint | null;
    title: string | null;
    sku: string | null;
    barcode: string | null;
    inventoryQty: number | null;
  }>;
  /** Every variant the delivery says the product still has, or null when it cannot say (#729). */
  stillThere: ReadonlySet<string> | null;
}

/**
 * Whether a whole products delivery is nothing but the echo of Anchor's own writes (#811),
 * so the worker can drop it before any mirror, drift or enrolment work.
 *
 * A campaign's write produces one `products/update` per product it touched, and a 100k run
 * produces thousands; each used to cost a mirror upsert per variant, a drift lookup per
 * variant and an enrolment pass, which is the flood that kept the app at its pool timeout
 * (#803). Asked here in one statement instead.
 *
 * "Ours" is `ourEchoes`' rule exactly -- the same two hashes, the same fifteen minutes --
 * because a looser one would drop a merchant's price edit as ours. But a delivery whose
 * prices are ours can still carry something else: the merchant retagging, retitling or
 * removing a variant in the minutes after a run wrote it, or the run's own tag kit. Those
 * the mirror has to learn, so a delivery is dropped only when it would change nothing but
 * prices that are ours:
 *
 *   - at least one variant's price and compare-at match a recent write of ours;
 *   - every variant it describes is mirrored, live, on this product, with the title, SKU,
 *     barcode, stock, status, vendor, type and tags it shows, and is either ours or at the
 *     price and compare-at the mirror already holds;
 *   - where it lists the product's variants, they are the ones the mirror has live, so no
 *     tombstone or new variant is waiting in it.
 *
 * Anything else is handled in full, as before: the safe answer when in doubt is "not ours",
 * which costs the work this exists to save and never a merchant's edit. Spelling is not a
 * change -- an empty SKU and none, tags in another order -- so a mirror the catalogue sync
 * wrote compares equal to the webhook's view of the same product. Anything that still
 * differs sends the first echo of a product the long way, and that one leaves the row as
 * the webhook spells it, so the rest drop.
 *
 * The price is left as the mirror had it. The run settles the mirror from its ledger when it
 * finishes (`settleMirror`), stamped with the version its write produced, so the echo's copy
 * of the same price was only ever an earlier arrival of that.
 */
export async function deliveryIsOurEcho(shopId: string, delivery: DeliveryEchoCheck): Promise<boolean> {
  if (delivery.variants.length === 0) return false;

  const since = new Date(Date.now() - INTENT_TTL_MS);
  const variants = delivery.variants;
  const text = (value: bigint | number | null) => (value === null ? null : String(value));
  const still = delivery.stillThere ? [...delivery.stillThere] : null;

  const rows = await prisma.$queryRaw<Array<{ echo: boolean }>>`
    WITH d AS (
      SELECT * FROM unnest(
        ${variants.map((v) => v.variantGid)}::text[],
        ${variants.map((v) => hashValue(v.price, v.compareAt))}::text[],
        ${variants.map((v) => hashValue(v.price, ANY_COMPARE_AT))}::text[],
        ${variants.map((v) => text(v.price))}::text[],
        ${variants.map((v) => text(v.compareAt))}::text[],
        ${variants.map((v) => v.title)}::text[],
        ${variants.map((v) => v.sku)}::text[],
        ${variants.map((v) => v.barcode)}::text[],
        ${variants.map((v) => text(v.inventoryQty))}::text[]
      ) AS d(gid, exact, "anyCompareAt", price, compare, title, sku, barcode, qty)
    ),
    judged AS (
      SELECT
        d.price IS NOT NULL AND EXISTS (
          SELECT 1 FROM "write_intents" w
          WHERE w."shopId" = ${shopId} AND w."variantGid" = d.gid
            AND w."valueHash" IN (d.exact, d."anyCompareAt")
            AND w."writtenAt" >= (${since}::timestamptz AT TIME ZONE 'UTC')
        ) AS ours,
        COALESCE(
          v."variantGid" IS NOT NULL
          AND v."deletedAt" IS NULL
          AND v."productGid" = ${delivery.productGid}
          AND NULLIF(v."title", '') IS NOT DISTINCT FROM NULLIF(d.title, '')
          AND NULLIF(v."sku", '') IS NOT DISTINCT FROM NULLIF(d.sku, '')
          AND NULLIF(v."barcode", '') IS NOT DISTINCT FROM NULLIF(d.barcode, '')
          AND v."inventoryQty" IS NOT DISTINCT FROM d.qty::int
          AND v."status"::text = ${delivery.status}
          AND NULLIF(v."vendor", '') IS NOT DISTINCT FROM NULLIF(${delivery.vendor}::text, '')
          AND NULLIF(v."productType", '') IS NOT DISTINCT FROM NULLIF(${delivery.productType}::text, '')
          AND v."tags" @> ${[...delivery.tags]}::text[] AND v."tags" <@ ${[...delivery.tags]}::text[],
          false) AS unchanged,
        COALESCE(
          v."price" IS NOT DISTINCT FROM d.price::bigint
          AND v."compareAt" IS NOT DISTINCT FROM d.compare::bigint,
          false) AS "samePrice"
      FROM d
      LEFT JOIN "variant_index" v ON v."shopId" = ${shopId} AND v."variantGid" = d.gid
    )
    SELECT COALESCE(bool_or(ours) AND bool_and(unchanged AND (ours OR "samePrice")), false)
      AND (
        ${still}::text[] IS NULL
        OR (
          NOT EXISTS (
            SELECT 1 FROM "variant_index" x
            WHERE x."shopId" = ${shopId} AND x."productGid" = ${delivery.productGid}
              AND x."deletedAt" IS NULL AND NOT (x."variantGid" = ANY(${still}::text[]))
          )
          AND (
            SELECT count(*) FROM "variant_index" x
            WHERE x."shopId" = ${shopId} AND x."productGid" = ${delivery.productGid}
              AND x."deletedAt" IS NULL AND x."variantGid" = ANY(${still}::text[])
          ) = cardinality(${still}::text[])
        )
      ) AS echo
    FROM judged`;
  return rows[0]?.echo === true;
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

  const activeCampaign = await controllingCampaign(shopId, variantGid);
  if (!activeCampaign) return false;

  // Already held: the merchant has been told, and holding it again would change nothing.
  const alreadyHeld = activeCampaign.status === "HELD";

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

/**
 * The campaign that controls *this variant*: the one whose price the storefront showed
 * before the edit, and still running.
 *
 * This used to take any ACTIVE campaign on the shop, highest priority first, with no
 * reference to the variant at all — while the doc above claimed the opposite. So a
 * merchant editing one product by hand stopped whichever unrelated campaign happened to
 * be running, and the drift event named a variant that campaign had never priced. On a
 * store running several campaigns at once, which is what this product is for, the
 * highest-priority one absorbed every hand edit in the catalogue.
 *
 * The ledger answers it: a landed base-surface row is us having written this variant.
 * Newest first, because a variant repriced by a later campaign is controlled by that one.
 *
 * Unless that newest write was a revert's (#998). A revert writes `resolve(without C)`,
 * which is often another campaign's price: B ends over A, and A's sale goes live on what B
 * was pricing. The row is B's, so the campaign that wrote the price is not the one pricing
 * it, and A -- which never wrote it -- found no row: a hand edit there raised nothing, held
 * nothing, and A's revert later wrote over it without asking. Who the revert handed it to
 * is the planner's answer, from what the revert wrote. A price that is nobody's -- the
 * baseline, a variant a campaign let go -- is nobody's drift.
 *
 * Any campaign keeping its prices live, not only an ACTIVE one (#878). A held campaign
 * still controls its variants, and taking ACTIVE alone meant every edit after the first
 * was dropped: a second edit left its event showing a price the storefront no longer
 * had, and an edit to another of its variants recorded nothing, so the queue never asked
 * about it and the next Apply wrote over it unrecorded. Partial is included for the same
 * reason, and is what `holdForDrift` already holds. A campaign being ended is not: it is
 * handing its variants back, not keeping them.
 */
async function controllingCampaign(
  shopId: string,
  variantGid: string,
): Promise<{ id: string; name: string; status: string } | null> {
  const newest = await prisma.variantChange.findFirst({
    where: { shopId, variantGid, surfaceKind: "BASE", priceListGid: "", status: { in: [...LANDED] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { intendedPrice: true, run: { select: { kind: true } } },
  });
  if (!newest) return null;
  if (newest.run.kind === "REVERT") {
    const inheritor = newest.intendedPrice === null ? null : await inheritorOf(shopId, variantGid, newest.intendedPrice);
    // Keeping its prices live, as below: not one still applying.
    return inheritor && (DRIFT_CONTROLLING as readonly string[]).includes(inheritor.status) ? inheritor : null;
  }

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
  if (!controlling) return null;
  if ((await endingAmong([controlling.run.campaignId])).size > 0) return null;
  return { id: controlling.run.campaignId, ...controlling.run.campaign };
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
