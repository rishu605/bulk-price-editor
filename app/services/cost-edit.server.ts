/**
 * Editing costs in bulk, and noticing what that breaks.
 *
 * The bulk edit is the easy half. The half that matters is this: **changing a cost can
 * retroactively invalidate a campaign that is already running.** A sale planned when a
 * jacket cost £40 was comfortably above the margin floor; after the supplier raises it to
 * £55, the live price is below cost and has been since the moment the cost changed.
 *
 * Nothing about the storefront changed, so nothing alerts, and no run failed. The
 * merchant is losing money on every sale and the only thing that could tell them is the
 * app that knows both numbers. That is what `newlyViolating` is for.
 *
 * It reports rather than acts. Automatically repricing a live campaign because a cost
 * moved would be the app changing prices on its own initiative, which is the one thing it
 * must never do — and the merchant may well want to honour the sale and eat the margin.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import { computeFloor, MissingCostError } from "../lib/pricing/guardrails";
import { applyCostRule, type CostRule } from "../lib/pricing/cost-rules";
import { money, type Money } from "../lib/money/money";
import { astToWhere, type FilterAst } from "./segments.server";
import { guardrailsFor } from "./settings.server";

export interface CostEditResult {
  matched: number;
  changed: number;
  /** Variants the rule could not compute a cost for, with why. */
  skipped: Array<{ variantGid: string; reason: string }>;
  dryRun: boolean;
}

/**
 * Applies a cost rule across a scope.
 *
 * Costs are written by superseding the current baseline rather than editing it, because
 * baselines are append-only and "what did this cost in March" is a question somebody asks
 * after a margin looks wrong. The price on the new row is copied unchanged: this is a
 * cost edit, and quietly recapturing the price at the same time would be the single most
 * destructive thing this function could do.
 */
export async function editCosts(
  shopId: string,
  ast: FilterAst,
  rule: CostRule,
  options: { dryRun?: boolean; actor?: string } = {},
): Promise<CostEditResult> {
  const result: CostEditResult = {
    matched: 0,
    changed: 0,
    skipped: [],
    dryRun: options.dryRun === true,
  };

  const variants = await prisma.variantIndex.findMany({
    where: astToWhere(shopId, ast),
    select: { variantGid: true },
  });
  result.matched = variants.length;
  if (variants.length === 0) return result;

  const gids = variants.map((row) => row.variantGid);

  const baselines = await prisma.baseline.findMany({
    where: {
      shopId,
      surfaceKind: "BASE",
      priceListGid: "",
      supersededAt: null,
      variantGid: { in: gids },
    },
  });

  const now = new Date();

  for (const baseline of baselines) {
    const currency = baseline.currency;
    const outcome = applyCostRule(rule, {
      cost: baseline.cost === null ? undefined : money(Number(baseline.cost), currency),
      basePrice: money(Number(baseline.basePrice), currency),
    });

    if (outcome.kind === "skipped") {
      result.skipped.push({
        variantGid: baseline.variantGid,
        reason:
          outcome.reason === "no-cost"
            ? "This rule adjusts an existing cost and this variant has none. Import a cost, or use a rule that sets one."
            : "That rule produces a negative cost.",
      });
      continue;
    }

    // Unchanged is not a write. Superseding a baseline to store the number it already
    // holds would add a version to its history that says nothing happened.
    if (baseline.cost !== null && Number(baseline.cost) === outcome.cost.amount) continue;

    result.changed += 1;
    if (result.dryRun) continue;

    await prisma.$transaction([
      prisma.baseline.update({
        where: { id: baseline.id },
        data: { supersededAt: now },
      }),
      prisma.baseline.create({
        data: {
          shopId,
          variantGid: baseline.variantGid,
          surfaceKind: baseline.surfaceKind,
          priceListGid: baseline.priceListGid,
          currency,
          // Copied unchanged. This is a cost edit; recapturing the price here would
          // silently enshrine whatever the storefront currently shows as the new normal.
          basePrice: baseline.basePrice,
          baseCompareAt: baseline.baseCompareAt,
          cost: BigInt(outcome.cost.amount),
          source: baseline.source,
          capturedBy: options.actor ?? null,
        },
      }),
      prisma.variantIndex.updateMany({
        where: { shopId, variantGid: baseline.variantGid },
        data: { cost: BigInt(outcome.cost.amount) },
      }),
    ]);
  }

  if (!result.dryRun && result.changed > 0) {
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: options.actor ?? null,
        action: "cost.bulk-edit",
        entity: "cost",
        after: { rule: rule.kind, matched: result.matched, changed: result.changed } as never,
      },
    });
  }

  logger.info("costs edited", {
    shopId,
    rule: rule.kind,
    matched: result.matched,
    changed: result.changed,
    skipped: result.skipped.length,
    dryRun: result.dryRun,
  });

  return result;
}

export interface FloorViolation {
  campaignId: string;
  campaignName: string;
  variantGid: string;
  title: string;
  /** What the storefront charges right now. */
  live: Money;
  /** What the guardrail now says is the minimum. */
  floor: Money;
}

/**
 * Live prices that are now below a floor, because a cost moved.
 *
 * Checked against the *live* price rather than against what the campaign intended,
 * because the intent was legal when it was planned. What matters is that the storefront
 * is charging less than the merchant's own policy allows, right now.
 *
 * Keyed on the *ledger row* still being VERIFIED, not on the campaign's status. Those
 * sound equivalent and are not: a reverted row is REVERTED and drops out by itself, but a
 * campaign someone cancelled without reverting still has VERIFIED rows and still has
 * discounted prices on the storefront. Filtering by campaign status would have hidden
 * exactly that case — the merchant is losing money either way, and the campaign's label
 * has no bearing on it.
 */
export async function newlyViolating(shopId: string): Promise<FloorViolation[]> {
  const guardrails = await guardrailsFor(shopId);

  // Nothing cost-dependent configured means a cost change cannot invalidate anything.
  // `computeFloor` would reach the same conclusion per variant; this skips the queries
  // entirely for the many shops that never set a cost floor.
  if (!guardrails.neverBelowCost && guardrails.minMarginPercent === undefined) return [];

  const written = await prisma.variantChange.findMany({
    where: {
      shopId,
      status: "VERIFIED",
      surfaceKind: "BASE",
    },
    select: {
      variantGid: true,
      run: { select: { campaignId: true, campaign: { select: { name: true } } } },
    },
    distinct: ["variantGid"],
    take: 10_000,
  });

  if (written.length === 0) return [];

  const gids = written.map((row) => row.variantGid);

  const [baselines, entries, titles] = await Promise.all([
    prisma.baseline.findMany({
      where: {
        shopId,
        surfaceKind: "BASE",
        priceListGid: "",
        supersededAt: null,
        variantGid: { in: gids },
      },
      select: { variantGid: true, basePrice: true, baseCompareAt: true, cost: true, currency: true },
    }),
    prisma.priceSurfaceEntry.findMany({
      where: { shopId, surfaceKind: "BASE", priceListGid: "", variantGid: { in: gids } },
      select: { variantGid: true, livePrice: true, currency: true },
    }),
    prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: gids } },
      select: { variantGid: true, title: true },
    }),
  ]);

  const baselineBy = new Map(baselines.map((row) => [row.variantGid, row]));
  const liveBy = new Map(entries.map((row) => [row.variantGid, row]));
  const titleBy = new Map(titles.map((row) => [row.variantGid, row.title]));

  const violations: FloorViolation[] = [];

  for (const row of written) {
    const baseline = baselineBy.get(row.variantGid);
    const live = liveBy.get(row.variantGid);
    if (!baseline || !live || live.livePrice === null) continue;

    const currency = baseline.currency || live.currency || "USD";

    let floor: Money | undefined;
    try {
      floor = computeFloor(
        {
          price: money(Number(baseline.basePrice), currency),
          compareAtPrice: baseline.baseCompareAt === null
            ? undefined
            : money(Number(baseline.baseCompareAt), currency),
          cost: baseline.cost === null ? undefined : money(Number(baseline.cost), currency),
        },
        guardrails,
      );
    } catch (error) {
      // A variant with no cost under an "error" policy. Not a violation — it is a
      // variant the guardrail cannot judge, and reporting it here would mix "this is
      // losing money" with "we cannot tell", which are different problems.
      if (error instanceof MissingCostError) continue;
      throw error;
    }

    if (!floor) continue;

    const livePrice = Number(live.livePrice);
    if (livePrice >= floor.amount) continue;

    violations.push({
      campaignId: row.run.campaignId,
      campaignName: row.run.campaign.name,
      variantGid: row.variantGid,
      title: titleBy.get(row.variantGid) ?? row.variantGid,
      live: money(livePrice, currency),
      floor,
    });
  }

  // Worst first — the biggest gap between what is charged and what policy allows is the
  // one costing the most per sale.
  return violations.sort((a, b) => b.floor.amount - b.live.amount - (a.floor.amount - a.live.amount));
}
