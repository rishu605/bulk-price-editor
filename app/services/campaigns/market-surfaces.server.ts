/**
 * Putting a campaign on a market's prices.
 *
 * A campaign that only ever touches the base price is a campaign that does nothing for a
 * merchant selling into four markets — their EUR and JPY customers see the old price
 * while the sale runs. This is the part that fixes that, and per-market compare-at is
 * the piece the ecosystem believes cannot be done.
 *
 * The market baseline comes from one of two places, and the distinction is the same one
 * P1.2 mirrors:
 *
 *   A fixed list stores a price per variant, so its baseline is that stored price.
 *
 *   A relative list stores a percentage, so its baseline is the base baseline with the
 *   percentage applied. Mirroring those per variant would restate one number a few
 *   million times, so it is computed here from the rule instead — arithmetic on integers
 *   the mirror already holds, not a second source of truth.
 *
 * Writing fixed prices to a relative list is deliberate rather than a compromise. It
 * overrides the parent adjustment per variant for the campaign's duration, and the
 * revert deletes them so the list goes back to tracking its percentage. Writing the old
 * numbers back instead would pin prices the merchant never chose and quietly stop the
 * market following the base price at all.
 */

import prisma from "../../db.server";
import type { MarketWritePath } from "../../lib/execution/price-list-parent";
import { decideMarketPath, planMarket } from "./market-plan.server";
import { applyMarketWide, revertMarketWide } from "./market-wide.server";
import {
  deleteMarketPrices,
  writeMarketPrices,
  type MarketPriceRow,
  type MarketWriteResult,
} from "../../lib/execution/market-executor";
import type { AdminClient } from "../../lib/execution/sync-executor";
import type { Guardrails, ResolvableCampaign } from "../../lib/pricing/types";
import { logger } from "../../lib/logging/logger";
import { metric } from "../../lib/telemetry/metrics";

/** Which surfaces a campaign writes to. Stored on the campaign as JSON. */
export interface CampaignSurfaces {
  base: boolean;
  /** Price list gids this campaign also prices. Empty means base only. */
  priceLists: string[];
}

export function parseSurfaces(raw: unknown): CampaignSurfaces {
  const value = (raw ?? {}) as { base?: unknown; priceLists?: unknown };
  return {
    // Base is on unless explicitly turned off. A campaign targeting only a market is
    // legitimate but unusual, and defaulting it off would silently narrow every
    // campaign created before markets existed.
    base: value.base !== false,
    priceLists: Array.isArray(value.priceLists)
      ? value.priceLists.filter((entry): entry is string => typeof entry === "string")
      : [],
  };
}

export interface MarketSurfaceOutcome {
  priceListGid: string;
  name: string;
  currency: string;
  verified: number;
  failed: number;
  chunks: number;
  messages: string[];
  /**
   * How this market was priced.
   *
   * Surfaced rather than kept internal because the two paths produce identical prices
   * but behave differently afterwards: a market-wide percentage keeps deriving from the
   * base price as it changes, and it is undone by restoring the merchant's own
   * percentage rather than by deleting per-product prices. A merchant reading their run
   * report is entitled to know which one happened.
   */
  path: MarketWritePath;
  /** Why the one-mutation path was not used, when it was not. */
  pathReason?: string;
}

/**
 * Runs the campaign's rule against each targeted market and writes the result.
 *
 * The rule is evaluated *on the market's own baseline* through the same planner the base
 * surface uses — not by converting the base surface's answer. That matters for more than
 * tidiness: a "set to exactly 9.99" rule has no meaningful conversion, a cost-margin rule
 * depends on a cost the market does not have, and a percentage converted after rounding
 * makes the market's discount a function of the base currency's rounding rather than of
 * the campaign. Re-resolving gets guardrails, rounding and the compare-at policy applied
 * per surface for free, which is the whole reason the resolver was written surface-first.
 */
export async function applyMarketSurfaces(
  shopId: string,
  campaignId: string,
  runId: string,
  campaigns: readonly ResolvableCampaign[],
  variantGids: readonly string[],
  client: AdminClient,
  storeGuardrails?: Guardrails,
): Promise<MarketSurfaceOutcome[]> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { surfaces: true },
  });
  const surfaces = parseSurfaces(campaign?.surfaces);
  if (surfaces.priceLists.length === 0) return [];

  const lists = await prisma.priceListRecord.findMany({
    where: { shopId, priceListGid: { in: surfaces.priceLists } },
  });

  const outcomes: MarketSurfaceOutcome[] = [];

  for (const list of lists) {
    const plan = await planMarket(shopId, list, variantGids, campaigns, client, storeGuardrails);
    if (!plan) continue;

    const { outcome } = plan;

    if (outcome.kind === "blocked") {
      outcomes.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        verified: 0,
        failed: 0,
        chunks: 0,
        messages: [
          `${list.name}: a guardrail stopped this market before anything was written (${outcome.reason}).`,
        ],
        path: "per-product",
      });
      continue;
    }

    const rows: MarketPriceRow[] = outcome.rows
      .filter((row) => row.status !== "skipped" && row.intendedPrice)
      .map((row) => ({
        variantGid: row.ref.variantGid,
        price: row.intendedPrice!,
        // The strike-through is this market's own number, so a shopper there sees what
        // they would otherwise have paid — not a figure converted from another currency,
        // which is both wrong and obviously wrong to them.
        compareAt: row.intendedCompareAtSet ? (row.intendedCompareAt ?? null) : null,
      }));

    if (rows.length === 0) continue;

    // The same decision the review step showed the merchant, taken by the same
    // function, so the run cannot quietly do something else.
    const decision = await decideMarketPath(plan, client);

    if (decision.path === "market-wide") {
      // Write-ahead for every row first, exactly as the chunked path does. The
      // shortcut is in the number of requests, not in the ledger.
      await ledgerChunk(runId, shopId, list, rows, 0);

      const wide = await applyMarketWide({
        shopId,
        campaignId,
        runId,
        list,
        rows: outcome.rows,
        campaignBps: decision.bps,
        parent: decision.parent,
        client,
      });

      outcomes.push({
        priceListGid: list.priceListGid,
        name: list.name,
        currency: list.currency,
        verified: wide.verified,
        failed: wide.failed,
        chunks: wide.corrected > 0 ? 2 : 1,
        messages: wide.messages,
        path: "market-wide",
      });
      continue;
    }

    const result = await writeMarketPrices(
      client,
      list.priceListGid,
      list.currency,
      rows,
      (chunk, index) => ledgerChunk(runId, shopId, list, chunk, index),
    );

    await recordResults(runId, shopId, list.priceListGid, result);
    outcomes.push({ ...summarise(list, result), path: "per-product", pathReason: decision.reason });
  }

  return outcomes;
}

/**
 * Removes a campaign's market prices.
 *
 * Driven by the ledger rather than by recomputation, for the same reason the tag kit is:
 * a merchant who changed which surfaces a campaign targets mid-run would otherwise strand
 * prices on a market nobody is looking at any more.
 */
export async function revertMarketSurfaces(
  shopId: string,
  campaignId: string,
  client: AdminClient,
): Promise<MarketSurfaceOutcome[]> {
  // Markets repriced by a single percentage are undone by restoring the merchant's
  // own percentage, not by deleting per-product prices — there are none to delete.
  const wideMessages = await revertMarketWide(campaignId, client);

  const written = await prisma.variantChange.findMany({
    where: {
      shopId,
      surfaceKind: "MARKET",
      status: { in: ["APPLIED", "VERIFIED"] },
      run: { campaignId },
    },
    select: { variantGid: true, priceListGid: true },
  });
  // The per-product sweep still runs after a market-wide revert, and should: the
  // apply may have corrected a handful of variants with exact prices where Shopify
  // rounded differently, and those really are fixed prices that have to be deleted.
  // Deleting one that is not there is a no-op, and the ledger rows need settling
  // either way.
  if (written.length === 0) return wideOutcomes(wideMessages);

  const byList = new Map<string, string[]>();
  for (const row of written) {
    const existing = byList.get(row.priceListGid) ?? [];
    existing.push(row.variantGid);
    byList.set(row.priceListGid, existing);
  }

  const outcomes: MarketSurfaceOutcome[] = [];

  for (const [priceListGid, variantGids] of byList) {
    const list = await prisma.priceListRecord.findFirst({ where: { shopId, priceListGid } });
    const result = await deleteMarketPrices(client, priceListGid, variantGids);

    await prisma.variantChange.updateMany({
      where: { shopId, priceListGid, variantGid: { in: variantGids }, run: { campaignId } },
      data: { status: result.clean ? "REVERTED" : "FAILED" },
    });

    outcomes.push({
      ...summarise(list ?? { priceListGid, name: priceListGid, currency: "" }, result),
      path: "per-product",
    });
  }

  return [...outcomes, ...wideOutcomes(wideMessages)];
}

/** Markets that could not have their own percentage put back, as an outcome row. */
function wideOutcomes(messages: string[]): MarketSurfaceOutcome[] {
  if (messages.length === 0) return [];

  return [
    {
      priceListGid: "",
      name: "Markets",
      currency: "",
      verified: 0,
      failed: messages.length,
      chunks: 0,
      messages,
      path: "market-wide",
    },
  ];
}

/** Write-ahead, per chunk. A chunk is the smallest thing that can independently fail. */
async function ledgerChunk(
  runId: string,
  shopId: string,
  list: { priceListGid: string; currency: string },
  chunk: readonly MarketPriceRow[],
  index: number,
): Promise<void> {
  await prisma.variantChange.createMany({
    data: chunk.map((row) => ({
      runId,
      shopId,
      variantGid: row.variantGid,
      surfaceKind: "MARKET" as const,
      priceListGid: list.priceListGid,
      currency: list.currency,
      intendedPrice: BigInt(row.price.amount),
      intendedCompareAt: row.compareAt ? BigInt(row.compareAt.amount) : null,
      intendedCompareAtSet: row.compareAt !== null && row.compareAt !== undefined,
      status: "PENDING" as const,
    })),
    skipDuplicates: true,
  });

  logger.info("market chunk ledgered", {
    runId,
    priceListGid: list.priceListGid,
    chunk: index,
    rows: chunk.length,
  });
}

async function recordResults(
  runId: string,
  shopId: string,
  priceListGid: string,
  result: MarketWriteResult,
): Promise<void> {
  const now = new Date();

  for (const status of ["verified", "failed"] as const) {
    const gids = result.rows.filter((row) => row.status === status).map((row) => row.variantGid);
    if (gids.length === 0) continue;

    await prisma.variantChange.updateMany({
      where: { runId, shopId, priceListGid, variantGid: { in: gids } },
      data: {
        status: status === "verified" ? "VERIFIED" : "FAILED",
        appliedAt: status === "verified" ? now : null,
        verifiedAt: status === "verified" ? now : null,
      },
    });
  }

  for (const row of result.rows) {
    if (!row.failureReason) continue;
    await prisma.variantChange.updateMany({
      where: { runId, shopId, priceListGid, variantGid: row.variantGid },
      data: {
        failureReason: row.guidance
          ? `${row.guidance} (Shopify said: ${row.failureReason})`
          : row.failureReason,
        attempt: { increment: 1 },
      },
    });
  }

  metric("run.rows", result.verified, { runId, surface: "market", outcome: "verified" });
  if (result.failed > 0) {
    metric("run.rows", result.failed, { runId, surface: "market", outcome: "failed" });
  }
}

function summarise(
  list: { priceListGid: string; name: string; currency: string },
  result: MarketWriteResult,
): Omit<MarketSurfaceOutcome, "path"> {
  return {
    priceListGid: list.priceListGid,
    name: list.name,
    currency: list.currency,
    verified: result.verified,
    failed: result.failed,
    chunks: result.chunks,
    messages: result.rows
      .filter((row) => row.guidance)
      .slice(0, 3)
      .map((row) => `${list.name}: ${row.guidance}`),
  };
}
