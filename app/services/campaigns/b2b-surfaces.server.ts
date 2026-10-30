/**
 * Writing wholesale ladders as part of a run.
 *
 * The same shape as the market surface path, with one difference that drives everything:
 * `quantityPricingByVariantUpdate` is atomic per request, so a chunk is a transaction.
 * That makes invariant I4 — ledger before write — unusually literal here. The ledger row
 * for a chunk is written, then the chunk is written, and there is no state in between
 * where half a ladder exists.
 *
 * It also means the ledger row has to carry the whole ladder. `intendedPrice` alone
 * describes the first rung and silently loses the rest, which would make the ledger a
 * record of something other than what was written.
 */

import { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { writeQuantityBreaks, type QuantityRow } from "../../lib/execution/quantity-executor";
import type { AdminClient } from "../../lib/execution/sync-executor";
import { countOf } from "../../lib/format/display";
import { money } from "../../lib/money/money";
import { parseLadder, serialiseLadder } from "../../lib/pricing/ladder-baseline";
import type { WholesaleGuardrail } from "../../lib/pricing/quantity-breaks";
import type { QuantityTier } from "../../lib/pricing/quantity-breaks";
import { logger } from "../../lib/logging/logger";
import { metric } from "../../lib/telemetry/metrics";
import {
  ladderOwner,
  planLadderRevert,
  planQuantityBreaks,
  type B2BVariantInput,
  type LadderBaselineInput,
  type TieredCampaign,
} from "./b2b-plan.server";
import { inChunks } from "../../lib/db/chunk";
import { inRunChunks, retryTransient } from "../../lib/db/run-writes.server";
import { laddersHandedTo } from "./handover.server";
import { recordedCosts } from "./market-plan.server";
import { parseSurfaces } from "./market-surfaces.server";
import { competingCampaigns, toResolvable, withScopes } from "./model.server";

export interface B2BSurfaceOutcome {
  priceListGid: string;
  name: string;
  verified: number;
  failed: number;
  /** Variants deliberately not given a ladder, already explained in `messages`. */
  refused: number;
  chunks: number;
  messages: string[];
  clean: boolean;
}

export async function applyQuantityBreaks(
  shopId: string,
  runId: string,
  list: { priceListGid: string; name: string; currency: string },
  variants: readonly B2BVariantInput[],
  tiers: QuantityTier[] | undefined,
  guardrail: WholesaleGuardrail,
  client: AdminClient,
): Promise<B2BSurfaceOutcome | null> {
  // Not a tiered campaign. Distinct from an empty ladder, which the planner reports.
  if (tiers === undefined) return null;

  const { mine, kept } = await rankedLadders(shopId, runId, list.priceListGid, variants, tiers);
  const plan = planQuantityBreaks(mine, tiers, guardrail);
  const keptMessages = [...kept.values()].map(
    ({ name, count }) =>
      `${list.name}: ${countOf(count, "product")} keep${count === 1 ? "s" : ""} "${name}"'s quantity breaks, which ranks above this campaign there.`,
  );

  const empty: B2BSurfaceOutcome = {
    priceListGid: list.priceListGid,
    name: list.name,
    verified: 0,
    failed: 0,
    refused: plan.refused.length,
    chunks: 0,
    messages: [...plan.messages, ...keptMessages],
    clean: true,
  };

  if (plan.rows.length === 0) return empty;

  const result = await writeQuantityBreaks(
    client,
    list.priceListGid,
    plan.rows,
    // Ledger before write, per chunk. The callback runs before the request that the
    // chunk describes, which is what makes I4 hold rather than nearly hold.
    async (chunk, index) => {
      await ledgerLadderChunk(runId, shopId, list, chunk, index);
    },
  );

  await recordLadderResults(runId, shopId, list.priceListGid, result.rows);

  const messages = [...plan.messages, ...keptMessages];
  if (result.failed > 0) {
    messages.unshift(
      `${list.name}: ${result.failed} product${result.failed === 1 ? "" : "s"} did not get their quantity breaks. Each batch is all-or-nothing, so nothing in a failed batch was written.`,
    );
  }

  metric("run.rows", result.verified, { runId, surface: "b2b", outcome: "verified" });
  if (result.failed > 0) {
    metric("run.rows", result.failed, { runId, surface: "b2b", outcome: "failed" });
  }

  return {
    priceListGid: list.priceListGid,
    name: list.name,
    verified: result.verified,
    failed: result.failed,
    refused: plan.refused.length,
    chunks: result.chunks,
    messages,
    clean: result.clean,
  };
}

/**
 * One ledger row per variant, carrying the whole ladder — or the absence of one.
 *
 * `intendedPrice` holds the first rung as well, so every existing query that reads a
 * price off the ledger — reconciliation, the rollback report, the result page — keeps
 * working and sees a number that is genuinely a price this row writes.
 */
async function ledgerLadderChunk(
  runId: string,
  shopId: string,
  list: { priceListGid: string; currency: string },
  chunk: readonly QuantityRow[],
  index: number,
): Promise<void> {
  // Retried on a transient error, as every ledger write in a run is (#810). A chunk here is
  // a request's worth of ladders, already bounded by the executor.
  await retryTransient("ledger.b2b.create", () => prisma.variantChange.createMany({
    data: chunk.map((row) => ({
      runId,
      shopId,
      variantGid: row.variantGid,
      surfaceKind: "B2B" as const,
      priceListGid: list.priceListGid,
      currency: list.currency,
      // A row that clears a ladder has no rungs and therefore no intended price. Null
      // rather than a stand-in: this row is not setting the variant's single price, and
      // recording one would tell reconciliation that it is.
      intendedPrice: row.breaks.length > 0 ? BigInt(row.breaks[0]!.price.amount) : null,
      intendedCompareAtSet: false,
      // Cast at the boundary. Prisma's JSON input type is structurally strict; the shape
      // is validated by `serialiseLadder`, which is the check that matters.
      quantityBreaks: serialiseLadder(row.breaks) as unknown as Prisma.InputJsonValue,
      status: "PENDING" as const,
    })),
    skipDuplicates: true,
  }));

  logger.info("b2b chunk ledgered", {
    runId,
    priceListGid: list.priceListGid,
    chunk: index,
    rows: chunk.length,
  });
}

async function recordLadderResults(
  runId: string,
  shopId: string,
  priceListGid: string,
  rows: ReadonlyArray<{ variantGid: string; status: string; failureReason?: string; guidance?: string }>,
): Promise<void> {
  const now = new Date();

  for (const status of ["verified", "failed"] as const) {
    const gids = rows.filter((row) => row.status === status).map((row) => row.variantGid);
    if (gids.length === 0) continue;

    // One `IN` list of every row on the catalogue until #810; `RUN_CHUNK` at a time now.
    await inRunChunks("ledger.b2b.result", gids, (batch) =>
      prisma.variantChange.updateMany({
        where: { runId, shopId, priceListGid, variantGid: { in: batch } },
        data: {
          status: status === "verified" ? "VERIFIED" : "FAILED",
          appliedAt: status === "verified" ? now : null,
          verifiedAt: status === "verified" ? now : null,
        },
      }),
    );
  }

  for (const row of rows) {
    if (!row.failureReason) continue;

    await retryTransient("ledger.b2b.reason", () => prisma.variantChange.updateMany({
      where: { runId, shopId, priceListGid, variantGid: row.variantGid },
      data: {
        // The merchant's version, then Shopify's. Support needs the latter.
        failureReason: row.guidance
          ? `${row.guidance} (Shopify said: ${row.failureReason})`
          : row.failureReason,
        attempt: { increment: 1 },
      },
    }));
  }
}

/**
 * Takes a campaign's ladders back off a catalogue.
 *
 * Rule 6: revert recomputes rather than restores (#704). Each ladder this campaign holds is
 * written as `resolve(without C)` has it: the ladder of the next tiered campaign that prices
 * the variant on this catalogue, from the variant's own baseline price; or, where none does,
 * the merchant's own from the baseline, or none at all. It used to write the baseline back
 * whatever else was running, so ending one of two tiered sales wiped the other's ladder
 * rather than handing the variants to it.
 *
 * And only the ladders this campaign holds: those its runs wrote, and those another
 * campaign's revert handed it. It used to take every ladder any campaign had written on the
 * catalogue, so ending one sale cleared another's.
 *
 * Clearing is a real instruction, not a no-op. The campaign's ladder is live on the
 * catalogue and a buyer is being quoted from it, so "there is nothing to write" would
 * leave the sale price in place forever.
 */
export async function revertQuantityBreaks(
  shopId: string,
  /** The revert run, which holds the claim and ledgers every write (rules 2 and 3). */
  runId: string,
  list: { priceListGid: string; name: string; currency: string },
  variantGids: readonly string[],
  /** The wholesale floor the next campaign's ladder is held to, as its apply holds it. */
  guardrail: WholesaleGuardrail,
  client: AdminClient,
): Promise<B2BSurfaceOutcome | null> {
  if (variantGids.length === 0) return null;
  const run = await prisma.campaignRun.findFirst({ where: { id: runId, shopId }, select: { campaignId: true } });
  if (!run) return null;
  const { campaignId } = run;

  // The ladders this campaign's runs gave. Chunked: `quantityBreaks: { not: … }` is a
  // negation, and Prisma will not split a query that has one -- it fails outright (#346).
  const written = await inChunks([...variantGids], (batch) =>
    prisma.variantChange.findMany({
      where: {
        shopId,
        priceListGid: list.priceListGid,
        surfaceKind: "B2B",
        variantGid: { in: batch },
        status: { in: ["VERIFIED", "CLAMPED"] },
        // This campaign's, not any campaign's: clearing a ladder it never wrote would take
        // away one another campaign, or the merchant, set.
        run: { campaignId },
        // Rows that *gave* a ladder. A clearing row from an earlier revert carries none,
        // and re-clearing would be a harmless no-op — this narrows the write rather than
        // guarding correctness, which is why removing it fails no test.
        quantityBreaks: { not: Prisma.DbNull },
      },
      select: { variantGid: true },
      distinct: ["variantGid"],
    }),
  );
  const own = new Set(written.map((row) => row.variantGid));

  // And the ladders another campaign's revert handed this one, which no run of its wrote.
  const handed = await laddersHandedTo(shopId, campaignId, list.priceListGid, variantGids.filter((gid) => !own.has(gid)), runId);

  const ours = [...own, ...handed];
  if (ours.length === 0) return null;

  const others = await tieredCampaignsOn(shopId, list.priceListGid, ours, campaignId);

  const { variants, unanchored, unread } = await ladderBaselines(shopId, list, ours);
  const plan = planLadderRevert(variants, others, guardrail);

  const result = plan.rows.length > 0
    ? await writeQuantityBreaks(client, list.priceListGid, plan.rows, async (chunk, index) => {
        await ledgerLadderChunk(runId, shopId, list, chunk, index);
      })
    : { rows: [], verified: 0, failed: 0, chunks: 0, clean: true };

  await recordLadderResults(runId, shopId, list.priceListGid, result.rows);

  const verified = new Set(result.rows.filter((row) => row.status === "verified").map((row) => row.variantGid));
  const cleared = plan.rows.filter((row) => row.breaks.length === 0 && verified.has(row.variantGid)).length;
  const handedOn = [...plan.handedTo.keys()].filter((gid) => verified.has(gid)).length;
  const messages: string[] = [];

  if (result.failed > 0) {
    messages.push(
      `${list.name}: ${result.failed} product${result.failed === 1 ? "" : "s"} still have this campaign's quantity breaks. Each batch is all-or-nothing, so nothing in a failed batch changed.`,
    );
  }
  // Rule 5: a ladder with nothing to go back to stays, and says so rather than going quiet.
  if (unanchored.length > 0) {
    messages.push(
      `${list.name}: ${countOf(unanchored.length, "product")} still ${unanchored.length === 1 ? "has" : "have"} this campaign's quantity breaks, because no baseline records the price there before it. Capture baselines on Prices → Baselines, then resume to finish the revert.`,
    );
  }
  // A baseline whose ladder was never read (#1103): what to put back is not known.
  if (unread.length > 0) {
    messages.push(
      `${list.name}: ${countOf(unread.length, "product")} still ${unread.length === 1 ? "has" : "have"} this campaign's quantity breaks, because the ones ${unread.length === 1 ? "it" : "they"} had before were never recorded. If ${unread.length === 1 ? "it" : "they"} had quantity breaks of ${unread.length === 1 ? "its" : "their"} own, set them again in Shopify; the campaign's stay until then.`,
    );
  }
  if (handedOn > 0) {
    messages.push(
      `${list.name}: ${countOf(handedOn, "product")} now ${handedOn === 1 ? "has" : "have"} the quantity breaks of the next campaign that prices ${handedOn === 1 ? "it" : "them"} there.`,
    );
  }
  if (cleared > 0) {
    messages.push(
      `${list.name}: ${cleared} product${cleared === 1 ? "" : "s"} had no quantity breaks before this campaign, so they have none now.`,
    );
  }
  messages.push(...plan.messages.map((message) => `${list.name}: ${message}`));

  metric("run.rows", result.verified, { runId, surface: "b2b", outcome: "reverted" });

  return {
    priceListGid: list.priceListGid,
    name: list.name,
    verified: result.verified,
    failed: result.failed + unanchored.length + unread.length,
    refused: 0,
    chunks: result.chunks,
    messages,
    clean: result.clean && unanchored.length === 0 && unread.length === 0,
  };
}

/**
 * The campaigns still pricing ladders on this catalogue: running, not being ended (#805),
 * with quantity tiers and this price list among their surfaces, each scoped over these
 * variants as the resolver scopes it (#752). Every one but `besides`, the one ending.
 */
/**
 * Which of these variants this campaign's ladder is for: rule 4, one resolution whichever
 * mode (#1104).
 *
 * Every running tiered campaign on the catalogue competes, as `revertQuantityBreaks` has
 * them compete (#704), and a variant goes to the one `ladderOwner` ranks first. Apply used to
 * plan this campaign's tiers alone, so applying the lower of two tiered sales wrote its
 * ladder over the higher one's, and a buyer was quoted the lower sale while the higher ran.
 *
 * A variant another campaign wins keeps that campaign's ladder, and nothing is written to
 * it: that ladder is what `resolve(with C)` leaves there, and it is live. Counted per
 * campaign, for the message. A variant nobody wins -- this campaign let it go -- is planned
 * as before: which variants a run hands the writer is the run's to decide.
 */
async function rankedLadders(
  shopId: string,
  runId: string,
  priceListGid: string,
  variants: readonly B2BVariantInput[],
  tiers: QuantityTier[],
): Promise<{ mine: B2BVariantInput[]; kept: Map<string, { name: string; count: number }> }> {
  const kept = new Map<string, { name: string; count: number }>();
  const run = await prisma.campaignRun.findFirst({ where: { id: runId, shopId }, select: { campaign: true } });
  if (!run || variants.length === 0) return { mine: [...variants], kept };

  const others = await tieredCampaignsOn(shopId, priceListGid, variants.map((variant) => variant.variantGid), run.campaign.id);
  if (others.length === 0) return { mine: [...variants], kept };

  // No scope: the variants a run hands in are this campaign's own.
  const self: TieredCampaign = { ...toResolvable(run.campaign), name: run.campaign.name, tiers };
  const mine = variants.filter((variant) => {
    const owner = ladderOwner(variant.variantGid, [self, ...others]);
    if (!owner || owner.id === self.id) return true;
    const entry = kept.get(owner.id) ?? { name: owner.name, count: 0 };
    entry.count += 1;
    kept.set(owner.id, entry);
    return false;
  });
  return { mine, kept };
}

async function tieredCampaignsOn(
  shopId: string,
  priceListGid: string,
  variantGids: readonly string[],
  besides: string,
): Promise<TieredCampaign[]> {
  const pricing = await competingCampaigns(shopId, besides);
  const tiered = pricing.flatMap((campaign) => {
    const surfaces = parseSurfaces(campaign.surfaces);
    return surfaces.quantityTiers !== undefined && surfaces.priceLists.includes(priceListGid)
      ? [{ campaign, tiers: surfaces.quantityTiers }]
      : [];
  });
  if (tiered.length === 0) return [];

  const scoped = await withScopes(shopId, tiered.map((entry) => entry.campaign), variantGids);
  return scoped.map((resolvable, index) => ({ ...resolvable, name: tiered[index]!.campaign.name, tiers: tiered[index]!.tiers }));
}

/**
 * Each variant's reference on the catalogue -- its baseline price and the ladder the
 * merchant had -- with its recorded cost, for the floor. The baseline is the one every
 * campaign reads, filed as MARKET (#1071). A variant with none has nothing to recompute
 * from, and is returned apart rather than given an empty ladder: "no baseline" is not "no
 * ladder", and clearing on it would delete the merchant's own.
 */
async function ladderBaselines(
  shopId: string,
  list: { priceListGid: string; currency: string },
  variantGids: readonly string[],
): Promise<{ variants: LadderBaselineInput[]; unanchored: string[]; unread: string[] }> {
  const [baselines, titles] = await Promise.all([
    inChunks([...variantGids], (batch) =>
      prisma.baseline.findMany({
        where: { shopId, surfaceKind: "MARKET", priceListGid: list.priceListGid, variantGid: { in: batch }, supersededAt: null },
        select: { variantGid: true, currency: true, basePrice: true, quantityBreaks: true, ladderRead: true },
      }),
    ),
    inChunks([...variantGids], (batch) =>
      prisma.variantIndex.findMany({ where: { shopId, variantGid: { in: batch } }, select: { variantGid: true, title: true } }),
    ),
  ]);
  const byVariant = new Map(baselines.map((row) => [row.variantGid, row]));
  const titleOf = new Map(titles.map((row) => [row.variantGid, row.title]));
  const costs = await recordedCosts(shopId, list.currency, [...byVariant.keys()]);

  const variants: LadderBaselineInput[] = [];
  const unanchored: string[] = [];
  const unread: string[] = [];
  for (const variantGid of variantGids) {
    const baseline = byVariant.get(variantGid);
    if (!baseline) {
      unanchored.push(variantGid);
      continue;
    }
    // A ladder nobody read is not "no ladder" (#1103): reverting on it would clear the
    // merchant's quantity breaks, so it is held back as a variant with no baseline is.
    if (baseline.ladderRead !== true) {
      unread.push(variantGid);
      continue;
    }
    const currency = baseline.currency || list.currency;
    variants.push({
      variantGid,
      title: titleOf.get(variantGid) ?? variantGid,
      baseline: money(Number(baseline.basePrice), currency),
      cost: costs.get(variantGid),
      ladder: parseLadder(baseline.quantityBreaks, currency),
    });
  }
  return { variants, unanchored, unread };
}
