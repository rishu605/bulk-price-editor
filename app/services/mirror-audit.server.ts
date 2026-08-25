/**
 * The nightly check that keeps the mirror honest.
 *
 * Every claim this app makes rests on the mirror being an accurate picture of the
 * merchant's catalogue. Webhooks get missed, payloads arrive out of order, bugs slip in
 * — and mirror drift is invisible until a campaign prices the wrong products. By then
 * there is no recovering the trust, because "the app changed prices it should not have"
 * is not something you explain your way out of.
 *
 * So a sample is fresh-read from Shopify every night and diffed against what we hold.
 * Divergence is healed on the spot and recorded as a rate; a rate above half a percent
 * is systematic rather than incidental and says something is wrong with the pipeline
 * rather than with one webhook.
 *
 * Runs from the scheduler tick, off-peak, and through the rate-limit budget like
 * everything else. An audit that throttled a merchant's own campaign to check up on
 * itself would be a poor trade.
 */

import prisma from "../db.server";
import {
  ALERT_THRESHOLD,
  auditSample,
  sampleSize,
  type AuditVerdict,
  type LiveRow,
} from "../lib/audit/sampling";
import { logger } from "../lib/logging/logger";
import { metric } from "../lib/telemetry/metrics";
import type { AdminClient } from "../lib/execution/sync-executor";
import { isThrottledError, withRetry } from "../lib/shopify/budget";

export const AUDIT_VARIANTS_QUERY = `#graphql
  query AnchorAuditVariants($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant { id price compareAtPrice }
    }
  }
`;

export interface AuditResult extends AuditVerdict {
  shopId: string;
  /** Rows corrected in the mirror as a result. */
  healed: number;
  /** Variants Shopify no longer knows about, tombstoned rather than deleted. */
  tombstoned: number;
}

/** Read in batches Shopify will accept, and small enough not to dominate the budget. */
const BATCH = 100;

export async function auditMirror(
  client: AdminClient,
  shopId: string,
  options: { threshold?: number; now?: Date } = {},
): Promise<AuditResult> {
  const threshold = options.threshold ?? ALERT_THRESHOLD;
  const now = options.now ?? new Date();

  const total = await prisma.variantIndex.count({ where: { shopId, deletedAt: null } });
  const size = sampleSize(total);

  if (size === 0) {
    return { shopId, checked: 0, diverged: 0, rate: 0, divergences: [], alert: false, healed: 0, tombstoned: 0 };
  }

  // Random rows rather than the first N. Ordering by id would check the same variants
  // every night and leave the rest of the catalogue permanently unexamined — which is
  // where drift would then live.
  const sample = await prisma.$queryRaw<
    Array<{ variantGid: string; price: bigint | null; compareAt: bigint | null }>
  >`
    SELECT "variantGid", "price", "compareAt"
    FROM "variant_index"
    WHERE "shopId" = ${shopId} AND "deletedAt" IS NULL
    ORDER BY random()
    LIMIT ${size}
  `;

  const live: LiveRow[] = [];

  for (let i = 0; i < sample.length; i += BATCH) {
    const ids = sample.slice(i, i + BATCH).map((row) => row.variantGid);

    const response = await withRetry(
      () =>
        client.request<{
          nodes?: Array<{ id: string; price?: string | null; compareAtPrice?: string | null } | null>;
        }>(AUDIT_VARIANTS_QUERY, { ids }),
      isThrottledError,
    );

    const nodes = response.data?.nodes ?? [];
    nodes.forEach((node, index) => {
      const variantGid = ids[index];
      // A null node is Shopify saying it has never heard of this id. Recorded as such
      // rather than skipped, because a mirror full of ghosts enrolls them in campaigns.
      if (!node) {
        live.push({ variantGid, price: null, compareAt: null, missing: true });
        return;
      }
      live.push({
        variantGid: node.id,
        price: node.price ? BigInt(Math.round(Number(node.price) * 100)) : null,
        compareAt: node.compareAtPrice
          ? BigInt(Math.round(Number(node.compareAtPrice) * 100))
          : null,
      });
    });
  }

  const verdict = auditSample(sample, live, threshold);
  const result: AuditResult = { shopId, ...verdict, healed: 0, tombstoned: 0 };

  // Healed as they are found. The point of the audit is a mirror that is right
  // afterwards, not a report saying it was wrong.
  for (const divergence of verdict.divergences) {
    const fresh = live.find((row) => row.variantGid === divergence.variantGid);

    if (divergence.kind === "unknown-to-shopify" || divergence.kind === "deleted") {
      // Tombstoned, never deleted: ledger rows still reference this variant and have to
      // stay resolvable on revert (E4).
      await prisma.variantIndex.updateMany({
        where: { shopId, variantGid: divergence.variantGid },
        data: { deletedAt: now },
      });
      result.tombstoned++;
      continue;
    }

    await prisma.variantIndex.updateMany({
      where: { shopId, variantGid: divergence.variantGid },
      data: { price: fresh?.price ?? null, compareAt: fresh?.compareAt ?? null, syncedAt: now },
    });
    await prisma.priceSurfaceEntry.updateMany({
      where: { shopId, variantGid: divergence.variantGid, surfaceKind: "BASE", priceListGid: "" },
      data: { livePrice: fresh?.price ?? null, liveCompareAt: fresh?.compareAt ?? null, syncedAt: now },
    });
    result.healed++;
  }

  // Recorded whether or not it alerted. A rate that is fine tonight and fine tomorrow
  // and creeping the week after is the signal worth having, and it only exists if the
  // quiet nights are written down too.
  await prisma.auditLogEntry.create({
    data: {
      shopId,
      action: "mirror.audit",
      entity: "Shop",
      entityId: shopId,
      after: {
        checked: verdict.checked,
        diverged: verdict.diverged,
        // Two significant figures: the exact float is noise on a sample of five hundred.
        ratePercent: Number((verdict.rate * 100).toFixed(2)),
        healed: result.healed,
        tombstoned: result.tombstoned,
        alert: verdict.alert,
      },
    },
  });

  const line = {
    shopId,
    checked: verdict.checked,
    diverged: verdict.diverged,
    ratePercent: Number((verdict.rate * 100).toFixed(2)),
    healed: result.healed,
    tombstoned: result.tombstoned,
  };

  metric("mirror.divergence_rate", verdict.rate, { shopId, checked: verdict.checked });

  if (verdict.alert) {
    // Systematic. One missed webhook is a row; half a percent of a sample is a
    // pipeline, and the response is a full re-sync rather than more healing.
    logger.error("mirror divergence above threshold", line);
  } else {
    logger.info("mirror audited", line);
  }

  return result;
}
