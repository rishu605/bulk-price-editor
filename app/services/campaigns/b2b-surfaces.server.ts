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
import { parseLadder, serialiseLadder } from "../../lib/pricing/ladder-baseline";
import type { WholesaleGuardrail } from "../../lib/pricing/quantity-breaks";
import type { QuantityTier } from "../../lib/pricing/quantity-breaks";
import { logger } from "../../lib/logging/logger";
import { metric } from "../../lib/telemetry/metrics";
import { planQuantityBreaks, type B2BVariantInput } from "./b2b-plan.server";

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

  const plan = planQuantityBreaks(variants, tiers, guardrail);

  const empty: B2BSurfaceOutcome = {
    priceListGid: list.priceListGid,
    name: list.name,
    verified: 0,
    failed: 0,
    refused: plan.refused.length,
    chunks: 0,
    messages: plan.messages,
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

  const messages = [...plan.messages];
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
  await prisma.variantChange.createMany({
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
  });

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

    await prisma.variantChange.updateMany({
      where: { runId, shopId, priceListGid, variantGid: { in: gids } },
      data: {
        status: status === "verified" ? "VERIFIED" : "FAILED",
        appliedAt: status === "verified" ? now : null,
        verifiedAt: status === "verified" ? now : null,
      },
    });
  }

  for (const row of rows) {
    if (!row.failureReason) continue;

    await prisma.variantChange.updateMany({
      where: { runId, shopId, priceListGid, variantGid: row.variantGid },
      data: {
        // The merchant's version, then Shopify's. Support needs the latter.
        failureReason: row.guidance
          ? `${row.guidance} (Shopify said: ${row.failureReason})`
          : row.failureReason,
        attempt: { increment: 1 },
      },
    });
  }
}

/**
 * Takes a campaign's ladders back off a catalogue.
 *
 * Rule 6: revert recomputes rather than restores. For a ladder that means writing the one
 * the baseline holds — the merchant's own, captured before any campaign touched it — and
 * for a variant whose baseline holds none, it means clearing the ladder entirely. Both
 * are the same operation: write what `resolve(without C)` says, which here is simply the
 * baseline, because no other campaign writes ladders yet.
 *
 * Clearing is a real instruction, not a no-op. The campaign's ladder is live on the
 * catalogue and a buyer is being quoted from it, so "there is nothing to write" would
 * leave the sale price in place forever.
 */
export async function revertQuantityBreaks(
  shopId: string,
  runId: string,
  list: { priceListGid: string; name: string; currency: string },
  variantGids: readonly string[],
  client: AdminClient,
): Promise<B2BSurfaceOutcome | null> {
  if (variantGids.length === 0) return null;

  // Only variants this campaign actually gave a ladder to. Clearing one it never touched
  // would take away a ladder somebody else set.
  const written = await prisma.variantChange.findMany({
    where: {
      shopId,
      priceListGid: list.priceListGid,
      surfaceKind: "B2B",
      variantGid: { in: [...variantGids] },
      status: { in: ["VERIFIED", "CLAMPED"] },
      // Rows that *gave* a ladder. A clearing row from an earlier revert carries none,
      // and re-clearing would be a harmless no-op — this narrows the write rather than
      // guarding correctness, which is why removing it fails no test.
      quantityBreaks: { not: Prisma.DbNull },
    },
    select: { variantGid: true },
    distinct: ["variantGid"],
  });

  const ours = [...new Set(written.map((row) => row.variantGid))];
  if (ours.length === 0) return null;

  const baselines = await prisma.baseline.findMany({
    where: {
      shopId,
      priceListGid: list.priceListGid,
      variantGid: { in: ours },
      supersededAt: null,
    },
    select: { variantGid: true, currency: true, quantityBreaks: true },
  });

  const byVariant = new Map(baselines.map((row) => [row.variantGid, row]));

  const rows: QuantityRow[] = ours.map((variantGid) => {
    const baseline = byVariant.get(variantGid);
    const ladder = baseline
      ? parseLadder(baseline.quantityBreaks, baseline.currency || list.currency)
      : null;

    // No baseline ladder means the merchant had none, so the correct end state is none.
    return { variantGid, breaks: ladder ?? [] };
  });

  const result = await writeQuantityBreaks(client, list.priceListGid, rows, async (chunk, index) => {
    await ledgerLadderChunk(runId, shopId, list, chunk, index);
  });

  await recordLadderResults(runId, shopId, list.priceListGid, result.rows);

  const cleared = rows.filter((row) => row.breaks.length === 0).length;
  const messages: string[] = [];

  if (result.failed > 0) {
    messages.push(
      `${list.name}: ${result.failed} product${result.failed === 1 ? "" : "s"} still have this campaign's quantity breaks. Each batch is all-or-nothing, so nothing in a failed batch changed.`,
    );
  }
  if (cleared > 0 && result.clean) {
    messages.push(
      `${list.name}: ${cleared} product${cleared === 1 ? "" : "s"} had no quantity breaks before this campaign, so they have none now.`,
    );
  }

  metric("run.rows", result.verified, { runId, surface: "b2b", outcome: "reverted" });

  return {
    priceListGid: list.priceListGid,
    name: list.name,
    verified: result.verified,
    failed: result.failed,
    refused: 0,
    chunks: result.chunks,
    messages,
    clean: result.clean,
  };
}
