/**
 * The one-page answer to "what did that run actually do".
 *
 * Reads the ledger rather than the plan, because the plan is what we intended and the
 * ledger is what happened. Those diverge exactly when a merchant most needs to know:
 * guardrails clamp, Shopify rejects, a run finishes partial.
 */

import prisma from "../../db.server";
import { readSettings } from "../settings.server";
import {
  describeRun,
  isClean,
  summariseRun,
  tallyStatuses,
  type ResultRow,
  type RunResult,
} from "../../lib/campaigns/run-result";

/**
 * How many ledger rows the margin figure will read.
 *
 * Counts are aggregated in the database and are exact at any size. The margin average
 * needs each row's cost, which means reading rows — so it is bounded, and when the bound
 * bites the page says so. A margin figure quietly computed from the first slice of a
 * large run would be a number that looks like the whole campaign and is not.
 */
export const MARGIN_ROW_LIMIT = 50_000;

export interface CampaignResult extends RunResult {
  runId: string;
  summary: string;
  /**
   * Set when the run had more rows than the margin calculation read. Non-null means the
   * margin figures describe a subset, and the page must say which.
   */
  marginCoveredRows: number | null;
  /**
   * What we cannot say, and why. Units and revenue need order data, which needs Protected
   * Customer Data approval — naming the gap beats leaving an empty panel that reads like
   * a bug.
   */
  unavailable: string;
}

const UNAVAILABLE =
  "Units sold and revenue are not shown. That needs order data, which Shopify gates " +
  "behind Protected Customer Data approval. Margin here is arithmetic on price and " +
  "cost — it is not a claim about what this campaign earned.";

export async function campaignResult(
  shopId: string,
  runId: string,
): Promise<CampaignResult | null> {
  const run = await prisma.campaignRun.findFirst({
    where: { id: runId, shopId },
    select: { id: true },
  });
  if (!run) return null;

  const [byStatus, settings] = await Promise.all([
    prisma.variantChange.groupBy({
      by: ["status"],
      where: { shopId, runId },
      _count: { _all: true },
    }),
    readSettings(shopId),
  ]);

  // Classified by the same function the pure summariser uses, so the aggregate path and
  // the row path cannot disagree about which bucket a status belongs in.
  const counts = tallyStatuses(
    byStatus.map((group) => ({ status: group.status, count: group._count._all })),
  );
  if (counts.total === 0) return null;

  const rows = await marginRows(shopId, runId);

  // Counts come from the aggregate so they are exact even when the rows are capped;
  // `summariseRun` would otherwise report the size of the slice it was handed.
  // The margin comes from the rows that were read; the counts come from the aggregate,
  // so they stay exact even when the rows are capped.
  const result = summariseRun(rows, settings.minMarginPercent);
  result.counts = counts;
  result.clean = isClean(counts);

  return {
    ...result,
    runId,
    summary: describeRun(result),
    marginCoveredRows: counts.total > MARGIN_ROW_LIMIT ? rows.length : null,
    unavailable: UNAVAILABLE,
  };
}

/**
 * The rows the margin figure is computed from, with each variant's cost joined on.
 *
 * Only rows that were actually written and whose price we can stand behind: a row we
 * could not read back is not evidence of a price, and averaging it in would make a
 * partial run look complete.
 *
 * `summariseRun` applies that rule again in memory, so the status filter here is not what
 * enforces it — dropping it changes no result at small sizes. Its job is the row budget:
 * without it a large run spends `MARGIN_ROW_LIMIT` on skipped and failed rows and the
 * margin quietly describes a smaller slice of the campaign than it could have.
 *
 * **Cost comes from the baseline, not the catalogue mirror**, matching `costsFor` in the
 * preview — the baseline is what the margin guardrail reads at resolve time, so taking it
 * from anywhere else would let the margin a merchant is shown disagree with the floor
 * that clamped the price. The mirror is joined only for a readable title.
 *
 * A baseline whose currency differs from the row's is left out rather than divided into
 * it. Comparing a cost in one currency against a price in another produces a margin that
 * is arithmetically fine and completely meaningless, and "we do not know" is the honest
 * answer.
 *
 * **The price falls back to `intendedPrice`.** For a VERIFIED row that is the price that
 * is live: verification means the read-back matched what we intended, and the writer does
 * not restate it in `verifiedPrice` — which is why `reconciliation.server.ts` reads
 * `intendedPrice` for exactly the same purpose. The two nullable columns are preferred
 * first anyway, so this keeps working if the writer ever starts filling them in.
 */
async function marginRows(shopId: string, runId: string): Promise<ResultRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      variantGid: string;
      title: string | null;
      status: string;
      beforePrice: bigint | null;
      afterPrice: bigint | null;
      cost: bigint | null;
      currency: string;
    }>
  >`
    SELECT c."variantGid",
           v."title",
           c."status"::text AS "status",
           c."beforePrice",
           COALESCE(c."verifiedPrice", c."appliedPrice", c."intendedPrice") AS "afterPrice",
           b."cost",
           c."currency"
    FROM "variant_changes" c
    LEFT JOIN "variant_index" v
      ON v."shopId" = c."shopId"
     AND v."variantGid" = c."variantGid"
    LEFT JOIN "baselines" b
      ON b."shopId" = c."shopId"
     AND b."variantGid" = c."variantGid"
     AND b."surfaceKind" = 'BASE'
     AND b."priceListGid" = ''
     AND b."supersededAt" IS NULL
     AND b."currency" = c."currency"
    WHERE c."shopId" = ${shopId}
      AND c."runId" = ${runId}
      AND c."status" IN ('VERIFIED', 'CLAMPED')
    ORDER BY c."createdAt" ASC
    LIMIT ${MARGIN_ROW_LIMIT}
  `;

  return rows.map((row) => ({
    variantGid: row.variantGid,
    title: row.title ?? row.variantGid,
    status: row.status,
    beforeMinor: row.beforePrice,
    afterMinor: row.afterPrice,
    costMinor: row.cost,
    currency: row.currency,
  }));
}
