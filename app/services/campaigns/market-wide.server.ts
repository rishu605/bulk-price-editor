/**
 * The one-mutation path: repricing a market by its parent adjustment.
 *
 * Chosen only when `uniformAdjustment` proves it safe, and even then the run still
 * ledgers every variant first and verifies every variant afterwards. The saving is in
 * the number of writes, not in the amount of truth.
 *
 * The verification is the part worth reading. On the per-product path we send a price
 * and Shopify stores that exact number, so reading it back confirms a value we chose.
 * Here we send a percentage: Shopify computes each price itself, rounding its own way
 * from a converted base price we never see. Its answer can land a minor unit away from
 * ours. Since the ledger has already promised a specific number to the merchant, rows
 * that disagree are corrected with a per-product price rather than quietly accepted —
 * which is what makes taking a shortcut on the write path still honest at the end.
 */

import type { Prisma } from "@prisma/client";

import prisma from "../../db.server";
import { inRunChunks } from "../../lib/db/run-writes.server";
import {
  readContextualPrices,
  readDerivedPrices,
  writeMarketPrices,
  type MarketPriceRow,
} from "../../lib/execution/market-executor";
import {
  setParentAdjustment,
  type ParentState,
} from "../../lib/execution/price-list-parent";
import type { AdminClient } from "../../lib/execution/sync-executor";
import {
  composeBps,
  correctionCause,
  describeCorrections,
  toAdjustmentInput,
  type CorrectionCause,
} from "../../lib/markets/uniform";
import { parseMoney } from "../../lib/money/money";
import type { PlannedRow } from "../../lib/planning/types";
import { mirrorMarketWrite } from "./mirror.server";

export interface MarketWideResult {
  verified: number;
  failed: number;
  /** Rows the percentage did not land on, then fixed with a per-product price. */
  corrected: number;
  messages: string[];
}

export interface MarketWideInputs {
  shopId: string;
  campaignId: string;
  runId: string;
  /** `contextCountry`: a country the list's market serves, which verification asks after (#1110). */
  list: { priceListGid: string; name: string; currency: string; contextCountry?: string | null };
  rows: readonly PlannedRow[];
  /** The campaign's own percentage, before composing with the market's. */
  campaignBps: number;
  parent: ParentState;
  client: AdminClient;
}

export async function applyMarketWide(
  inputs: MarketWideInputs,
): Promise<MarketWideResult> {
  const { shopId, campaignId, runId, list, rows, campaignBps, parent, client } = inputs;

  // The market's own percentage, before this campaign ever touched it.
  //
  // Read from the ledger when the campaign has already applied to this market, and
  // only from the live list otherwise. Composing against the live value on a re-apply
  // would take the campaign's discount off the campaign's own discount — the market
  // equivalent of pricing from the live price instead of the baseline, and it compounds
  // every single time the campaign runs.
  const prior = await priorAdjustment(campaignId, list.priceListGid, parent);

  const appliedBps = composeBps(prior ?? 0, campaignBps);
  const messages: string[] = [];

  // Ledgered before the write, exactly as a price is (I4). The prior adjustment is the
  // reason this row exists: once the mutation lands, the merchant's own percentage is
  // not recorded anywhere else in the world.
  await prisma.priceListChange.upsert({
    where: { runId_priceListGid: { runId, priceListGid: list.priceListGid } },
    create: {
      shopId,
      runId,
      campaignId,
      priceListGid: list.priceListGid,
      priorAdjustmentBps: prior,
      appliedAdjustmentBps: appliedBps,
      status: "WRITING",
    },
    // A resumed run must not overwrite the prior adjustment with the one this campaign
    // already applied -- that would make the revert restore the sale rather than undo
    // it. Only the outcome fields move on the second pass.
    update: { appliedAdjustmentBps: appliedBps, status: "WRITING", failureReason: null },
  });

  const write = await setParentAdjustment(
    client,
    list.priceListGid,
    toAdjustmentInput(appliedBps),
  );

  if (!write.ok) {
    await prisma.priceListChange.update({
      where: { runId_priceListGid: { runId, priceListGid: list.priceListGid } },
      data: { status: "FAILED", failureReason: write.errors.join("; ") },
    });
    await failRows(runId, list.priceListGid, rows, write.errors.join("; "));

    return {
      verified: 0,
      failed: rows.length,
      corrected: 0,
      messages: [
        `${list.name}: the market-wide percentage was rejected, so no price changed there ` +
          `(${write.errors.join("; ")}).`,
      ],
    };
  }

  await prisma.priceListChange.update({
    where: { runId_priceListGid: { runId, priceListGid: list.priceListGid } },
    data: { status: "APPLIED", appliedAt: new Date() },
  });

  // --------------------------------------------------------- read back and verify
  //
  // What a shopper in the market pays, where the list has a market (#1110): asked as the
  // baselines are, through `contextualPricing` for one of its countries, which answers in the
  // market's currency with the percentage applied. The list's own `RELATIVE` prices answer in
  // the shop's currency (#257), so on a list in any other currency no row could be verified,
  // every one was given an exact price, and the market stopped following the store price the
  // Markets card had said it would keep following. A list with no market -- a B2B catalogue
  // -- has no country to ask for, and is read as before.
  const gids = rows.map((row) => row.ref.variantGid);
  const derived = list.contextCountry
    ? await readContextualPrices(client, gids, list.contextCountry)
    : await readDerivedPrices(client, list.priceListGid, gids);

  const drifted: MarketPriceRow[] = [];
  const verified: string[] = [];
  // Why each drifted one could not be verified, so the run names the cause it had (#1094).
  const causes = new Map<string, CorrectionCause>();

  for (const row of rows) {
    const intended = row.intendedPrice;
    if (!intended) continue;

    // Verified only against a price Shopify stated in this market's currency. A
    // `RELATIVE` price arrives in the *shop's* currency (#257), and a read-back that
    // compared it as though it were the market's would mark a row verified against a
    // number denominated in something else entirely.
    const live = derived.get(row.ref.variantGid);
    if (
      live !== undefined &&
      live.currency === list.currency &&
      parseMoney(live.amount, live.currency).amount === intended.amount
    ) {
      verified.push(row.ref.variantGid);
    } else {
      // The price only: these rows were planned without a strike-through decision, and
      // `null` would now clear one (#763).
      drifted.push({ variantGid: row.ref.variantGid, price: intended });
      causes.set(row.ref.variantGid, correctionCause(live, intended));
    }
  }

  await settle(runId, list.priceListGid, verified, "VERIFIED");
  await prisma.priceListChange.update({
    where: { runId_priceListGid: { runId, priceListGid: list.priceListGid } },
    data: { status: "VERIFIED", verifiedAt: new Date() },
  });

  let corrected = 0;
  let failed = 0;

  if (drifted.length > 0) {
    // Already ledgered with these exact prices, so writing them now still satisfies
    // "ledger before write" without a second write-ahead.
    const fix = await writeMarketPrices(client, list.priceListGid, list.currency, drifted);
    // These are fixed prices on the list now, mirrored as any other market write (#779).
    await mirrorMarketWrite(shopId, list, drifted, fix);

    await settle(
      runId,
      list.priceListGid,
      fix.rows.filter((row) => row.status === "verified").map((row) => row.variantGid),
      "VERIFIED",
    );
    corrected = fix.verified;
    failed = fix.failed;

    for (const row of fix.rows) {
      if (row.status === "verified") continue;
      await prisma.variantChange.updateMany({
        where: { runId, priceListGid: list.priceListGid, variantGid: row.variantGid },
        data: {
          status: "FAILED",
          failureReason: row.failureReason ?? "Shopify did not confirm this price.",
        },
      });
    }

    const byCause: Partial<Record<CorrectionCause, number>> = {};
    for (const row of fix.rows) {
      const cause = causes.get(row.variantGid);
      if (row.status === "verified" && cause) byCause[cause] = (byCause[cause] ?? 0) + 1;
    }
    messages.push(...describeCorrections(list.name, byCause));
  }

  messages.unshift(
    `${list.name}: repriced with one market-wide change of ` +
      `${describeBps(appliedBps)}${
        prior
          ? ` (your ${describeBps(prior)} market setting combined with this campaign)`
          : ""
      }.`,
  );

  return { verified: verified.length + corrected, failed, corrected, messages };
}

/**
 * Puts a market's own adjustment back.
 *
 * Restoring the recorded prior value, not recomputing the inverse. The inverse of a
 * composed percentage is not the percentage the merchant set — it is a number that
 * happens to land nearby, and after two campaigns it would not even do that.
 */
export async function revertMarketWide(
  campaignId: string,
  client: AdminClient,
): Promise<string[]> {
  // Oldest first, and one per market: the row that knows the merchant's own percentage
  // is the *first* one this campaign wrote. A campaign applied twice has a second row
  // whose "prior" value is the campaign's own first adjustment, and restoring that
  // would put the sale back rather than undo it.
  const changes = await prisma.priceListChange.findMany({
    where: { campaignId, status: { in: ["APPLIED", "VERIFIED"] } },
    orderBy: { createdAt: "asc" },
  });

  const firstPerList = new Map<string, (typeof changes)[number]>();
  for (const change of changes) {
    if (!firstPerList.has(change.priceListGid)) firstPerList.set(change.priceListGid, change);
  }

  const messages: string[] = [];

  for (const change of firstPerList.values()) {
    // A list that had no parent adjustment before the campaign cannot be restored by
    // setting one: 0% is a pinned percentage, not the absence of one. Rather than
    // guess, we say so — the alternative is silently pinning a market the merchant
    // had deliberately left alone.
    if (change.priorAdjustmentBps === null) {
      await prisma.priceListChange.updateMany({
        where: { campaignId, priceListGid: change.priceListGid, status: { in: ["APPLIED", "VERIFIED"] } },
        data: {
          status: "FAILED",
          failureReason:
            "This market had no percentage of its own before the campaign, and one " +
            "cannot be removed through the API. Clear it in Shopify's Markets settings.",
        },
      });
      messages.push(
        `${change.priceListGid} needs its market-wide percentage cleared by hand in ` +
          `Shopify — it had none before this campaign.`,
      );
      continue;
    }

    const write = await setParentAdjustment(
      client,
      change.priceListGid,
      toAdjustmentInput(change.priorAdjustmentBps),
    );

    await prisma.priceListChange.updateMany({
      where: { campaignId, priceListGid: change.priceListGid, status: { in: ["APPLIED", "VERIFIED"] } },
      data: write.ok
        ? // The moment the market is the merchant's again: `priorAdjustment` reads the
          // campaign's history on this list from here on (#705).
          { status: "REVERTED", verifiedAt: new Date() }
        : { status: "FAILED", failureReason: write.errors.join("; ") },
    });

    if (!write.ok) {
      messages.push(
        `${change.priceListGid} still has the campaign's percentage on it ` +
          `(${write.errors.join("; ")}).`,
      );
    }
  }

  return messages;
}

/**
 * What this market's percentage was before the campaign.
 *
 * The earliest ledger row for this campaign and market since the campaign's last
 * completed revert there, falling back to the live value when there is none. Earliest,
 * not latest: a later row's "prior" is this campaign's own previous adjustment.
 *
 * Since the last revert, not ever (#705). Once the merchant's percentage is back on the
 * list, the market is theirs again and they may change it -- a recurring sale re-applies
 * a month later to a market at 15% that it last saw at 10%. The first row this campaign
 * ever wrote would then compose with the old 10%, and its revert would write that 10%
 * over the merchant's own 15%.
 */
async function priorAdjustment(
  campaignId: string,
  priceListGid: string,
  parent: ParentState,
): Promise<number | null> {
  // When the merchant's percentage was last confirmed back on this list. `revertMarketWide`
  // stamps that moment on the rows it settles as REVERTED, and only once its write landed;
  // a revert that failed here leaves them unreverted, the campaign's percentage still on
  // the list, and their prior still the one to keep. Per list rather than from the REVERT
  // run's status, which reads COMPLETED when a market's write failed (#706). And the
  // moment, not the reverted row's own age: a write Shopify rejected mid-sale stays FAILED,
  // never REVERTED, and is history once the revert lands however recently it was made.
  const lastRevert = await prisma.priceListChange.aggregate({
    where: { campaignId, priceListGid, status: "REVERTED" },
    _max: { verifiedAt: true },
  });
  const revertedAt = lastRevert._max.verifiedAt;

  const first = await prisma.priceListChange.findFirst({
    where: { campaignId, priceListGid, ...(revertedAt ? { createdAt: { gt: revertedAt } } : {}) },
    orderBy: { createdAt: "asc" },
    select: { priorAdjustmentBps: true },
  });

  return first ? first.priorAdjustmentBps : parent.adjustmentBps;
}

/** Human wording for a stored basis-point adjustment. */
function describeBps(bps: number): string {
  const percent = Math.abs(bps) / 100;
  const rounded = Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
  return bps < 0 ? `${rounded}% off` : `${rounded}% up`;
}

async function settle(
  runId: string,
  priceListGid: string,
  variantGids: readonly string[],
  status: Prisma.VariantChangeUpdateManyMutationInput["status"],
) {
  if (variantGids.length === 0) return;

  // A market-wide change settles every variant on the list at once, so this was one `IN`
  // list the size of the catalogue (#810). In `RUN_CHUNK` batches now, each retried.
  const now = new Date();
  await inRunChunks("ledger.market-wide.settle", variantGids, (batch) =>
    prisma.variantChange.updateMany({
      where: { runId, priceListGid, variantGid: { in: batch } },
      data: { status, verifiedAt: now, appliedAt: now },
    }),
  );
}

async function failRows(
  runId: string,
  priceListGid: string,
  rows: readonly PlannedRow[],
  reason: string,
) {
  await inRunChunks("ledger.market-wide.fail", rows.map((row) => row.ref.variantGid), (batch) =>
    prisma.variantChange.updateMany({
      where: { runId, priceListGid, variantGid: { in: batch } },
      data: { status: "FAILED", failureReason: reason },
    }),
  );
}
