/**
 * What a campaign would do, before it exists.
 *
 * The editor could previously only tell a merchant how many variants matched, and show
 * five of their names. To see what happened to a *price* you had to click "Create and
 * preview", which creates the campaign — so the only way to find out what a rule does
 * was to commit to it. Competitors show a live before/after while you type, and the
 * absence of one here read as the app being unable to say.
 *
 * It can say. `resolve()` runs in preview and execution alike (rule 4), so this is not
 * an approximation of what will happen — it is the same computation, against the same
 * baselines, through the same planner. That is a stronger claim than a competitor
 * pricing off live values can make, and it was going unmade.
 *
 * The draft takes part in resolution alongside the shop's other ACTIVE campaigns rather
 * than being planned in isolation, because a variant already on sale is exactly where a
 * naive preview would lie: it would show a discount off the full price while the run
 * would resolve the overlap by priority and do something else.
 */

import { format } from "../../lib/money/format";
import type { Money } from "../../lib/money/money";
import { planRun } from "../../lib/planning/plan";
import { loadCandidates, titleMapFor } from "./candidates.server";
import { importIdsOf, toResolvable } from "./model.server";
import { guardrailsFor, readSettings } from "../settings.server";
import { skipReasonForRow } from "../../lib/planning/reasons";
import { resolvePolicy } from "../../lib/money/rounding-policy";
import type { FilterAst } from "../segments.server";
import type {
  AdjustmentRule,
  CompareAtPolicy,
  GuardrailViolationPolicy,
  ResolvableCampaign,
} from "../../lib/pricing/types";
import type { StoredRoundingPolicy } from "../../lib/money/rounding-policy";
import prisma from "../../db.server";

/** Just enough of a campaign to price with. Everything else is irrelevant to the maths. */
export interface DraftCampaign {
  ast: FilterAst;
  rule: AdjustmentRule;
  compareAtPolicy: CompareAtPolicy;
  rounding: StoredRoundingPolicy;
  priority: number;
}

export interface DraftPreviewRow {
  variantGid: string;
  title: string;
  before: string | null;
  after: string | null;
  beforeCompareAt: string | null;
  afterCompareAt: string | null;
  /** True when the price does not move — already at the campaign price. */
  unchanged: boolean;
  /** Why this row will not be written, if it will not be. */
  skippedReason: string | null;
}

export interface DraftPreview {
  /** Variants the scope matches, whether or not their price moves. */
  matched: number;
  /** Rows whose price this campaign would change. */
  changing: number;
  /** Rows already at the price this campaign wants. */
  alreadyCorrect: number;
  /** Rows deliberately not written, with reasons on the rows themselves. */
  skipped: number;
  /** Rows with no baseline, which cannot be priced at all. */
  withoutBaseline: number;
  rows: DraftPreviewRow[];
  /**
   * A guardrail that stops the whole run, surfaced here rather than on submit.
   *
   * `planRun` returning `blocked` throws inside `runCampaign`, so before this existed a
   * merchant met their own floor as a crash after committing rather than as a sentence
   * while editing.
   */
  blocked: { reason: string; variantGid: string } | null;
}

const EMPTY: DraftPreview = {
  matched: 0,
  changing: 0,
  alreadyCorrect: 0,
  skipped: 0,
  withoutBaseline: 0,
  rows: [],
  blocked: null,
};

/**
 * The draft as the resolver sees it.
 *
 * `guardrailViolationPolicy` is read from the shop rather than hardcoded, because a
 * campaign created a moment from now copies the shop's setting (#338) -- and a preview
 * that clamped while the campaign it is previewing would block is a preview that
 * disagrees with execution, which is the one thing rule 4 forbids. Hardcoding "clamp"
 * here would have been #338 reintroduced in the one place built to prove it cannot
 * happen.
 */
function draftAsResolvable(
  draft: DraftCampaign,
  violationPolicy: GuardrailViolationPolicy,
): ResolvableCampaign {
  return {
    id: DRAFT_ID,
    priority: draft.priority,
    // Newest, so that at equal priority the draft wins the tie and the merchant sees
    // what their new campaign does rather than what the existing one already did.
    startAt: Number.MAX_SAFE_INTEGER,
    ruleRows: [{ segmentIds: [], rule: draft.rule }],
    compareAtPolicy: draft.compareAtPolicy,
    compareAtViolationPolicy: "clear",
    roundingPolicy: resolvePolicy(draft.rounding),
    guardrails: undefined,
    guardrailViolationPolicy: violationPolicy,
    excludedVariantGids: [],
  };
}

/** Not a real id, and never persisted — it only has to be distinct from a cuid. */
const DRAFT_ID = "draft";

export async function previewDraft(
  shopId: string,
  draft: DraftCampaign,
  limit = 25,
): Promise<DraftPreview> {
  const [others, settings] = await Promise.all([
    prisma.campaign.findMany({ where: { shopId, status: "ACTIVE" } }),
    readSettings(shopId),
  ]);
  const resolvable = [
    draftAsResolvable(draft, settings.violationPolicy),
    ...others.map(toResolvable),
  ];

  const [candidates, storeGuardrails, matched] = await Promise.all([
    loadCandidates(shopId, draft.ast, undefined, importIdsOf(resolvable)),
    guardrailsFor(shopId),
    countMatching(shopId, draft.ast),
  ]);

  if (candidates.length === 0) {
    // Matched but unpriceable: every variant in scope is missing a baseline. Reported
    // rather than shown as "0 variants match", which would send the merchant to fix
    // their filter when the filter is fine.
    return { ...EMPTY, matched, withoutBaseline: matched };
  }

  const outcome = planRun({ campaigns: resolvable, candidates, storeGuardrails });

  if (outcome.kind === "blocked") {
    return {
      ...EMPTY,
      matched,
      withoutBaseline: matched - candidates.length,
      blocked: { reason: outcome.reason, variantGid: outcome.ref.variantGid },
    };
  }

  // Only what this draft controls. A variant a higher-priority campaign already owns is
  // in scope and is not this campaign's to change, and counting it as "changing" would
  // promise a price the run will not write.
  const ours = outcome.rows.filter((row) => row.campaignId === DRAFT_ID);

  const changing = ours.filter((row) => row.status !== "skipped" && !isNoop(row));
  const alreadyCorrect = ours.filter((row) => row.status !== "skipped" && isNoop(row));
  const skipped = ours.filter((row) => row.status === "skipped");

  const shown = [...changing, ...alreadyCorrect, ...skipped].slice(0, limit);
  const titles = await titleMapFor(shopId, shown.map((row) => row.ref.variantGid));

  const fmt = (value?: Money | null) => (value ? format(value) : null);

  return {
    matched,
    changing: changing.length,
    alreadyCorrect: alreadyCorrect.length,
    skipped: skipped.length,
    withoutBaseline: matched - candidates.length,
    blocked: null,
    rows: shown.map((row) => ({
      variantGid: row.ref.variantGid,
      title: titles.get(row.ref.variantGid) ?? row.ref.variantGid,
      before: fmt(row.beforePrice),
      after: fmt(row.intendedPrice),
      beforeCompareAt: fmt(row.beforeCompareAt),
      afterCompareAt: fmt(row.intendedCompareAt),
      unchanged: isNoop(row),
      skippedReason: row.status === "skipped" ? skipReasonForRow(row.reason) : null,
    })),
  };
}

/** A row whose price does not move. */
function isNoop(row: { beforePrice?: Money | null; intendedPrice?: Money | null }): boolean {
  // An absent live price is never "already correct" -- we do not know what is there, and
  // treating unknown as correct is how a variant silently keeps a stale price.
  if (!row.beforePrice || !row.intendedPrice) return false;
  return row.beforePrice.amount === row.intendedPrice.amount;
}

async function countMatching(shopId: string, ast: FilterAst): Promise<number> {
  const { astToWhere } = await import("../segments.server");
  return prisma.variantIndex.count({ where: astToWhere(shopId, ast) });
}
