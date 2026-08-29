/**
 * Campaign persistence and rehydration.
 *
 * The stored row keeps its rule, policies and schedule as JSON so the shape can
 * evolve without a migration; `toResolvable` turns that back into the typed input
 * the pure resolver expects. Keeping the conversion in one place means the resolver
 * never sees a loosely-typed database row.
 */

import type { Campaign } from "@prisma/client";

import prisma from "../../db.server";
import {
  parseRoundingPolicy,
  resolvePolicy,
  type RoundingPolicy,
} from "../../lib/money/rounding-policy";
import type { AdjustmentRule,
  CompareAtPolicy,
  GuardrailViolationPolicy,
  Guardrails,
  ResolvableCampaign,
} from "../../lib/pricing/types";
import { segmentToAst, type FilterAst } from "../segments.server";
import { readSettings } from "../settings.server";
import type { CampaignInput } from "./types";

/**
 * Narrows a stored policy string to the union the resolver expects.
 *
 * The column is a plain `String` with a `"clamp"` default, so anything could be in it
 * -- an older row, a hand-edited record, a value from a future version rolled back.
 * Unknown values fall back to `clamp` rather than throwing: refusing to resolve a
 * campaign because its policy string is unfamiliar would take a merchant's live prices
 * out of our reach entirely, and clamp is the option that keeps a price valid.
 */
function asViolationPolicy(stored: string): GuardrailViolationPolicy {
  return stored === "skip" || stored === "block" ? stored : "clamp";
}

/** The shop's floor-violation setting, for a campaign being created now. */
async function violationPolicyFor(shopId: string): Promise<GuardrailViolationPolicy> {
  const settings = await readSettings(shopId);
  return settings.violationPolicy;
}

export async function createCampaign(shopId: string, input: CampaignInput) {
  return prisma.campaign.create({
    data: {
      shopId,
      name: input.name,
      status: input.schedule?.kind === "window" ? "SCHEDULED" : "DRAFT",
      priority: input.priority ?? 100,
      autoEnroll: input.autoEnroll ?? true,
      tagKit: input.tagKit ?? [],
      ruleRows: [{ segmentIds: [], rule: input.rule }] as never,
      surfaces: { base: true, priceLists: input.priceLists ?? [] } as never,
      compareAtPolicy: input.compareAtPolicy as never,
      compareAtViolationPolicy: "clear",
      guardrails: (input.guardrails ?? {}) as never,
      // The shop's answer to "when a price would breach a floor", not a literal.
      // It was hardcoded here and again in `toResolvable`, so the setting the merchant
      // picked -- including "leave those variants alone" and "refuse the run" -- was
      // silently replaced by "write the floor price anyway" (#338).
      //
      // Copied onto the campaign rather than read live at resolution time, so changing
      // the store default does not retroactively change what a running campaign does
      // to prices already on a storefront.
      guardrailViolationPolicy: await violationPolicyFor(shopId),
      // Rounding and scope ride along in the schedule blob so the shape can evolve
      // without a migration; parseSchedule ignores the extra keys.
      schedule: {
        ...(input.schedule ?? { kind: "manual" }),
        rounding: input.rounding,
        ast: input.ast,
        ...(input.segmentId ? { segmentId: input.segmentId } : {}),
        ...(input.practice ? { practice: true } : {}),
      } as never,
      // The declarative reference as well as the id in the blob. The rule engine reads
      // the blob; the delete guard reads the relation, and a segment that could be
      // deleted out from under a running campaign is the failure that matters.
      ...(input.segmentId ? { segments: { connect: { id: input.segmentId } } } : {}),
      ...(input.schedule?.kind === "window"
        ? {
            startAt: new Date(input.schedule.startAt),
            endAt: input.schedule.endAt ? new Date(input.schedule.endAt) : null,
          }
        : {}),
    },
  });
}

/**
 * A campaign's rounding policy as stored.
 *
 * Kept here rather than inlined so every reader -- resolver, preview, run report and
 * the wizard -- agrees about what an old campaign's bare `"charm99"` string means.
 */
export function roundingFor(raw: unknown): RoundingPolicy {
  return resolvePolicy(parseRoundingPolicy(raw));
}

/**
 * A campaign's rule, for anything that wants to describe rather than resolve it.
 *
 * `ruleRows` is a list because several rules can match a variant with the last winning
 * (E16), and nothing in the app creates more than one today. This reads the first, which
 * is the whole rule for every campaign that exists — and returns null rather than
 * pretending, so a multi-row campaign is described as having no single rule instead of
 * being described by an arbitrary one of them.
 */
export function ruleOf(campaign: Pick<Campaign, "ruleRows">): AdjustmentRule | null {
  const rows = (campaign.ruleRows ?? []) as unknown as Array<{ rule?: AdjustmentRule }>;
  if (rows.length !== 1) return null;
  return rows[0]?.rule ?? null;
}

/** The filter that defines a campaign's scope, or an empty AST matching everything. */
export function astOf(campaign: Pick<Campaign, "schedule">): FilterAst {
  const schedule = (campaign.schedule ?? {}) as { ast?: FilterAst };
  return schedule.ast ?? { groups: [] };
}

/**
 * Whether this campaign is practice.
 *
 * A practice campaign exists to be previewed and never applied. It is how a merchant
 * with fifty thousand products builds confidence before touching a live price, which is
 * exactly the merchant most worth converting — and the promise is only worth anything
 * if it is impossible to break by accident.
 */
export function isPractice(campaign: Pick<Campaign, "schedule">): boolean {
  const schedule = (campaign.schedule ?? {}) as { practice?: boolean };
  return schedule.practice === true;
}

/** The segment a campaign targets, if it targets one rather than an inline filter. */
export function segmentIdOf(campaign: Pick<Campaign, "schedule">): string | null {
  const schedule = (campaign.schedule ?? {}) as { segmentId?: string };
  return schedule.segmentId ?? null;
}

/**
 * The scope a campaign actually runs against.
 *
 * Resolved rather than copied. A campaign that had its segment's filter written into
 * it at creation would keep pricing the old products after the segment was edited,
 * which would make "reusable" a lie -- the merchant fixes the segment once and expects
 * every campaign using it to follow.
 *
 * A segment that has since been deleted falls back to the campaign's own stored
 * filter. The reference guard makes that nearly unreachable, but "nearly" is not a
 * basis for letting an empty AST through here: an empty AST matches the whole
 * catalogue, so the failure mode would be repricing every product in the store.
 */
export async function scopeOf(
  shopId: string,
  campaign: Pick<Campaign, "schedule">,
): Promise<FilterAst> {
  const segmentId = segmentIdOf(campaign);
  if (!segmentId) return astOf(campaign);

  const segment = await prisma.segment.findFirst({
    where: { id: segmentId, shopId },
    select: { kind: true, filterAst: true, frozenVariantGids: true },
  });
  if (!segment) return astOf(campaign);

  return segmentToAst({
    kind: segment.kind as "DYNAMIC" | "FROZEN",
    filterAst: segment.filterAst,
    frozenVariantGids: segment.frozenVariantGids,
  });
}

/** Rehydrates a stored campaign into the shape the pure resolver expects. */
export function toResolvable(
  campaign: Pick<
    Campaign,
    | "id"
    | "priority"
    | "ruleRows"
    | "compareAtPolicy"
    | "guardrails"
    | "guardrailViolationPolicy"
    | "schedule"
    | "createdAt"
    | "excludedVariantGids"
  >,
): ResolvableCampaign {
  const schedule = (campaign.schedule ?? {}) as { rounding?: string };

  return {
    id: campaign.id,
    priority: campaign.priority,
    // createdAt stands in for startAt until scheduling lands (P3.9); it keeps the
    // winner ordering total and stable in the meantime.
    startAt: campaign.createdAt.getTime(),
    // Stored as JSON, so the cast has to route through `unknown`: Prisma's
    // JsonValue and RuleRow[] do not overlap structurally.
    ruleRows: campaign.ruleRows as unknown as ResolvableCampaign["ruleRows"],
    compareAtPolicy: campaign.compareAtPolicy as unknown as CompareAtPolicy,
    compareAtViolationPolicy: "clear",
    roundingPolicy: roundingFor(schedule.rounding),
    guardrails: (campaign.guardrails ?? undefined) as unknown as Guardrails | undefined,
    // Read from the campaign, not hardcoded. See #338: every layer below this
    // implemented `skip` and `block` correctly and none of them could ever be reached,
    // because this line threw the answer away.
    guardrailViolationPolicy: asViolationPolicy(campaign.guardrailViolationPolicy),
    // Variants reverted out of this campaign individually. Carried into resolution
    // rather than filtered out beforehand, so an excluded variant falls through to
    // whatever else still controls it instead of jumping to full price.
    excludedVariantGids: campaign.excludedVariantGids,
  };
}

/**
 * Loads a campaign plus the other ACTIVE campaigns on the shop.
 *
 * The others take part in resolution so overlap resolves the same way it will at
 * execution time, rather than being previewed in isolation.
 */
export async function loadCampaignContext(shopId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
  });

  const others = await prisma.campaign.findMany({
    where: { shopId, status: "ACTIVE", id: { not: campaignId } },
  });

  return {
    campaign,
    resolvable: [toResolvable(campaign), ...others.map(toResolvable)],
    ast: await scopeOf(shopId, campaign),
  };
}


/**
 * Import ids any of these campaigns price from.
 *
 * Collected from the rules rather than stored separately, so a campaign whose rule
 * changes cannot end up loading prices for an import it no longer uses — or, worse,
 * failing to load the one it now does.
 */
export function importIdsOf(campaigns: readonly ResolvableCampaign[]): string[] {
  const ids = new Set<string>();

  for (const campaign of campaigns) {
    for (const row of campaign.ruleRows) {
      if (row.rule.kind === "from-import") ids.add(row.rule.importId);
    }
  }

  return [...ids];
}
