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
import type { FilterAst } from "../segments.server";
import type { CampaignInput } from "./types";

export async function createCampaign(shopId: string, input: CampaignInput) {
  return prisma.campaign.create({
    data: {
      shopId,
      name: input.name,
      status: input.schedule?.kind === "window" ? "SCHEDULED" : "DRAFT",
      priority: input.priority ?? 100,
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
      } as never,
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

/** Rehydrates a stored campaign into the shape the pure resolver expects. */
export function toResolvable(
  campaign: Pick<
    Campaign,
    "id" | "priority" | "ruleRows" | "compareAtPolicy" | "guardrails" | "schedule" | "createdAt"
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
    ast: astOf(campaign),
  };
}
