/**
 * Campaigns: the bridge between the pure pricing engine and the store.
 *
 * Everything decision-making lives in app/lib (resolver, planner, executors) and is
 * property-tested without a database. This module only loads inputs, calls those
 * functions, and persists what came back — so the parts that can misprice a
 * storefront stay testable, and the parts that touch I/O stay thin.
 */

import prisma from "../db.server";
import { money, type Money } from "../lib/money/money";
import { charm99, NO_ROUNDING, type RoundingProfile } from "../lib/money/rounding";
import type {
  AdjustmentRule,
  Baseline,
  CompareAtPolicy,
  Guardrails,
  ResolvableCampaign,
} from "../lib/pricing/types";
import { planRun } from "../lib/planning/plan";
import type { PlanCandidate, PlannedRow } from "../lib/planning/types";
import { selectWritePath } from "../lib/planning/write-path";
import { executeSync, type AdminClient } from "../lib/execution/sync-executor";
import { RateLimitBudget } from "../lib/shopify/budget";
import { astToWhere, type FilterAst } from "./segments.server";

export interface CampaignInput {
  name: string;
  ast: FilterAst;
  rule: AdjustmentRule;
  compareAtPolicy: CompareAtPolicy;
  rounding: "none" | "charm99";
  guardrails?: Guardrails;
  priority?: number;
}

export async function createCampaign(shopId: string, input: CampaignInput) {
  return prisma.campaign.create({
    data: {
      shopId,
      name: input.name,
      status: "DRAFT",
      priority: input.priority ?? 100,
      ruleRows: [{ segmentIds: [], rule: input.rule }] as never,
      surfaces: { base: true } as never,
      compareAtPolicy: input.compareAtPolicy as never,
      compareAtViolationPolicy: "clear",
      guardrails: (input.guardrails ?? {}) as never,
      guardrailViolationPolicy: "clamp",
      schedule: { kind: "manual", rounding: input.rounding, ast: input.ast } as never,
    },
  });
}

function roundingFor(name: unknown): RoundingProfile {
  return name === "charm99" ? charm99 : NO_ROUNDING;
}

/** Rehydrates a stored campaign into the shape the pure resolver expects. */
function toResolvable(campaign: {
  id: string;
  priority: number;
  ruleRows: unknown;
  compareAtPolicy: unknown;
  guardrails: unknown;
  schedule: unknown;
  createdAt: Date;
}): ResolvableCampaign {
  const schedule = (campaign.schedule ?? {}) as { rounding?: string };
  return {
    id: campaign.id,
    priority: campaign.priority,
    startAt: campaign.createdAt.getTime(),
    ruleRows: campaign.ruleRows as ResolvableCampaign["ruleRows"],
    compareAtPolicy: campaign.compareAtPolicy as CompareAtPolicy,
    compareAtViolationPolicy: "clear",
    roundingProfile: roundingFor(schedule.rounding),
    guardrails: (campaign.guardrails ?? undefined) as Guardrails | undefined,
    guardrailViolationPolicy: "clamp",
  };
}

/** Loads baselines and live values for the campaign's scope. */
async function loadCandidates(shopId: string, ast: FilterAst): Promise<PlanCandidate[]> {
  const variants = await prisma.variantIndex.findMany({
    where: astToWhere(shopId, ast),
    select: { variantGid: true, currency: true, cost: true, productGid: true },
  });
  if (variants.length === 0) return [];

  const gids = variants.map((v) => v.variantGid);

  const [baselines, entries] = await Promise.all([
    prisma.baseline.findMany({
      where: { shopId, supersededAt: null, surfaceKind: "BASE", variantGid: { in: gids } },
    }),
    prisma.priceSurfaceEntry.findMany({
      where: { shopId, surfaceKind: "BASE", variantGid: { in: gids } },
    }),
  ]);

  const baselineBy = new Map(baselines.map((b) => [b.variantGid, b]));
  const entryBy = new Map(entries.map((e) => [e.variantGid, e]));

  const candidates: PlanCandidate[] = [];

  for (const variant of variants) {
    const baseline = baselineBy.get(variant.variantGid);
    // No baseline means nothing to compute from. Skipping is correct: pricing from
    // the live value is the compounding bug this product exists to prevent.
    if (!baseline) continue;

    const currency = baseline.currency || variant.currency || "USD";
    const entry = entryBy.get(variant.variantGid);

    const asMoney = (v: bigint | null | undefined): Money | undefined =>
      v === null || v === undefined ? undefined : money(Number(v), currency);

    const base: Baseline = {
      price: money(Number(baseline.basePrice), currency),
      compareAtPrice: asMoney(baseline.baseCompareAt),
      cost: asMoney(baseline.cost ?? variant.cost),
    };

    candidates.push({
      ref: {
        variantGid: variant.variantGid,
        surfaceKind: "base",
        priceListGid: "",
        currency,
      },
      baseline: base,
      livePrice: asMoney(entry?.livePrice),
      liveCompareAt: asMoney(entry?.liveCompareAt),
    });
  }

  return candidates;
}

export interface PreviewRow {
  variantGid: string;
  title: string;
  before: string | null;
  after: string | null;
  compareAt: string | null;
  status: PlannedRow["status"];
  reason?: string;
}

export interface CampaignPreview {
  campaignId: string;
  name: string;
  status: string;
  counts: { planned: number; noop: number; skipped: number; clamped: number };
  rows: PreviewRow[];
  blocked?: { reason: string; variantGid: string };
  writePath: string;
  writePathReason: string;
  /** Campaigns over this size need typed confirmation (A-3.11). */
  blastRadius: boolean;
}

const BLAST_RADIUS_THRESHOLD = 1_000;

/**
 * Computes what a campaign would do, without writing anything.
 *
 * Preview and execution share this planning call, so a preview cannot disagree with
 * what the run then does.
 */
export async function previewCampaign(
  shopId: string,
  campaignId: string,
  options: { revert?: boolean; limit?: number } = {},
): Promise<CampaignPreview> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
  });
  const schedule = (campaign.schedule ?? {}) as { ast?: FilterAst };
  const ast = schedule.ast ?? { groups: [] };

  const candidates = await loadCandidates(shopId, ast);

  // Other active campaigns take part in resolution, so overlap resolves the same way
  // it will at execution time rather than being previewed in isolation.
  const others = await prisma.campaign.findMany({
    where: { shopId, status: "ACTIVE", id: { not: campaignId } },
  });

  const resolvable = [toResolvable(campaign), ...others.map(toResolvable)];

  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails: {},
    excludeCampaignId: options.revert ? campaignId : undefined,
  });

  const titles = await prisma.variantIndex.findMany({
    where: { shopId, variantGid: { in: candidates.map((c) => c.ref.variantGid) } },
    select: { variantGid: true, title: true },
  });
  const titleBy = new Map(titles.map((t) => [t.variantGid, t.title ?? t.variantGid]));

  const fmt = (m?: Money | null) => (m ? formatMoneyLocal(m) : null);

  if (outcome.kind === "blocked") {
    return {
      campaignId,
      name: campaign.name,
      status: campaign.status,
      counts: outcome.counts,
      rows: [],
      blocked: { reason: outcome.reason, variantGid: outcome.ref.variantGid },
      writePath: "none",
      writePathReason: "Blocked before planning completed.",
      blastRadius: false,
    };
  }

  const decision = selectWritePath(outcome.rows.length);

  return {
    campaignId,
    name: campaign.name,
    status: campaign.status,
    counts: outcome.counts,
    rows: outcome.rows.slice(0, options.limit ?? 100).map((row) => ({
      variantGid: row.ref.variantGid,
      title: titleBy.get(row.ref.variantGid) ?? row.ref.variantGid,
      before: fmt(row.beforePrice),
      after: fmt(row.intendedPrice),
      compareAt: row.intendedCompareAtSet ? fmt(row.intendedCompareAt) : null,
      status: row.status,
      reason: row.reason,
    })),
    writePath: decision.path,
    writePathReason: decision.reason,
    blastRadius: outcome.counts.planned > BLAST_RADIUS_THRESHOLD,
  };
}

function formatMoneyLocal(m: Money): string {
  const exponent = ["JPY", "KRW"].includes(m.currency) ? 0 : 2;
  const digits = Math.abs(m.amount).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const sign = m.amount < 0 ? "-" : "";
  return exponent > 0
    ? `${sign}${whole}.${digits.slice(digits.length - exponent)}`
    : `${sign}${whole}`;
}

export interface RunOutcome {
  runId: string;
  planned: number;
  verified: number;
  failed: number;
  unverified: number;
  clean: boolean;
  messages: string[];
}

/**
 * Applies or reverts a campaign.
 *
 * Ledger rows are written **before** any API call (invariant I4). If this process
 * dies between the two, verification finds an unverified row and retries; the other
 * order would change a storefront with no record that we did it.
 */
export async function runCampaign(
  shopId: string,
  campaignId: string,
  client: AdminClient,
  options: { revert?: boolean } = {},
): Promise<RunOutcome> {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
  });
  const schedule = (campaign.schedule ?? {}) as { ast?: FilterAst };
  const ast = schedule.ast ?? { groups: [] };

  const candidates = await loadCandidates(shopId, ast);
  const others = await prisma.campaign.findMany({
    where: { shopId, status: "ACTIVE", id: { not: campaignId } },
  });

  const outcome = planRun({
    campaigns: [toResolvable(campaign), ...others.map(toResolvable)],
    candidates,
    storeGuardrails: {},
    excludeCampaignId: options.revert ? campaignId : undefined,
  });

  if (outcome.kind === "blocked") {
    throw new Error(
      `Campaign blocked by a guardrail on ${outcome.ref.variantGid}: ${outcome.reason}`,
    );
  }

  const kind = options.revert ? "REVERT" : "APPLY";

  const run = await prisma.campaignRun.create({
    data: {
      shopId,
      campaignId,
      kind,
      status: "EXECUTING",
      occurrenceKey: `${kind}-${Date.now()}`,
      plannedRows: outcome.counts.planned,
      startedAt: new Date(),
    },
  });

  // Write-ahead: ledger first, API second.
  const writable = outcome.rows.filter((r) => r.status !== "skipped");
  if (writable.length > 0) {
    await prisma.variantChange.createMany({
      data: writable.map((row) => ({
        runId: run.id,
        shopId,
        variantGid: row.ref.variantGid,
        surfaceKind: "BASE" as const,
        priceListGid: "",
        currency: row.ref.currency,
        beforePrice: row.beforePrice ? BigInt(row.beforePrice.amount) : null,
        beforeCompareAt: row.beforeCompareAt ? BigInt(row.beforeCompareAt.amount) : null,
        intendedPrice: row.intendedPrice ? BigInt(row.intendedPrice.amount) : null,
        intendedCompareAt: row.intendedCompareAt
          ? BigInt(row.intendedCompareAt.amount)
          : null,
        intendedCompareAtSet: row.intendedCompareAtSet,
        status: "PENDING" as const,
      })),
      skipDuplicates: true,
    });
  }

  const productOfMap = new Map(
    (
      await prisma.variantIndex.findMany({
        where: { shopId, variantGid: { in: writable.map((r) => r.ref.variantGid) } },
        select: { variantGid: true, productGid: true },
      })
    ).map((v) => [v.variantGid, v.productGid]),
  );

  const result = await executeSync(outcome.rows, {
    client,
    budget: new RateLimitBudget(),
    productOf: (gid) => productOfMap.get(gid) ?? gid,
    verifySampleRate: 1, // small dev catalogues: verify everything
  });

  const messages: string[] = [];
  for (const executed of result.rows) {
    const status =
      executed.status === "verified"
        ? "VERIFIED"
        : executed.status === "failed"
          ? "FAILED"
          : "APPLIED";
    await prisma.variantChange.updateMany({
      where: { runId: run.id, variantGid: executed.row.ref.variantGid },
      data: {
        status,
        failureReason: executed.failureReason ?? null,
        appliedAt: status !== "FAILED" ? new Date() : null,
        verifiedAt: status === "VERIFIED" ? new Date() : null,
      },
    });
    if (executed.failureReason) messages.push(executed.failureReason);
  }

  await prisma.campaignRun.update({
    where: { id: run.id },
    data: {
      status: result.clean ? "COMPLETED" : "PARTIAL",
      verifiedRows: result.verified,
      failedRows: result.failed,
      skippedRows: outcome.counts.skipped,
      finishedAt: new Date(),
    },
  });

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: options.revert ? "COMPLETED" : result.clean ? "ACTIVE" : "PARTIAL" },
  });

  // Refresh the mirror for what we just changed, so the dashboard's "not at
  // baseline" counts are immediately truthful rather than waiting for a re-sync.
  for (const executed of result.rows) {
    if (executed.status === "failed" || !executed.row.intendedPrice) continue;
    await prisma.priceSurfaceEntry.updateMany({
      where: {
        shopId,
        variantGid: executed.row.ref.variantGid,
        surfaceKind: "BASE",
        priceListGid: "",
      },
      data: {
        livePrice: BigInt(executed.row.intendedPrice.amount),
        ...(executed.row.intendedCompareAtSet
          ? {
              liveCompareAt: executed.row.intendedCompareAt
                ? BigInt(executed.row.intendedCompareAt.amount)
                : null,
            }
          : {}),
        syncedAt: new Date(),
      },
    });
  }

  return {
    runId: run.id,
    planned: outcome.counts.planned,
    verified: result.verified,
    failed: result.failed,
    unverified: result.unverified,
    clean: result.clean,
    messages: messages.slice(0, 5),
  };
}
