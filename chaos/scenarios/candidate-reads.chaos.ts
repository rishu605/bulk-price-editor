/**
 * Planning reads a scope's baselines and live prices in a fixed number of statements, and
 * they are the rows the chunked reads returned (#524).
 *
 * `loadCandidates` read `baselines` and `price_surface_entries` 5,000 variant ids at a time,
 * and Postgres answered every batch with a pass over the shop's rows: 42 full scans to plan
 * a 102,132-variant catalogue. It now sends the scope's ids as one array. This is core
 * pricing code, where a candidate set one row out is a wrong price on a storefront, so the
 * new reads are held to the old ones rather than to expectations written beside them. The
 * old loader is kept here as the reference, and both run over random catalogues and random
 * scopes:
 *
 *   - every condition field, in AND groups ORed together, with product statuses, blank
 *     values, and pinned lists naming deleted, foreign and unknown variants;
 *   - tombstoned variants and gift cards, variants with no baseline or no live price, a
 *     baseline in another currency, superseded history, market and wholesale baselines and
 *     prices, and baselines for variants the mirror does not have;
 *   - a second shop holding the same variant ids at other prices, so a read that lost the
 *     shop would be caught;
 *   - imported prices, and a run's own list of variants;
 *   - and a catalogue past two chunk seams, which is where a chunked read drops or repeats.
 *
 * Postgres is the only thing that can answer this: a mock agrees with whatever query it is
 * handed.
 */

import { PrismaClient, type Prisma } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ProductStatus } from "../../app/lib/campaigns/product-status";
import { IN_CHUNK, inChunks } from "../../app/lib/db/chunk";
import { money, type Money } from "../../app/lib/money/money";
import { inVariantOrder } from "../../app/lib/planning/candidate-order";
import type { PlanCandidate } from "../../app/lib/planning/types";
import type { Baseline } from "../../app/lib/pricing/types";
import type { Condition, ConditionField, FilterAst } from "../../app/services/segments.server";

type Modules = {
  prisma: PrismaClient;
  loadCandidates: typeof import("../../app/services/campaigns/candidates.server").loadCandidates;
  astToWhere: typeof import("../../app/services/segments.server").astToWhere;
  seededRandom: typeof import("../harness/seed").seededRandom;
  destroyFixture: typeof import("../harness/seed").destroyFixture;
  seed: number;
};

let m: Modules;

/** Every statement the app's client sends while `capturing` is set. */
const captured: string[] = [];
let capturing = false;

beforeAll(async () => {
  // The app's client is swapped for one that reports its statements *before* anything that
  // imports `db.server` loads, as `measure-queries` does: `db.server` binds its export when
  // it is first evaluated, so a swap afterwards would observe nothing. Hence the modules
  // that reach it are imported here rather than above.
  const observed = new PrismaClient({ log: [{ emit: "event", level: "query" }] });
  observed.$on("query", (event) => {
    if (capturing) captured.push(event.query);
  });
  globalThis.prismaGlobal = observed;

  const { default: prisma } = await import("../../app/db.server");
  expect(prisma, "db.server did not take the observing client").toBe(observed);
  const harness = await import("../harness/seed");

  m = {
    prisma,
    loadCandidates: (await import("../../app/services/campaigns/candidates.server")).loadCandidates,
    astToWhere: (await import("../../app/services/segments.server")).astToWhere,
    seededRandom: harness.seededRandom,
    destroyFixture: harness.destroyFixture,
    seed: (await import("../harness/scenario")).RUN_SEED,
  };
});

afterAll(async () => {
  await m?.prisma.$disconnect();
  // So nothing that runs after this file in the same process inherits the observing client.
  delete (globalThis as { prismaGlobal?: unknown }).prismaGlobal;
});

// ------------------------------------------------------------------ the reference

/**
 * `loadCandidates` as it was before #524, comments aside, with the two helpers it called.
 * Copied rather than imported, so the reference cannot move with the code it checks.
 */
async function chunkedLoadCandidates(
  shopId: string,
  ast: FilterAst,
  onlyVariantGids?: string[],
  importIds: readonly string[] = [],
): Promise<PlanCandidate[]> {
  const { prisma, astToWhere } = m;
  if (onlyVariantGids?.length === 0) return [];

  const scope = astToWhere(shopId, ast);
  const select = { variantGid: true, currency: true, cost: true, title: true } as const;
  const variants = inVariantOrder(
    onlyVariantGids
      ? await inChunks(onlyVariantGids, (batch) =>
          prisma.variantIndex.findMany({ where: { ...scope, variantGid: { in: batch } }, select }),
        )
      : await prisma.variantIndex.findMany({ where: scope, select }),
  );
  if (variants.length === 0) return [];

  const gids = variants.map((v) => v.variantGid);

  const imported = await importedPricesByVariant(importIds, gids);

  const [baselines, entries] = await Promise.all([
    inChunks(gids, (batch) =>
      prisma.baseline.findMany({
        where: { shopId, supersededAt: null, surfaceKind: "BASE", variantGid: { in: batch } },
      }),
    ),
    inChunks(gids, (batch) =>
      prisma.priceSurfaceEntry.findMany({
        where: { shopId, surfaceKind: "BASE", variantGid: { in: batch } },
      }),
    ),
  ]);

  const baselineBy = new Map(baselines.map((b) => [b.variantGid, b]));
  const entryBy = new Map(entries.map((e) => [e.variantGid, e]));

  const candidates: PlanCandidate[] = [];

  for (const variant of variants) {
    const baseline = baselineBy.get(variant.variantGid);
    if (!baseline) continue;

    const currency = variant.currency || baseline.currency || "USD";
    const baselineCurrency = baseline.currency || currency;
    const entry = entryBy.get(variant.variantGid);

    const asMoney = (value: bigint | null | undefined): Money | undefined =>
      value === null || value === undefined ? undefined : money(Number(value), currency);
    const inBaselineCurrency = (value: bigint | null | undefined): Money | undefined =>
      value === null || value === undefined ? undefined : money(Number(value), baselineCurrency);

    const base: Baseline = {
      price: money(Number(baseline.basePrice), baselineCurrency),
      compareAtPrice: inBaselineCurrency(baseline.baseCompareAt),
      cost: asMoney(baseline.cost ?? variant.cost),
    };

    candidates.push({
      ref: { variantGid: variant.variantGid, surfaceKind: "base", priceListGid: "", currency },
      baseline: base,
      livePrice: asMoney(entry?.livePrice),
      liveCompareAt: asMoney(entry?.liveCompareAt),
      ...(imported.size > 0 ? pricesFor(imported, variant.variantGid, currency) : {}),
    });
  }

  return candidates;
}

interface ImportedRow {
  price: bigint;
  compareAt: bigint | null;
}

async function importedPricesByVariant(
  importIds: readonly string[],
  variantGids: readonly string[],
): Promise<Map<string, Map<string, ImportedRow>>> {
  if (importIds.length === 0 || variantGids.length === 0) return new Map();

  const rows = await inChunks([...variantGids], (batch) =>
    m.prisma.priceImportRow.findMany({
      where: { importId: { in: [...importIds] }, variantGid: { in: batch } },
      select: { importId: true, variantGid: true, price: true, compareAt: true },
    }),
  );

  const byVariant = new Map<string, Map<string, ImportedRow>>();
  for (const row of rows) {
    const forVariant = byVariant.get(row.variantGid) ?? new Map<string, ImportedRow>();
    forVariant.set(row.importId, { price: row.price, compareAt: row.compareAt });
    byVariant.set(row.variantGid, forVariant);
  }

  return byVariant;
}

function pricesFor(
  imported: Map<string, Map<string, ImportedRow>>,
  variantGid: string,
  currency: string,
): Pick<PlanCandidate, "importedPrices" | "importedCompareAts"> {
  const forVariant = [...(imported.get(variantGid) ?? [])];

  return {
    importedPrices: Object.fromEntries(
      forVariant.map(([importId, row]) => [importId, money(Number(row.price), currency)]),
    ),
    importedCompareAts: Object.fromEntries(
      forVariant
        .filter(([, row]) => row.compareAt !== null)
        .map(([importId, row]) => [importId, money(Number(row.compareAt), currency)]),
    ),
  };
}

// ------------------------------------------------------------------ random catalogues

const VENDORS = ["Northwind", "Basalt Goods", "Cedar & Co", "Ember Works"];
const TYPES = ["Snowboard", "Jacket", "Boots", "Wax"];
const TAGS = ["core", "sale", "new", "clearance", "gift", "final-sale"];
const COLLECTIONS = ["all-products", "winter-2026", "outerwear", "pro-only"];
const WORDS = ["Alpine", "Arctic", "Summit", "Tundra", "Glacier"];
const STATUSES: ProductStatus[] = ["ACTIVE", "DRAFT", "ARCHIVED"];
const LISTS = ["gid://shopify/PriceList/71", "gid://shopify/PriceList/72"];

type Random = () => number;

const pick = <T,>(random: Random, from: readonly T[]): T => from[Math.floor(random() * from.length)]!;
const chance = (random: Random, p: number) => random() < p;
const some = <T,>(random: Random, from: readonly T[], p: number): T[] => from.filter(() => chance(random, p));
const amount = (random: Random) => BigInt(1 + Math.floor(random() * 50_000));
const maybe = <T,>(random: Random, p: number, value: () => T): T | null => (chance(random, p) ? value() : null);

/** What the scopes are drawn from, so a random condition usually matches something. */
interface Catalogue {
  shopId: string;
  /** Every variant row the target shop has, deleted ones included. */
  gids: string[];
  deleted: string[];
  /** Variant ids only the other shop has. */
  foreign: string[];
  titles: string[];
  skus: string[];
  barcodes: string[];
  importIds: string[];
}

/**
 * Two shops: the one planned, and one holding many of the same variant ids at other prices.
 * `size` variants in the first.
 */
async function seedCatalogue(random: Random, round: number, size: number): Promise<Catalogue> {
  const { prisma } = m;
  const domains = [`chaos-candidate-reads-${round}.myshopify.com`, `chaos-candidate-reads-${round}-other.myshopify.com`];
  for (const domain of domains) await m.destroyFixture(domain);
  const [shop, other] = await Promise.all(
    domains.map((domain) =>
      prisma.shop.create({
        data: { domain, planTier: "WHOLESALE", subscriptionStatus: "ACTIVE", scopes: "write_products", timezone: "UTC" },
      }),
    ),
  );

  const gid = (i: number) => `gid://shopify/ProductVariant/${round}0${i}`;
  const gids = Array.from({ length: size }, (_, i) => gid(i));
  const foreign = Array.from({ length: 5 }, (_, i) => gid(size + i));

  const variants: Prisma.VariantIndexCreateManyInput[] = [];
  const baselines: Prisma.BaselineCreateManyInput[] = [];
  const entries: Prisma.PriceSurfaceEntryCreateManyInput[] = [];

  for (const [i, variantGid] of gids.entries()) {
    const currency = pick(random, ["USD", "USD", "USD", "EUR", "JPY"]);
    // Titles repeat across variants, so the order's tie-break on the id is exercised too.
    const title = chance(random, 0.05) ? null : `${pick(random, WORDS)} ${pick(random, TYPES)} ${i % 37} · ${pick(random, ["S", "M", "L"])}`;
    const casing = (text: string) => (chance(random, 0.2) ? text.toUpperCase() : chance(random, 0.2) ? text.toLowerCase() : text);
    variants.push({
      shopId: shop.id,
      variantGid,
      productGid: `gid://shopify/Product/${round}0${Math.floor(i / 3)}`,
      title,
      sku: maybe(random, 0.85, () => `SKU-${round}-${i}`),
      barcode: maybe(random, 0.7, () => String(40_000_000 + i * 7)),
      price: maybe(random, 0.95, () => amount(random)),
      compareAt: maybe(random, 0.4, () => amount(random)),
      cost: maybe(random, 0.6, () => amount(random)),
      // An empty currency falls back to the baseline's, then to USD.
      currency: chance(random, 0.05) ? null : chance(random, 0.03) ? "" : currency,
      inventoryQty: chance(random, 0.1) ? null : Math.floor(random() * 60) - 5,
      status: pick(random, ["ACTIVE", "ACTIVE", "ACTIVE", "DRAFT", "ARCHIVED"] as const),
      vendor: chance(random, 0.1) ? null : casing(pick(random, VENDORS)),
      productType: chance(random, 0.1) ? null : casing(pick(random, TYPES)),
      tags: some(random, TAGS, 0.35),
      collections: some(random, COLLECTIONS, 0.4),
      isGiftCard: chance(random, 0.03),
      deletedAt: chance(random, 0.08) ? new Date() : null,
    });

    // About one in ten never captured: no baseline, so no candidate.
    if (chance(random, 0.9)) {
      // Rarely, a base baseline filed under a list id with none filed under "": the reads
      // filter on the surface and not the list, and must keep doing so.
      const priceListGid = chance(random, 0.02) ? LISTS[0]! : "";
      baselines.push({
        shopId: shop.id,
        variantGid,
        surfaceKind: "BASE",
        priceListGid,
        // A baseline recorded in another currency than the variant's (#734).
        currency: chance(random, 0.1) ? pick(random, ["USD", "EUR", "JPY"]) : currency,
        basePrice: amount(random),
        baseCompareAt: maybe(random, 0.4, () => amount(random)),
        cost: maybe(random, 0.5, () => amount(random)),
        source: "INSTALL_CAPTURE",
      });
    }
    // History: superseded base rows, which must never be read.
    for (let h = Math.floor(random() * 3); h > 0; h--) {
      baselines.push({
        shopId: shop.id, variantGid, surfaceKind: "BASE", priceListGid: "", currency,
        basePrice: amount(random), source: "RECAPTURE", supersededAt: new Date(Date.now() - h * 86_400_000),
      });
    }
    // Market and wholesale baselines, current, on the same variant.
    if (chance(random, 0.25)) {
      baselines.push({ shopId: shop.id, variantGid, surfaceKind: "MARKET", priceListGid: LISTS[0]!, currency: "EUR", basePrice: amount(random), source: "INSTALL_CAPTURE" });
    }
    if (chance(random, 0.1)) {
      baselines.push({ shopId: shop.id, variantGid, surfaceKind: "B2B", priceListGid: LISTS[1]!, currency: "USD", basePrice: amount(random), source: "INSTALL_CAPTURE" });
    }

    // Base live price for most; none for some; a price with no value for a few.
    if (chance(random, 0.9)) {
      entries.push({
        shopId: shop.id, variantGid, surfaceKind: "BASE", priceListGid: "", currency: currency,
        livePrice: maybe(random, 0.95, () => amount(random)), liveCompareAt: maybe(random, 0.4, () => amount(random)),
      });
    }
    if (chance(random, 0.3)) {
      entries.push({ shopId: shop.id, variantGid, surfaceKind: "MARKET", priceListGid: LISTS[0]!, currency: "EUR", livePrice: amount(random) });
    }
  }

  // Baselines for variants the mirror does not have (#252): never a candidate.
  for (let i = 0; i < 4; i++) {
    baselines.push({ shopId: shop.id, variantGid: gid(size + 100 + i), surfaceKind: "BASE", priceListGid: "", currency: "USD", basePrice: amount(random), source: "CSV_IMPORT" });
  }

  // The other shop: most of the same ids, every row at another price, and a few of its own.
  for (const variantGid of [...gids.filter(() => chance(random, 0.6)), ...foreign]) {
    variants.push({ shopId: other.id, variantGid, productGid: "gid://shopify/Product/0", title: "Other", currency: "USD", price: amount(random), tags: TAGS.slice(), collections: COLLECTIONS.slice(), vendor: VENDORS[0], productType: TYPES[0] });
    baselines.push({ shopId: other.id, variantGid, surfaceKind: "BASE", priceListGid: "", currency: "USD", basePrice: amount(random), source: "INSTALL_CAPTURE" });
    entries.push({ shopId: other.id, variantGid, surfaceKind: "BASE", priceListGid: "", currency: "USD", livePrice: amount(random) });
  }

  for (let i = 0; i < variants.length; i += 5_000) await prisma.variantIndex.createMany({ data: variants.slice(i, i + 5_000) });
  for (let i = 0; i < baselines.length; i += 5_000) await prisma.baseline.createMany({ data: baselines.slice(i, i + 5_000) });
  for (let i = 0; i < entries.length; i += 5_000) await prisma.priceSurfaceEntry.createMany({ data: entries.slice(i, i + 5_000) });

  // Two imports naming some of the variants, one of them with compare-ats.
  const importIds: string[] = [];
  for (const withCompareAt of [true, false]) {
    const priceImport = await prisma.priceImport.create({ data: { shopId: shop.id, name: `chaos ${withCompareAt}`, currency: "USD" } });
    importIds.push(priceImport.id);
    const named = gids.filter(() => chance(random, 0.3));
    for (let i = 0; i < named.length; i += 5_000) {
      await prisma.priceImportRow.createMany({
        data: named.slice(i, i + 5_000).map((variantGid) => ({
          importId: priceImport.id, variantGid, price: amount(random), compareAt: withCompareAt ? maybe(random, 0.5, () => amount(random)) : null,
        })),
      });
    }
  }

  const live = variants.filter((v) => v.shopId === shop.id);
  return {
    shopId: shop.id,
    gids,
    deleted: live.filter((v) => v.deletedAt).map((v) => v.variantGid),
    foreign,
    titles: live.flatMap((v) => (v.title ? [v.title] : [])),
    skus: live.flatMap((v) => (v.sku ? [v.sku] : [])),
    barcodes: live.flatMap((v) => (v.barcode ? [v.barcode] : [])),
    importIds,
  };
}

/** Some of the catalogue's ids, with deleted, foreign and unknown ones mixed in. */
function someGids(random: Random, catalogue: Catalogue): string[] {
  return [
    ...some(random, catalogue.gids, 0.3),
    ...some(random, catalogue.deleted, 0.5),
    ...some(random, catalogue.foreign, 0.5),
    ...(chance(random, 0.5) ? ["gid://shopify/ProductVariant/does-not-exist"] : []),
  ];
}

/** A piece of `text`, in a case the merchant might have typed it in. */
function fragment(random: Random, text: string): string {
  const start = Math.floor(random() * Math.max(1, text.length - 3));
  const piece = text.slice(start, start + 2 + Math.floor(random() * 6));
  return chance(random, 0.3) ? piece.toLowerCase() : chance(random, 0.2) ? ` ${piece.toUpperCase()} ` : piece;
}

/**
 * A value for every condition field. A `Record`, so a field added to `ConditionField` fails
 * typecheck here until it is fuzzed too.
 */
const VALUES: Record<ConditionField, (random: Random, catalogue: Catalogue) => Condition["value"]> = {
  collection: (r) => (chance(r, 0.05) ? "" : chance(r, 0.1) ? ` ${pick(r, COLLECTIONS)} ` : pick(r, COLLECTIONS)),
  tag: (r) => (chance(r, 0.05) ? "  " : pick(r, TAGS)),
  excludeTag: (r) => pick(r, TAGS),
  vendor: (r) => (chance(r, 0.3) ? pick(r, VENDORS).toLowerCase() : pick(r, VENDORS)),
  productType: (r) => (chance(r, 0.3) ? pick(r, TYPES).toUpperCase() : pick(r, TYPES)),
  status: (r) => pick(r, ["active", "DRAFT", "Archived", ""]),
  title: (r, c) => fragment(r, pick(r, c.titles.length ? c.titles : ["Alpine"])),
  sku: (r, c) => fragment(r, pick(r, c.skus.length ? c.skus : ["SKU"])),
  barcode: (r, c) => fragment(r, pick(r, c.barcodes.length ? c.barcodes : ["4000"])),
  // Fractional on purpose: the compiler rounds a price to whole minor units.
  priceMin: (r) => Math.floor(r() * 30_000) + (chance(r, 0.3) ? 0.5 : 0),
  priceMax: (r) => Math.floor(r() * 50_000) + (chance(r, 0.3) ? 0.4 : 0),
  inventoryMin: (r) => Math.floor(r() * 40) - 5,
  inventoryMax: (r) => Math.floor(r() * 60) - 5,
  hasCompareAt: (r) => chance(r, 0.5),
  hasCost: (r) => chance(r, 0.5),
  // A pinned list, an empty one (which matches nothing), or a single id as a string.
  variantGid: (r, c) => (chance(r, 0.1) ? [] : chance(r, 0.1) ? pick(r, c.gids) : someGids(r, c)),
};

const FIELDS = Object.keys(VALUES) as ConditionField[];

/** Random catalogues, each planned twelve ways. */
const ROUNDS = 40;

function randomAst(random: Random, catalogue: Catalogue): FilterAst {
  const groups = Array.from({ length: Math.floor(random() * 4) }, () => ({
    conditions: Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
      const field = pick(random, FIELDS);
      return { field, value: VALUES[field](random, catalogue) };
    }),
  }));
  const roll = random();
  return {
    groups,
    // Absent (any status), a choice of them, or none at all -- which matches nothing.
    ...(roll < 0.4 ? {} : roll < 0.95 ? { productStatuses: some(random, STATUSES, 0.6) } : { productStatuses: [] }),
  };
}

/** Both loaders on one scope; the old one's answer is the expected one. */
async function compare(
  label: string,
  catalogue: Catalogue,
  ast: FilterAst,
  only?: string[],
  importIds: readonly string[] = [],
): Promise<PlanCandidate[]> {
  const [expected, actual] = [
    await chunkedLoadCandidates(catalogue.shopId, ast, only, importIds),
    await m.loadCandidates(catalogue.shopId, ast, only, importIds),
  ];
  expect(actual, `${label}: ${JSON.stringify({ ast, only: only?.length, importIds })}`).toStrictEqual(expected);
  return actual;
}

describe("chaos: a plan's baselines and live prices, read by the scope's ids", () => {
  it("gives the candidates the chunked reads gave, over random catalogues and scopes", async () => {
    const seen = { comparisons: 0, nonEmpty: 0, candidates: 0, noLivePrice: 0, otherCurrency: 0, imported: 0, fields: new Set<string>() };

    for (let round = 0; round < ROUNDS; round++) {
      const seed = m.seed + round;
      const random = m.seededRandom(seed);
      const catalogue = await seedCatalogue(random, round, 30 + Math.floor(random() * 300));
      const label = `CHAOS_SEED=${m.seed} round ${round}`;

      for (let n = 0; n < 12; n++) {
        const ast = randomAst(random, catalogue);
        for (const group of ast.groups) for (const condition of group.conditions) seen.fields.add(condition.field);
        const roll = random();
        // Mostly the scope alone; sometimes a run's own variants, sometimes imports.
        const only = roll < 0.2 ? someGids(random, catalogue) : roll < 0.23 ? [] : undefined;
        const importIds = chance(random, 0.35) ? [...some(random, catalogue.importIds, 0.7), "no-such-import"] : [];

        const candidates = await compare(label, catalogue, ast, only, importIds);
        seen.comparisons++;
        if (candidates.length > 0) seen.nonEmpty++;
        seen.candidates += candidates.length;
        seen.noLivePrice += candidates.filter((c) => !c.livePrice).length;
        seen.otherCurrency += candidates.filter((c) => c.baseline.price.currency !== c.ref.currency).length;
        seen.imported += candidates.filter((c) => Object.keys(c.importedPrices ?? {}).length > 0).length;
      }

      // The whole catalogue, and a run over every variant it has.
      await compare(label, catalogue, { groups: [] });
      await compare(label, catalogue, { groups: [] }, [...catalogue.gids, ...catalogue.foreign], catalogue.importIds);

      await m.destroyFixture(`chaos-candidate-reads-${round}.myshopify.com`);
      await m.destroyFixture(`chaos-candidate-reads-${round}-other.myshopify.com`);
    }

    // Not a pass over nothing: the random scopes reached every field and matched rows of
    // every kind worth comparing.
    expect([...seen.fields].sort()).toEqual([...FIELDS].sort());
    expect(seen.comparisons).toBe(ROUNDS * 12);
    expect(seen.nonEmpty).toBeGreaterThan(seen.comparisons / 3);
    expect(seen.candidates).toBeGreaterThan(2_000);
    expect(seen.noLivePrice).toBeGreaterThan(0);
    expect(seen.otherCurrency).toBeGreaterThan(0);
    expect(seen.imported).toBeGreaterThan(0);
  });

  it("gives the same candidates past the chunk seams, and reads each table once however wide the scope", async () => {
    const random = m.seededRandom(m.seed + 1_000);
    // Past two seams of 5,000 once the deleted, the gift cards and the never captured are
    // out, so the reference splits every read three ways.
    const catalogue = await seedCatalogue(random, 1_000, 14_000);
    const label = `CHAOS_SEED=${m.seed} wide`;

    const wide = await compare(label, catalogue, { groups: [] });
    expect(wide.length, "the plan must reach past both seams, or this proves nothing").toBeGreaterThan(2 * IN_CHUNK);
    await compare(label, catalogue, { groups: [] }, catalogue.gids, catalogue.importIds);
    for (let n = 0; n < 6; n++) await compare(label, catalogue, randomAst(random, catalogue));

    // The statements one plan sends, less the transaction's own BEGIN and COMMIT: the scope,
    // the setting, and one read of each table, for the whole catalogue as for twenty
    // variants, because they no longer grow with the scope.
    const statements = async (ast: FilterAst) => {
      captured.length = 0;
      capturing = true;
      await m.loadCandidates(catalogue.shopId, ast);
      capturing = false;
      return captured.filter((sql) => !/^\s*(BEGIN|COMMIT|DEALLOCATE)\b/i.test(sql));
    };
    const reads = (all: string[], table: string) => all.filter((sql) => new RegExp(`FROM "(public"\\.")?${table}"`).test(sql));

    // Seven plans in a row. Past the fifth, Postgres may stop planning a prepared statement
    // with its values; each plan still asks for that, for its own transaction.
    for (let n = 0; n < 7; n++) {
      const all = await statements({ groups: [] });
      expect(all, all.join("\n")).toHaveLength(4);
      expect(reads(all, "variant_index")).toHaveLength(1);
      expect(reads(all, "baselines")).toHaveLength(1);
      expect(reads(all, "price_surface_entries")).toHaveLength(1);
      expect(all.filter((sql) => /^SET LOCAL plan_cache_mode = force_custom_plan$/.test(sql.trim()))).toHaveLength(1);
    }
    const narrow = await statements({ groups: [{ conditions: [{ field: "variantGid", value: catalogue.gids.slice(0, 20) }] }] });
    expect(narrow, narrow.join("\n")).toHaveLength(4);

    await m.destroyFixture("chaos-candidate-reads-1000.myshopify.com");
    await m.destroyFixture("chaos-candidate-reads-1000-other.myshopify.com");
  });
});
