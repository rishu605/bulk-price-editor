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
import { loadCandidates, variantDisplayFor } from "./candidates.server";
import { importIdsOf, toResolvable } from "./model.server";
import { guardrailsFor, readSettings } from "../settings.server";
import { skipReasonForRow } from "../../lib/planning/reasons";
import { liveIfDrifted } from "../../lib/pricing/drift-note";
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
  /** Null is ordinary — a product without a photo is normal, not a failure. */
  imageUrl: string | null;
  /**
   * The price this campaign's arithmetic starts from.
   *
   * Not the live price, and the distinction is the product. Every competitor computes a
   * relative change against whatever is on the storefront right now, which is why
   * RUBIX's own FAQ has to explain that a 30% sale followed by a 50% sale leaves the
   * product at 35% of its original price for ever. `before` is the baseline, so the
   * preview shows what the run will actually do.
   */
  before: string | null;
  after: string | null;
  beforeCompareAt: string | null;
  afterCompareAt: string | null;
  /**
   * What the storefront says today, when that is not the baseline.
   *
   * Null when they agree, which is the ordinary case and needs no column. When they
   * disagree the variant is either mid-campaign or has drifted, and a merchant reading
   * "was 40.00, becomes 32.00" beside a storefront showing 28.00 needs to be told which
   * number the app is working from — not left to discover it after the run.
   */
  live: string | null;
  /** True when the price does not move — already at the campaign price. */
  unchanged: boolean;
  /** Why this row will not be written, if it will not be. */
  skippedReason: string | null;
}

/**
 * A campaign already running over some of the variants this draft would price.
 *
 * The thing no competitor can say. All three compute against the live price and none of
 * them resolves overlap: RUBIX puts a warning in its editor telling merchants not to
 * create a second task over the same products, and its FAQ explains with worked numbers
 * that reverting out of order leaves a product wrong for ever. NA and Sami do the same
 * thing and say nothing at all.
 *
 * We resolve it, by priority, and a revert recomputes rather than restoring — so the
 * honest thing is not a warning but a statement of what will happen.
 */
export interface DraftOverlap {
  campaignId: string;
  name: string;
  /** Variants in this draft's scope that the other campaign currently prices. */
  variants: number;
  /** True when the other campaign keeps those variants — it outranks the draft. */
  keepsThem: boolean;
  priority: number;
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
   * Campaigns already pricing variants in this scope, biggest first.
   *
   * Empty is the ordinary case and renders nothing — a panel saying "overlaps: none" on
   * every draft is a panel that stops being read before the one that matters.
   */
  overlaps: DraftOverlap[];
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
  overlaps: [],
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

  // And the ones it does not control, which are the interesting half.
  //
  // These fall out of the same `planRun` that produced the draft's own rows, so they are
  // the resolver's answer rather than a second opinion assembled from a query. A campaign
  // in this list is one the merchant is about to write over, or one that is about to
  // write over them — and which of the two is a fact we can state.
  const overlaps = overlapsFrom(outcome.rows, others, draft.priority);

  const changing = ours.filter((row) => row.status !== "skipped" && !isNoop(row));
  const alreadyCorrect = ours.filter((row) => row.status !== "skipped" && isNoop(row));
  const skipped = ours.filter((row) => row.status === "skipped");

  const shown = [...changing, ...alreadyCorrect, ...skipped].slice(0, limit);
  const display = await variantDisplayFor(shopId, shown.map((row) => row.ref.variantGid));

  // The baseline lives on the candidate, not on the planned row — the planner carries
  // `beforePrice`, which is the *live* price. Both are wanted here: the campaign's
  // arithmetic starts from the baseline, and a merchant whose storefront disagrees with
  // it needs to be told rather than left to find out after the run.
  const baselines = new Map(
    candidates.map((candidate) => [candidate.ref.variantGid, candidate.baseline.price]),
  );

  const fmt = (value?: Money | null) => (value ? format(value) : null);

  return {
    matched,
    overlaps,
    changing: changing.length,
    alreadyCorrect: alreadyCorrect.length,
    skipped: skipped.length,
    withoutBaseline: matched - candidates.length,
    blocked: null,
    rows: shown.map((row) => {
      const baseline = baselines.get(row.ref.variantGid) ?? null;

      return {
      variantGid: row.ref.variantGid,
      title: display.get(row.ref.variantGid)?.title ?? row.ref.variantGid,
      imageUrl: display.get(row.ref.variantGid)?.imageUrl ?? null,
      before: fmt(baseline),
      live: fmt(liveIfDrifted(baseline, row.beforePrice)),
      after: fmt(row.intendedPrice),
      beforeCompareAt: fmt(row.beforeCompareAt),
      afterCompareAt: fmt(row.intendedCompareAt),
      unchanged: isNoop(row),
      skippedReason: row.status === "skipped" ? skipReasonForRow(row.reason) : null,
      };
    }),
  };
}

/**
 * Which existing campaigns share variants with this draft, and who keeps them.
 *
 * Counted from the planned rows rather than from the scopes: two campaigns whose filters
 * both say "Outerwear" may still not meet, because a third campaign outranks them both on
 * some of it. The resolver has already worked that out and the rows say who won.
 *
 * Sorted by size, because a merchant reading this wants the one that matters first, and a
 * campaign that owns four variants of three thousand is a footnote.
 */
export function overlapsFrom(
  rows: Array<{ campaignId?: string }>,
  others: Array<{ id: string; name: string; priority: number }>,
  draftPriority: number,
): DraftOverlap[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.campaignId || row.campaignId === DRAFT_ID) continue;
    counts.set(row.campaignId, (counts.get(row.campaignId) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([campaignId, variants]) => {
      const other = others.find((candidate) => candidate.id === campaignId);
      return {
        campaignId,
        name: other?.name ?? "Another campaign",
        variants,
        priority: other?.priority ?? 0,
        // A row the resolver gave to them is a row they keep — that *is* the answer, and
        // recomputing "who should win" from the priorities here would be a second
        // implementation free to disagree with the first.
        keepsThem: true,
      };
    })
    .filter((overlap) => overlap.variants > 0)
    .sort((a, b) => b.variants - a.variants);
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
