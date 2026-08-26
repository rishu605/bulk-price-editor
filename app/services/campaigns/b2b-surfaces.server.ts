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
import { serialiseLadder } from "../../lib/pricing/ladder-baseline";
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
 * One ledger row per variant, carrying the whole ladder.
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
      intendedPrice: BigInt(row.breaks[0]!.price.amount),
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
