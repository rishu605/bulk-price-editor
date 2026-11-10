/**
 * A campaign's compare-at violation policy is its own (#817, PRD A-3.3, D32).
 *
 * `createCampaign` stored "clear" for every campaign and `toResolvable` handed the resolver
 * "clear" whatever was stored, so the resolver's skip and block were tested and unreachable --
 * #338's shape, on the compare-at. Pinned here: what is stored, what is read back, and that a
 * campaign planned before it is saved is planned with the same answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    campaign: { create: vi.fn() },
    auditLogEntry: { create: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prisma }));
vi.mock("../settings.server", () => ({
  readSettings: vi.fn(async () => ({ violationPolicy: "clamp" })),
}));

import { asCompareAtViolation } from "../../lib/campaigns/compare-at-violation";
import { createCampaign, toResolvable, unsavedCampaign } from "./model.server";
import type { CampaignInput } from "./types";

const INPUT: CampaignInput = {
  name: "Strike-through sale",
  ast: { groups: [] },
  rule: { kind: "percent-change", percent: -5 },
  compareAtPolicy: { kind: "set-to-baseline" },
  rounding: { default: "charm99", byCurrency: {} },
};

async function stored(input: CampaignInput) {
  await createCampaign("shop", input);
  return prisma.campaign.create.mock.calls.at(-1)![0].data as Record<string, unknown>;
}

const planned = (row: Record<string, unknown>) =>
  toResolvable({ id: "c", createdAt: new Date(0), excludedVariantGids: [], ...row } as never).compareAtViolationPolicy;

beforeEach(() => {
  vi.clearAllMocks();
  prisma.campaign.create.mockResolvedValue({ id: "c1", name: INPUT.name, status: "DRAFT" });
});

describe("a campaign's compare-at violation policy", () => {
  it("is stored as chosen, and planned as stored", async () => {
    for (const policy of ["clear", "skip", "block"] as const) {
      const row = await stored({ ...INPUT, compareAtViolationPolicy: policy });
      expect(row.compareAtViolationPolicy).toBe(policy);
      expect(planned(row)).toBe(policy);
    }
  });

  it("is clear where nothing chose one, as every campaign was before", async () => {
    const row = await stored(INPUT);
    expect(row.compareAtViolationPolicy).toBe("clear");
    expect(planned(row)).toBe("clear");
  });

  it("is planned before it is saved with the answer it will be saved with (#1009)", async () => {
    const unsaved = await unsavedCampaign("shop", { ...INPUT, compareAtViolationPolicy: "block" });
    expect(toResolvable(unsaved).compareAtViolationPolicy).toBe("block");
  });

  it("reads anything it does not know as clear, the one that keeps a price written", () => {
    expect(asCompareAtViolation("BLOCK")).toBe("clear");
    expect(asCompareAtViolation(null)).toBe("clear");
    expect(asCompareAtViolation("skip")).toBe("skip");
  });
});
