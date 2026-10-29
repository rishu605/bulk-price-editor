/**
 * Scoped recapture, with the checks the operation deserves.
 *
 * Recapture is the most destructive thing this app does. It replaces every baseline in
 * scope with today's live price, and a baseline is what every campaign computes from
 * forever after. Run it during a sale and the sale prices become the merchant's normal
 * prices — permanently.
 *
 * The dashboard used to offer this as a button with a paragraph of warning next to it.
 * That is not enough: the warning is generic, the scope is the whole store, and one
 * click does it. This scopes it, works out which running campaigns it would enshrine,
 * demands a typed confirmation when any do, and writes the whole thing to the audit log
 * with who asked for it.
 */

import prisma from "../db.server";
import { AppError } from "../lib/errors/app-error";
import type { AdminClient } from "../lib/execution/sync-executor";
import { countOf, formatCount } from "../lib/format/display";
import {
  assessRecapture,
  confirmationMatches,
  type ActiveOverlap,
  type RecaptureAssessment,
} from "../lib/baselines/recapture";
import { PRICES_MAY_BE_LIVE } from "../lib/lifecycle/transitions";
import { captureBaselines, type CaptureOptions } from "./baselines.server";
import { astToWhere, type FilterAst } from "./segments.server";
import { scopeOf } from "./campaigns/model.server";
import type { RecaptureScope } from "../lib/baselines/recapture-scope";
import { staleBaselineVariants } from "./reconciliation.server";

export type { RecaptureScope } from "../lib/baselines/recapture-scope";

/** A recapture worked out: the assessment the page shows, and the variants it rewrites. */
export type RecapturePlan = RecaptureAssessment & { variantGids: string[] };

/**
 * Works out what a recapture would do, without doing any of it.
 *
 * The same resolution the recapture itself uses, so the number the merchant confirms is
 * the number that gets rewritten.
 */
export async function planRecapture(shopId: string, scope: RecaptureScope = {}): Promise<RecapturePlan> {
  const variantGids = await resolveScope(shopId, scope);
  const overlaps = await activeOverlaps(shopId, variantGids);

  return { ...assessRecapture(variantGids.length, overlaps), variantGids };
}

export interface RecaptureOptions extends RecaptureScope {
  /** What the merchant typed. Checked against the phrase the assessment demanded. */
  confirmation?: string;
  actor?: string;
  /**
   * How many variants the page said this would rewrite, when there was a page (#716).
   *
   * The confirmation is only worth something if it confirms *this* recapture. A scope
   * that resolves to a different number now -- a segment edited, a sync in between, or a
   * form that posted a different scope from the one it showed -- is refused rather than
   * run on a count nobody saw.
   */
  expectedScope?: number;
  /**
   * The running campaigns the merchant confirmed this over, when it was confirmed before it
   * runs: a recapture the page handed to the worker (#1105). A campaign that has gone live on
   * the scope since is refused, as Flow's capture refuses one (#773). The typed phrase alone
   * would let it through -- it is the same words whichever campaigns it was typed over -- and
   * the merchant was never shown this one.
   */
  confirmedOver?: readonly string[];
  /**
   * Shopify, to read a wholesale price's quantity ladder with it. Without one a wholesale
   * price's baseline is left as it is: see `CaptureOptions.client` (#1071).
   */
  client?: AdminClient;
  /** How far the capture has got, for a page following it (#1105): see `CaptureOptions`. */
  onLadders?: CaptureOptions["onLadders"];
  onProgress?: CaptureOptions["onProgress"];
}

export async function recapture(shopId: string, options: RecaptureOptions = {}) {
  return recaptureChecked(shopId, await checkRecapture(shopId, options), options);
}

/**
 * The plan a recapture runs on, once it has passed every check its confirmation stands for,
 * or an `AppError` saying which it failed and nothing done.
 *
 * Its own step, because the page's request makes these checks before it hands a recapture to
 * the worker -- a typed phrase that does not match, a count nobody was shown, is refused
 * while the merchant is looking, not minutes later -- and the worker makes them again before
 * it writes, because the scope and the running campaigns may have moved in between (#1105).
 */
export async function checkRecapture(shopId: string, options: RecaptureOptions = {}): Promise<RecapturePlan> {
  const plan = await planRecapture(shopId, options);

  if (options.confirmedOver) {
    const confirmed = new Set(options.confirmedOver);
    const since = plan.overlaps.filter((overlap) => !confirmed.has(overlap.campaignId));
    if (since.length > 0) {
      const names = since.map((overlap) => `"${overlap.campaignName}" (${countOf(overlap.variants, "variant")})`).join(", ");
      throw new AppError({
        code: "VALIDATION",
        userMessage:
          `Nothing was recaptured: ${names} went live on this scope after you confirmed the recapture, and recapturing ` +
          `now would make ${since.length === 1 ? "its" : "their"} sale prices the normal ones. Check the scope again, ` +
          `and revert ${since.length === 1 ? "the campaign" : "the campaigns"} first unless that is what you want.`,
        context: { shopId, scope: plan.scope, since: since.map((overlap) => overlap.campaignId) },
      });
    }
  }

  if (!confirmationMatches(options.confirmation ?? "", plan.confirmationPhrase)) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        `${plan.warning ?? ""} Type “${plan.confirmationPhrase}” to confirm you want to do this anyway.`.trim(),
      context: { shopId, scope: plan.scope, overlaps: plan.overlaps.map((o) => o.campaignId) },
    });
  }

  if (options.expectedScope !== undefined && options.expectedScope !== plan.scope) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        `This scope is ${countOf(plan.scope, "variant")} now, not the ${formatCount(options.expectedScope)} you were shown, so nothing was recaptured. ` +
        "Check the scope again and read the new count before recapturing.",
      context: { shopId, scope: plan.scope, expected: options.expectedScope, segmentId: options.segmentId ?? null },
    });
  }

  if (plan.scope === 0) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        "That scope matches no variants, so there is nothing to recapture. Check the segment you picked.",
    });
  }

  return plan;
}

/** The recapture itself, on a plan `checkRecapture` passed, and its audit entry. */
export async function recaptureChecked(shopId: string, plan: RecapturePlan, options: RecaptureOptions = {}) {
  const result = await captureBaselines(shopId, {
    variantGids: plan.variantGids,
    // The flag that makes this a recapture rather than a no-op. `captureBaselines`
    // leaves existing baselines alone by default — it runs after every sync, and
    // silently re-anchoring to live prices each time would destroy the whole
    // guarantee. Replacing them is the entire point here, which is why every check in
    // `checkRecapture` exists.
    recapture: true,
    source: "RECAPTURE",
    capturedBy: options.actor,
    client: options.client,
    onLadders: options.onLadders,
    onProgress: options.onProgress,
  });

  // Written whatever the outcome, and written with the overlaps. Six weeks later the
  // question is not "did somebody recapture" but "did somebody recapture over a live
  // sale", and only this row can answer it.
  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: options.actor ?? null,
      action: "baselines.recapture",
      entity: "Shop",
      entityId: shopId,
      after: {
        scope: plan.scope,
        segmentId: options.segmentId ?? null,
        stale: options.stale === true,
        captured: result.captured,
        superseded: result.superseded,
        alreadyCurrent: result.alreadyCurrent,
        // Whether its wholesale prices came with it, ladders and all, or were left (#1092).
        wholesale: result.wholesale,
        wholesaleLeft: result.wholesaleLeft,
        overActiveCampaigns: plan.overlaps.map((o) => ({ id: o.campaignId, variants: o.variants })),
      },
    },
  });

  return { ...result, scope: plan.scope, overlaps: plan.overlaps };
}

async function resolveScope(shopId: string, scope: RecaptureScope): Promise<string[]> {
  if (scope.stale) return staleBaselineVariants(shopId);

  if (!scope.segmentId) {
    const all = await prisma.variantIndex.findMany({
      where: { shopId, deletedAt: null },
      select: { variantGid: true },
    });
    return all.map((row) => row.variantGid);
  }

  const segment = await prisma.segment.findFirst({
    where: { id: scope.segmentId, shopId },
    select: { kind: true, filterAst: true, frozenVariantGids: true },
  });
  if (!segment) {
    throw new AppError({
      code: "NOT_FOUND",
      userMessage: "That segment no longer exists. Pick another, or recapture the whole catalogue.",
    });
  }

  if (segment.kind === "FROZEN") return segment.frozenVariantGids;

  const rows = await prisma.variantIndex.findMany({
    where: astToWhere(shopId, astOf(segment.filterAst)),
    select: { variantGid: true },
  });
  return rows.map((row) => row.variantGid);
}

/**
 * Which running campaigns are currently pricing variants in the scope.
 *
 * Counted per campaign rather than as a total, because the merchant's decision is
 * usually "revert that one first" and that needs a name attached to a number.
 */
/** Prisma hands back JSON; the AST shape has to be asserted through `unknown`. */
function astOf(stored: unknown): FilterAst {
  const ast = stored as FilterAst | null;
  return ast && Array.isArray(ast.groups) ? ast : { groups: [] };
}

async function activeOverlaps(shopId: string, variantGids: string[]): Promise<ActiveOverlap[]> {
  if (variantGids.length === 0) return [];

  // Every state whose prices may be on the storefront, from the one definition of that
  // (#708). A hand-written list here left out HELD -- drift holds a campaign *with its
  // prices still live* -- so recapturing then read "safe" and made the sale permanent.
  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: [...PRICES_MAY_BE_LIVE] } },
    select: { id: true, name: true, schedule: true },
  });

  const inScope = new Set(variantGids);
  const overlaps: ActiveOverlap[] = [];

  for (const campaign of campaigns) {
    // The campaign's real scope, resolved the same way a run resolves it — so a
    // segment-targeted campaign is counted against its segment rather than against an
    // empty inline filter, which would match the whole catalogue.
    const ast = await scopeOf(shopId, campaign);
    const covered = await prisma.variantIndex.findMany({
      where: astToWhere(shopId, ast),
      select: { variantGid: true },
    });

    const variants = covered.filter((row) => inScope.has(row.variantGid)).length;
    overlaps.push({ campaignId: campaign.id, campaignName: campaign.name, variants });
  }

  return overlaps;
}
