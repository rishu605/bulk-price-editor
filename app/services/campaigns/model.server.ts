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
import { charm99, NO_ROUNDING, type RoundingProfile } from "../../lib/money/rounding";
import type {
  CompareAtPolicy,
  Guardrails,
  ResolvableCampaign,
} from "../../lib/pricing/types";
import { segmentToAst, type FilterAst } from "../segments.server";
import type { CampaignInput } from "./types";

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
      surfaces: { base: true } as never,
      compareAtPolicy: input.compareAtPolicy as never,
      compareAtViolationPolicy: "clear",
      guardrails: (input.guardrails ?? {}) as never,
      guardrailViolationPolicy: "clamp",
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

export function roundingFor(name: unknown): RoundingProfile {
  return name === "charm99" ? charm99 : NO_ROUNDING;
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
    roundingProfile: roundingFor(schedule.rounding),
    guardrails: (campaign.guardrails ?? undefined) as unknown as Guardrails | undefined,
    guardrailViolationPolicy: "clamp",
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
