/**
 * Noticing that a merchant's markets changed, and asking rather than failing.
 *
 * Edge case E15. Markets, catalogues and price lists are edited while campaigns are
 * running. Left undetected, the failure arrives mid-run as a Shopify error about a
 * price list that does not exist — which tells the merchant nothing about which sale is
 * now wrong, or what to do.
 *
 * Detected, it becomes a question with an answer: extend this campaign to the new
 * market, or leave it. The question outlives the sync that found it, because a merchant
 * is rarely watching when a background poll runs.
 *
 * Deliberately *not* automatic in either direction. A new market is not joined to a
 * running campaign, because which countries see a sale is a commercial decision rather
 * than a mechanical one. A deleted market is not removed from a campaign either, since
 * merchants delete markets by accident and a campaign silently rewritten cannot be
 * un-rewritten.
 */

import prisma from "../db.server";
import { logger } from "../lib/logging/logger";
import {
  describeChange,
  diffTopology,
  needsDecision,
  type MarketSnapshot,
  type TopologyChange,
} from "../lib/markets/topology";
import { parseSurfaces } from "./campaigns/market-surfaces.server";

/** The mirror as it stands, in the shape the differ wants. */
export async function currentTopology(shopId: string): Promise<MarketSnapshot[]> {
  const lists = await prisma.priceListRecord.findMany({
    where: { shopId },
    select: {
      priceListGid: true,
      name: true,
      currency: true,
      adjustmentBps: true,
      surfaceKind: true,
    },
  });

  return lists.map((list) => ({
    priceListGid: list.priceListGid,
    name: list.name,
    currency: list.currency,
    adjustmentBps: list.adjustmentBps,
    surfaceKind: list.surfaceKind === "B2B" ? "B2B" : "MARKET",
  }));
}

export interface TopologyResult {
  changes: TopologyChange[];
  /** Changes raised as questions the merchant has not answered. */
  raised: number;
}

/**
 * Records what changed between two topologies.
 *
 * Every change goes to the audit log, including the benign ones — "when did this market
 * change currency" is exactly the question asked after a price looks wrong, and it is
 * unanswerable if only the alarming changes were written down. Only the changes that
 * alter what a campaign will do become questions.
 */
export async function recordTopologyChanges(
  shopId: string,
  before: readonly MarketSnapshot[],
  after: readonly MarketSnapshot[],
): Promise<TopologyResult> {
  const changes = diffTopology(before, after);
  if (changes.length === 0) return { changes, raised: 0 };

  const targeting = await campaignsByPriceList(shopId);
  // Campaigns a *new* market could be offered to. By definition nothing targets it yet,
  // so "which campaigns are affected" has to mean something else: the ones that already
  // price into at least one market. A base-only campaign was deliberately base-only,
  // and offering it a market it never asked for is noise.
  const multiMarket = [...new Set([...targeting.values()].flat().map((c) => c.id))]
    .map((id) => [...targeting.values()].flat().find((c) => c.id === id)!)
    .sort((a, b) => a.name.localeCompare(b.name));

  let raised = 0;

  for (const change of changes) {
    const campaigns =
      change.kind === "added" ? multiMarket : (targeting.get(change.priceListGid) ?? []);
    const detail = describeChange(
      change,
      campaigns.map((campaign) => campaign.name),
    );

    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: null,
        action: `market.${change.kind}`,
        entity: "priceList",
        entityId: change.priceListGid,
        before: (change.before ?? {}) as never,
        after: (change.after ?? {}) as never,
      },
    });

    if (!needsDecision(change)) continue;

    // A new market with no campaign pointed at it is worth logging but not worth
    // interrupting anybody about. There is nothing to decide until a campaign exists
    // that could reach it.
    if (change.kind === "added" && campaigns.length === 0) continue;

    // One open notice per market per kind, so a poll every fifteen minutes does not
    // stack up ninety-six copies of "this market is gone" by morning. Updated rather
    // than skipped, because the set of affected campaigns can grow between polls.
    const existing = await prisma.topologyNotice.findFirst({
      where: { shopId, priceListGid: change.priceListGid, kind: change.kind, resolvedAt: null },
      select: { id: true },
    });

    if (existing) {
      await prisma.topologyNotice.update({
        where: { id: existing.id },
        data: { detail, campaignIds: campaigns.map((campaign) => campaign.id) },
      });
    } else {
      await prisma.topologyNotice.create({
        data: {
          shopId,
          kind: change.kind,
          priceListGid: change.priceListGid,
          name: change.name,
          detail,
          campaignIds: campaigns.map((campaign) => campaign.id),
        },
      });
      raised += 1;
    }
  }

  logger.info("market topology changed", {
    shopId,
    changes: changes.length,
    raised,
    kinds: [...new Set(changes.map((change) => change.kind))],
  });

  return { changes, raised };
}

/** Open questions for this shop, newest first. */
export async function openNotices(shopId: string) {
  return prisma.topologyNotice.findMany({
    where: { shopId, resolvedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

export type NoticeResolution = "extended" | "ignored" | "removed";

/**
 * Answers one question.
 *
 * "Extend" adds the market to every campaign the notice names; "remove" takes it out of
 * them; "ignore" simply records that the merchant looked and chose to leave things as
 * they are. All three are resolutions — the notice is kept rather than deleted, so the
 * next poll does not raise a question that has already been answered.
 */
export async function resolveNotice(
  shopId: string,
  noticeId: string,
  resolution: NoticeResolution,
): Promise<void> {
  const notice = await prisma.topologyNotice.findFirst({
    where: { id: noticeId, shopId },
  });
  if (!notice || notice.resolvedAt) return;

  if (resolution !== "ignored") {
    for (const campaignId of notice.campaignIds) {
      const campaign = await prisma.campaign.findFirst({
        where: { id: campaignId, shopId },
        select: { surfaces: true },
      });
      if (!campaign) continue;

      const surfaces = parseSurfaces(campaign.surfaces);
      const priceLists =
        resolution === "extended"
          ? [...new Set([...surfaces.priceLists, notice.priceListGid])]
          : surfaces.priceLists.filter((gid) => gid !== notice.priceListGid);

      await prisma.campaign.update({
        where: { id: campaignId },
        data: { surfaces: { ...surfaces, priceLists } as never },
      });
    }
  }

  await prisma.topologyNotice.update({
    where: { id: noticeId },
    data: { resolvedAt: new Date(), resolution },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      action: "market.notice-resolved",
      entity: "priceList",
      entityId: notice.priceListGid,
      after: { kind: notice.kind, resolution, campaigns: notice.campaignIds.length } as never,
    },
  });
}

/** Which campaigns target each price list. */
async function campaignsByPriceList(shopId: string) {
  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: ["DRAFT", "SCHEDULED", "ACTIVE", "APPLYING", "PARTIAL"] } },
    select: { id: true, name: true, surfaces: true },
  });

  const byList = new Map<string, Array<{ id: string; name: string }>>();

  for (const campaign of campaigns) {
    for (const gid of parseSurfaces(campaign.surfaces).priceLists) {
      const existing = byList.get(gid) ?? [];
      existing.push({ id: campaign.id, name: campaign.name });
      byList.set(gid, existing);
    }
  }

  return byList;
}
