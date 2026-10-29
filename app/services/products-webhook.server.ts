/**
 * One product create / update / delete, keeping the catalog mirror current between syncs.
 *
 * Called by the worker for a delivery the web process persisted and handed over (#811), and
 * by the route itself when there is no worker queue to hand it to. One function for both, so
 * what the chaos suite proves through the route is what the worker does.
 *
 * Three rules govern everything here:
 *
 *   Our own echoes are dropped first. Every price a run writes comes back as a
 *   `products/update`, and a 100k run's thousands of them each did a mirror upsert, a drift
 *   lookup and an enrolment pass per variant (#803). A delivery that is nothing but our own
 *   write is recognised in one query (`deliveryIsOurEcho`) and goes no further (#811).
 *
 *   Deletes tombstone, never hard-delete. Ledger rows may still reference a variant
 *   that has since been deleted, and those rows must stay resolvable when a campaign
 *   reverts (edge case E4). Hard deletion turns a graceful skip into a foreign-key
 *   error mid-run.
 *
 *   Out-of-order deliveries are ignored, not applied. Shopify does not guarantee
 *   ordering, so an older payload arriving after a newer one would otherwise
 *   overwrite current data with stale data. `remoteUpdatedAt` decides, by the rule in
 *   `mirror-version.server.ts`, which the catalogue syncs write by too (#1087).
 *
 * One thing this path CANNOT supply: cost per item. Shopify's product webhook
 * payload has no cost field -- cost lives on the inventory item, behind a separate
 * lookup. So a variant that first appears via webhook has no cost until the next
 * catalogue sync, and cost-based guardrails will skip it in the meantime. `cost` is
 * deliberately absent from the update below rather than set to null, so a sync that
 * already found a cost is not undone by a later webhook. The settings page reports
 * cost coverage so the gap is visible rather than silent.
 */

import { variantDisplayTitle } from "../lib/catalog/variant-title";
import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { isKnownCurrency } from "../lib/money/currency";
import type { AdminClient } from "../lib/execution/sync-executor";
import { fetchShopCurrency } from "./catalog-sync.server";
import { parseMoney } from "../lib/money/money";
import { checkForDrift, deliveryIsOurEcho, ourEchoes } from "./drift.server";
import { newerInMirror } from "./mirror-version.server";
import { enrollNewVariants } from "./auto-enroll.server";
import { giftCardFlagFor } from "./gift-card.server";
import { variantsStillOnProduct } from "../lib/catalog/webhook-variants";

interface WebhookVariant {
  id: number | string;
  admin_graphql_api_id?: string;
  title?: string | null;
  sku?: string | null;
  barcode?: string | null;
  price?: string | null;
  compare_at_price?: string | null;
  inventory_quantity?: number | null;
}

export interface WebhookProduct {
  id: number | string;
  admin_graphql_api_id?: string;
  title?: string;
  vendor?: string | null;
  product_type?: string | null;
  status?: string | null;
  tags?: string | string[] | null;
  updated_at?: string | null;
  /** Full details for the first 100 variants only. See `variantsStillOnProduct`. */
  variants?: WebhookVariant[];
  /** Every variant's id, including the ones `variants` leaves out (#729). */
  variant_gids?: Array<{ admin_graphql_api_id?: string } | string> | null;
}

/** The product a delivery is about, from either payload shape (a delete carries only `id`). */
export function productGidOf(payload: unknown): string | null {
  const product = (payload ?? {}) as Partial<WebhookProduct>;
  if (typeof product.admin_graphql_api_id === "string" && product.admin_graphql_api_id) return product.admin_graphql_api_id;
  return product.id === undefined || product.id === null || product.id === "" ? null : `gid://shopify/Product/${product.id}`;
}

/**
 * The topic as one spelling. Shopify's header says `products/update`, which is what the
 * delivery log records; the library's context says `PRODUCTS_UPDATE`.
 */
export function productsTopic(topic: string): "PRODUCTS_CREATE" | "PRODUCTS_UPDATE" | "PRODUCTS_DELETE" | null {
  const spelled = topic.toUpperCase().replace("/", "_");
  return spelled === "PRODUCTS_CREATE" || spelled === "PRODUCTS_UPDATE" || spelled === "PRODUCTS_DELETE" ? spelled : null;
}

/**
 * What one shop's deliveries are handled with: the shop, and what the mirror cannot answer
 * for itself, each asked at most once however many deliveries share it (#811). A worker
 * draining a shop's backlog would otherwise look up the store's currency once per delivery.
 */
export interface ShopContext {
  shop: { id: string; domain: string };
  /** The store's currency, or null when neither the mirror nor Shopify says (#1101). */
  currency(): Promise<string | null>;
  /** The shop's Admin API, for a product never seen before or a store with nothing mirrored. */
  admin(): Promise<AdminClient | null>;
}

export function shopContext(
  shop: { id: string; domain: string },
  admin: () => Promise<AdminClient | null>,
): ShopContext {
  let client: Promise<AdminClient | null> | undefined;
  let currency: Promise<string | null> | undefined;
  const adminOnce = () => (client ??= admin().catch(() => null));
  return {
    shop,
    admin: adminOnce,
    currency: () => (currency ??= currencyFor(shop.id, adminOnce)),
  };
}

/** What became of a delivery, for the worker's tally. Counts only: telemetry never carries prices. */
export type ProductsOutcome = "applied" | "deleted" | "echo" | "no-currency" | "ignored";

export async function processProductsWebhook(
  context: ShopContext,
  topic: string,
  payload: unknown,
): Promise<ProductsOutcome> {
  const { shop } = context;
  const kind = productsTopic(topic);
  const productGid = productGidOf(payload);
  if (!kind || !productGid) return "ignored";
  const product = payload as WebhookProduct;

  if (kind === "PRODUCTS_DELETE") {
    // Stamped with when, as well as that. The delete payload carries no `updated_at`, and
    // without a time on the tombstone the per-variant guard below let any late
    // `products/update` -- older than the deletion, delivered after it -- bring the whole
    // product back (#730).
    const now = new Date();
    await prisma.variantIndex.updateMany({
      where: { shopId: shop.id, productGid },
      data: { deletedAt: now, remoteUpdatedAt: now },
    });
    return "deleted";
  }

  const remoteUpdatedAt = product.updated_at ? new Date(product.updated_at) : null;

  const currency = await context.currency();
  // Nothing mirrored and Shopify not saying (#1101): it used to be US dollars, so a yen
  // store's ¥1,200 product was recorded as $1,200.00, and enrolment captured baselines from
  // it. Left for the first sync, which reads the store's currency before any price.
  if (!currency) {
    logger.info("products webhook before the store's currency is known: left for the sync", { shop: shop.domain, productGid });
    return "no-currency";
  }

  const tags = Array.isArray(product.tags)
    ? product.tags
    : typeof product.tags === "string"
      ? product.tags.split(",").map((t) => t.trim()).filter(Boolean)
      : [];
  const status = mapStatus(product.status);

  const described = (product.variants ?? []).map((variant) => ({
    variant,
    variantGid: variant.admin_graphql_api_id ?? `gid://shopify/ProductVariant/${variant.id}`,
    price: safeMinor(variant.price, currency),
    compareAt: safeMinor(variant.compare_at_price, currency),
    title: variantDisplayTitle(product.title, variant.title),
  }));
  const stillThere = variantsStillOnProduct(product);

  // Before anything else: is this only our own write coming back (#811)? Then the run that
  // wrote it settles the mirror from its ledger, it is no merchant's edit to detect, and it
  // is nothing for enrolment to see (#805). One query, and nothing below runs.
  if (
    await deliveryIsOurEcho(shop.id, {
      productGid,
      status,
      vendor: product.vendor ?? null,
      productType: product.product_type ?? null,
      tags,
      stillThere,
      variants: described.map(({ variant, variantGid, price, compareAt, title }) => ({
        variantGid,
        price,
        compareAt,
        title,
        sku: variant.sku ?? null,
        barcode: variant.barcode ?? null,
        inventoryQty: variant.inventory_quantity ?? null,
      })),
    })
  ) {
    return "echo";
  }

  // The newest version of this product the mirror has applied, tombstones included,
  // read before this delivery changes anything. Webhooks are not ordered: a delivery
  // older than this describes a product that has since changed, and must not decide
  // which variants are gone (#730).
  const newestApplied = (
    await prisma.variantIndex.aggregate({
      where: { shopId: shop.id, productGid },
      _max: { remoteUpdatedAt: true },
    })
  )._max.remoteUpdatedAt;
  const staleDelivery = !!(remoteUpdatedAt && newestApplied && newestApplied > remoteUpdatedAt);

  // Asked of Shopify before any variant is mirrored, so the enrolment below never sees
  // a new gift card as an ordinary product (#689). Undefined leaves the column alone.
  const isGiftCard = await giftCardFlagFor(shop.id, productGid, context.admin);

  const seenVariantGids: string[] = [];
  const seenValues: Array<{ variantGid: string; price: bigint | null; compareAt: bigint | null }> = [];

  // Stale for these variants: the mirror already holds something newer. A delivery older
  // than the product's latest version there (#828), or one from earlier in the same second
  // showing a price our write in that second replaced -- an earlier call's snapshot of a
  // product written in several, delivered late (#985). The rule both catalogue syncs write
  // by (#1087), asked for the whole delivery at once.
  const newer = await newerInMirror(
    shop.id,
    described.map(({ variantGid, price }) => ({ variantGid, stamp: remoteUpdatedAt, price })),
  );

  for (const { variant, variantGid, price, compareAt, title } of described) {
    if (newer.has(variantGid)) continue;

    const data = {
      productGid,
      sku: variant.sku ?? null,
      barcode: variant.barcode ?? null,
      title,
      price,
      compareAt,
      currency,
      inventoryQty: variant.inventory_quantity ?? null,
      status,
      vendor: product.vendor ?? null,
      productType: product.product_type ?? null,
      tags,
      remoteUpdatedAt,
      syncedAt: new Date(),
      // A variant reappearing after deletion clears its tombstone.
      deletedAt: null,
      // The payload carries no gift-card field, so this comes from `giftCardFlagFor`:
      // Shopify's own answer for a product never seen before, and absent (preserving what
      // the mirror knows) for one already recorded as ordinary. Do not "fix" a gap here by
      // inferring from `product_type` or `requires_shipping` -- both are merchant-editable
      // and neither identifies a gift card.
      ...(isGiftCard === undefined ? {} : { isGiftCard }),
    };

    // Before overwriting the mirror, ask whether this change was ours. A price that
    // moved under an active campaign and is not our echo is a merchant edit, and
    // silently adopting it would hide exactly what they need to know about.
    await checkForDrift(shop.id, variantGid, price, compareAt);

    await prisma.variantIndex.upsert({
      where: { shopId_variantGid: { shopId: shop.id, variantGid } },
      create: { shopId: shop.id, variantGid, ...data },
      update: data,
    });

    await prisma.priceSurfaceEntry.upsert({
      where: {
        shopId_variantGid_surfaceKind_priceListGid: {
          shopId: shop.id,
          variantGid,
          surfaceKind: "BASE",
          priceListGid: "",
        },
      },
      create: {
        shopId: shop.id,
        variantGid,
        surfaceKind: "BASE",
        priceListGid: "",
        currency,
        livePrice: price,
        liveCompareAt: compareAt,
      },
      update: { livePrice: price, liveCompareAt: compareAt, syncedAt: new Date() },
    });

    seenVariantGids.push(variantGid);
    seenValues.push({ variantGid, price, compareAt });
  }

  // Variants that used to be on this product and are no longer on it.
  //
  // Without this the mirror keeps a variant that no longer exists: a campaign enrolls it,
  // every write for it fails, and the run reports failures nobody can act on — which is
  // how a run full of noise trains people to stop reading them (E4).
  //
  // "No longer on it" comes from `variantsStillOnProduct`, not from `variants`: a product
  // webhook describes only the first 100 variants there, and reading it as the whole list
  // tombstoned variant 101 onward on every update to a large product (#729). When the
  // payload cannot say -- no `variant_gids`, and a `variants` list at the detail limit or
  // empty -- nothing is tombstoned. A missed removal costs a failed write that says
  // "deleted"; a wrong one leaves prices on sale that no revert will touch.
  //
  // Nor does a delivery older than what the mirror already holds: it lists the product as
  // it was, so a variant added since is "missing" from it and a variant deleted since is
  // "present" (#730).
  const stillOn = staleDelivery ? null : stillThere;
  if (stillOn) {
    const removed = await prisma.variantIndex.updateMany({
      where: {
        shopId: shop.id,
        productGid,
        deletedAt: null,
        variantGid: { notIn: [...stillOn] },
      },
      // Tombstoned, never deleted: ledger rows still reference these variants and have
      // to stay resolvable when a campaign reverts. Stamped with the version that removed
      // them, so the per-variant guard keeps an older delivery from reviving them.
      data: { deletedAt: new Date(), syncedAt: new Date(), ...(remoteUpdatedAt ? { remoteUpdatedAt } : {}) },
    });

    if (removed.count > 0) {
      logger.info("tombstoned variants no longer on the product", {
        shop: shop.domain,
        productGid,
        tombstoned: removed.count,
      });
    }
  } else if (staleDelivery) {
    logger.info("product webhook older than the mirror; tombstoning skipped", {
      shop: shop.domain,
      productGid,
    });
  } else if (seenVariantGids.length > 0) {
    logger.info("product webhook does not list every variant; tombstoning skipped", {
      shop: shop.domain,
      productGid,
      described: seenVariantGids.length,
    });
  }

  // Only after the mirror is current: enrollment captures baselines from these very
  // rows, so a variant we have just learned about has something to anchor to.
  //
  // Failures here must not fail the delivery. It would be handled again whole, re-running
  // the mirror update for no benefit, and a missed enrolment is recovered by the next
  // product edit or catalogue sync -- whereas a retry storm is not.
  //
  // Not the echo of a price Anchor wrote: that is a variant some run already planned, and
  // a revert's own writes enrolling variants is how a sale came back on products the
  // merchant was restoring (#805). A delivery that was only that never got this far (#811);
  // this is for one that carried our price beside something the mirror had to learn.
  try {
    const echoes = await ourEchoes(shop.id, seenValues);
    await enrollNewVariants(
      shop.id,
      seenVariantGids.filter((variantGid) => !echoes.has(variantGid)),
    );
  } catch (error) {
    // Through the logger: this is the enrolment path, which captures baselines, so
    // its failures are the ones in this file most likely to name a price.
    logger.error("auto-enroll failed", { shop: shop.domain, productGid, error });
  }

  return "applied";
}

/**
 * Parses a price to minor units, returning null rather than throwing.
 *
 * A webhook is not a good place to fail loudly on one odd value: rejecting the
 * delivery makes it be handled again, whole, forever. Null means "unknown", which the
 * planner already treats as a reason to write rather than to skip.
 */
function safeMinor(value: string | null | undefined, currency: string): bigint | null {
  if (!value) return null;
  try {
    return BigInt(parseMoney(value, currency).amount);
  } catch {
    return null;
  }
}

/**
 * The store's currency: a mirrored variant's, or Shopify's own when nothing is mirrored yet --
 * before the first sync, or on a store the sync refused (#1089). Null when neither says, and
 * never a guess (#1101). A currency Anchor has no precision for is not one it can mirror.
 */
async function currencyFor(shopId: string, admin: () => Promise<AdminClient | null>): Promise<string | null> {
  const row = await prisma.variantIndex.findFirst({
    where: { shopId, currency: { not: null } },
    select: { currency: true },
  });
  if (row?.currency) return row.currency;
  const client = await admin();
  if (!client) return null;
  try {
    // The catalogue's reader takes the route-style runner; this is that, over the client.
    const currency = await fetchShopCurrency({
      async graphql(query, options) {
        const response = await client.request(query, options?.variables ?? {});
        return { json: async () => response };
      },
    });
    return currency && isKnownCurrency(currency) ? currency : null;
  } catch {
    return null;
  }
}

function mapStatus(status?: string | null): "ACTIVE" | "ARCHIVED" | "DRAFT" {
  switch ((status ?? "").toUpperCase()) {
    case "ARCHIVED":
      return "ARCHIVED";
    case "DRAFT":
      return "DRAFT";
    default:
      return "ACTIVE";
  }
}
