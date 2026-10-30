/**
 * An all-variants campaign leaves draft and archived products out unless it opted in
 * (#751).
 *
 * A QA campaign scoped "Title contains Alpine Snowboard 0" repriced an archived product
 * and tagged it, and every scope -- "All variants" and Home's "Put everything on sale"
 * included -- covered ACTIVE, DRAFT and ARCHIVED alike, because nothing said otherwise.
 *
 * What is pinned here is the contract between the halves: what `createCampaign` records,
 * what `astOf` and `scopeOf` read back, and what `astToWhere` turns that into. Each half
 * on its own can look right while the pair prices the archive; the chaos scenario
 * `product-status` runs the same claim through the real engine against a real database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    campaign: { create: vi.fn(), findFirstOrThrow: vi.fn(), findMany: vi.fn() },
    segment: { findFirst: vi.fn() },
    auditLogEntry: { create: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prisma }));
vi.mock("../settings.server", () => ({
  readSettings: vi.fn(async () => ({ violationPolicy: "clamp" })),
}));

import { EVERY_STATUS } from "../../lib/campaigns/product-status";
import { QUICK_CAMPAIGN_SCOPE } from "../../lib/campaigns/quick-campaign";
import { astToWhere, type FilterAst } from "../segments.server";
import { duplicateCampaign } from "./housekeeping.server";
import { astOf, createCampaign, productStatusesFor, scopeOf } from "./model.server";
import type { CampaignInput } from "./types";

const SHOP = "shop_1";

const INPUT: CampaignInput = {
  name: "Sale",
  ast: { groups: [] },
  rule: { kind: "percent-change", percent: -20 },
  compareAtPolicy: { kind: "leave" },
  rounding: { default: "none", byCurrency: {} },
};

/** The filter column `createCampaign` wrote, from its one call (#884): the conditions and the statuses. */
async function storedFor(input: CampaignInput) {
  await createCampaign(SHOP, input);
  return prisma.campaign.create.mock.calls[0]![0].data.filter as FilterAst;
}

/** What the status filter at the top of a compiled scope admits, or null for any. */
function statusesAdmitted(where: ReturnType<typeof astToWhere>): string[] | null {
  const status = (where as { status?: { in?: string[] } }).status;
  return status?.in ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.campaign.create.mockResolvedValue({ id: "c1", name: "Sale", status: "DRAFT" });
});

describe("an all-variants campaign", () => {
  it("leaves draft and archived products out when it says nothing", async () => {
    const filter = await storedFor(INPUT);

    // Recorded, so the campaign's own row says what it covers.
    expect(filter.productStatuses).toEqual(["ACTIVE"]);
    expect(statusesAdmitted(astToWhere(SHOP, astOf({ filter } as never)))).toEqual(["ACTIVE"]);
  });

  it("covers them when it opted in", async () => {
    const filter = await storedFor({ ...INPUT, productStatuses: ["ACTIVE", "DRAFT", "ARCHIVED"] });

    expect(statusesAdmitted(astToWhere(SHOP, astOf({ filter } as never)))).toEqual(["ACTIVE", "DRAFT", "ARCHIVED"]);
  });

  it("covers active products only when it was made before anybody could choose", () => {
    // Every campaign created before #751 has no statuses in its filter: none were in its blob
    // for the backfill to read (#884). They covered the archive because nobody had asked, and
    // the reader's default is what keeps a path that forgets to record a choice from pricing
    // it again.
    const legacy = { filter: { groups: [] } } as never;

    expect(productStatusesFor(legacy)).toEqual(["ACTIVE"]);
    expect(statusesAdmitted(astToWhere(SHOP, astOf(legacy)))).toEqual(["ACTIVE"]);
  });
});

describe("where the choice is kept", () => {
  it("takes statuses carried inside the filter, and stores the filter without them", async () => {
    // Home hands its constant scope over whole; the editor sends a field. One answer is
    // kept, beside the conditions, so `astOf` has nothing to reconcile.
    const filter = await storedFor({ ...INPUT, ast: { groups: [], productStatuses: EVERY_STATUS } });

    expect(filter).toEqual({ groups: [], productStatuses: ["ACTIVE", "DRAFT", "ARCHIVED"] });
  });

  it("gives Home's quick campaign the scope its card counts", async () => {
    const filter = await storedFor({ ...INPUT, ast: QUICK_CAMPAIGN_SCOPE });

    expect(astOf({ filter } as never)).toEqual(QUICK_CAMPAIGN_SCOPE);
  });

  it("lets the field win over a filter that disagrees with it", async () => {
    const filter = await storedFor({
      ...INPUT,
      ast: { groups: [], productStatuses: ["ACTIVE"] },
      productStatuses: ["ACTIVE", "ARCHIVED"],
    });

    expect(filter.productStatuses).toEqual(["ACTIVE", "ARCHIVED"]);
  });

  it("keeps the conditions next to the statuses rather than replacing them", async () => {
    const titled: FilterAst = { groups: [{ conditions: [{ field: "title", value: "Alpine Snowboard 0" }] }] };
    const filter = await storedFor({ ...INPUT, ast: titled });

    const where = astToWhere(SHOP, astOf({ filter } as never)) as Record<string, unknown>;
    expect(statusesAdmitted(where)).toEqual(["ACTIVE"]);
    // Outside the OR the groups compile to, so it holds for every group rather than for
    // one of them.
    expect(JSON.stringify(where.OR)).not.toContain("status");
    expect(JSON.stringify(where.OR)).toContain("Alpine Snowboard 0");
  });

  it("survives a duplicate", async () => {
    // Copied with the filter it is part of and the rounding (#762), in their columns (#884); a
    // copy that dropped it would quietly reach the archive the original left out, or the reverse.
    prisma.campaign.findFirstOrThrow.mockResolvedValue({
      name: "Sale",
      ruleRows: [],
      surfaces: {},
      compareAtPolicy: { kind: "leave" },
      guardrails: null,
      filter: { groups: [], productStatuses: ["ACTIVE", "DRAFT"] },
      segmentId: null,
      rounding: null,
      practice: false,
      segments: [],
    });
    prisma.campaign.findMany.mockResolvedValue([]);
    prisma.campaign.create.mockResolvedValue({ id: "copy", name: "Sale (copy)" });

    await duplicateCampaign(SHOP, "c1", null);

    const copy = { filter: prisma.campaign.create.mock.calls[0]![0].data.filter } as never;
    expect(productStatusesFor(copy)).toEqual(["ACTIVE", "DRAFT"]);
  });
});

describe("a campaign on a saved segment", () => {
  it("narrows the segment by the campaign's statuses, not the segment's", async () => {
    // A segment is shared and means every status; which of its products this sale reaches
    // is the campaign's decision. A frozen list is narrowed too.
    prisma.segment.findFirst.mockResolvedValue({
      kind: "FROZEN",
      filterAst: { groups: [] },
      frozenVariantGids: ["gid://shopify/ProductVariant/1"],
    });

    const active = await scopeOf(SHOP, { segmentId: "seg_1", filter: { groups: [] } } as never);
    expect(active.productStatuses).toEqual(["ACTIVE"]);
    expect(active.groups).toEqual([
      { conditions: [{ field: "variantGid", value: ["gid://shopify/ProductVariant/1"] }] },
    ]);

    const all = await scopeOf(SHOP, { segmentId: "seg_1", filter: { groups: [], productStatuses: EVERY_STATUS } } as never);
    expect(statusesAdmitted(astToWhere(SHOP, all))).toEqual(["ACTIVE", "DRAFT", "ARCHIVED"]);
  });
});

describe("a filter that is not a campaign's", () => {
  it("still means every status", () => {
    // Segments, cost edits and the baseline browser compile through `astToWhere` too, and a
    // default there would have changed what each of them matches.
    expect(statusesAdmitted(astToWhere(SHOP, { groups: [] }))).toBeNull();
  });
});
