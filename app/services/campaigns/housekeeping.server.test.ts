/**
 * Copy it, say why it exists, file it away.
 *
 * The assertions worth having here are all about what a duplicate does *not* carry.
 * Copying a rule is the easy half and its failure is visible in the editor; copying a run
 * history is invisible and makes the record lie about what has been written to a live
 * storefront.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { prisma } = vi.hoisted(() => ({
  prisma: {
    campaign: { findFirstOrThrow: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    auditLogEntry: { create: vi.fn() },
  },
}));
vi.mock("../../db.server", () => ({ default: prisma }));

import { duplicateCampaign, setArchived, setNote } from "./housekeeping.server";

const SOURCE = {
  name: "Summer sale",
  priority: 100,
  ruleRows: [{ kind: "percent-change", percent: -20 }],
  surfaces: { base: true },
  compareAtPolicy: { kind: "baseline" },
  compareAtViolationPolicy: "clear",
  roundingProfileId: "round-1",
  guardrails: null,
  guardrailViolationPolicy: "clamp",
  tagKit: ["summer-sale"],
  autoEnroll: true,
  excludedVariantGids: ["gid://shopify/ProductVariant/9"],
  note: "Matched a competitor",
  segments: [{ id: "seg-1" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.campaign.findFirstOrThrow.mockResolvedValue(SOURCE);
  prisma.campaign.findMany.mockResolvedValue([{ name: "Summer sale" }]);
  prisma.campaign.create.mockResolvedValue({ id: "copy-1", name: "Summer sale (copy)" });
  prisma.campaign.update.mockResolvedValue({ name: "Summer sale", note: null });
});

describe("duplicating a campaign", () => {
  it("carries everything that decides a price", async () => {
    await duplicateCampaign("shop", "c1", "ada");

    const { data } = prisma.campaign.create.mock.calls[0]![0];
    expect(data).toMatchObject({
      priority: 100,
      ruleRows: SOURCE.ruleRows,
      surfaces: SOURCE.surfaces,
      compareAtPolicy: SOURCE.compareAtPolicy,
      compareAtViolationPolicy: "clear",
      roundingProfileId: "round-1",
      guardrailViolationPolicy: "clamp",
      tagKit: ["summer-sale"],
      excludedVariantGids: ["gid://shopify/ProductVariant/9"],
      note: "Matched a competitor",
    });
  });

  it("carries nothing that says what the original did", async () => {
    // The one that matters. A duplicate holding its source's schedule would arm a run
    // for a date that has passed; one holding its run history would claim prices had
    // been written to a storefront that never saw them.
    await duplicateCampaign("shop", "c1", "ada");

    const { data } = prisma.campaign.create.mock.calls[0]![0];
    expect(data.status).toBe("DRAFT");
    for (const field of ["schedule", "startAt", "endAt", "enrollPendingAt", "runs", "id"]) {
      expect(data, `a copy must not carry ${field}`).not.toHaveProperty(field);
    }
  });

  it("connects the segment rather than copying it", async () => {
    // A segment is a saved definition several campaigns share. Copied rows would stop
    // tracking the original the first time either one is edited.
    await duplicateCampaign("shop", "c1", "ada");

    expect(prisma.campaign.create.mock.calls[0]![0].data.segments).toEqual({
      connect: [{ id: "seg-1" }],
    });
  });

  it("names the copy against every campaign in the shop, archived ones included", async () => {
    prisma.campaign.findMany.mockResolvedValue([{ name: "Summer sale" }, { name: "Summer sale (copy)" }]);

    await duplicateCampaign("shop", "c1", "ada");

    expect(prisma.campaign.create.mock.calls[0]![0].data.name).toBe("Summer sale (copy 2)");
    expect(prisma.campaign.findMany.mock.calls[0]![0].where).toEqual({ shopId: "shop" });
  });

  it("reads only from the merchant's own shop", async () => {
    await duplicateCampaign("shop", "c1", "ada");

    expect(prisma.campaign.findFirstOrThrow.mock.calls[0]![0].where).toEqual({
      id: "c1",
      shopId: "shop",
    });
  });

  it("records who copied what from where", async () => {
    await duplicateCampaign("shop", "c1", "ada");

    expect(prisma.auditLogEntry.create.mock.calls[0]![0].data).toMatchObject({
      actor: "ada",
      action: "campaign.duplicate",
      entityId: "copy-1",
      after: { from: "c1" },
    });
  });
});

describe("archiving", () => {
  it("stamps a time going in and clears it coming out", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ id: "c1", note: null });

    await setArchived("shop", "c1", true, "ada");
    expect(prisma.campaign.update.mock.calls[0]![0].data.archivedAt).toBeInstanceOf(Date);

    await setArchived("shop", "c1", false, "ada");
    expect(prisma.campaign.update.mock.calls[1]![0].data.archivedAt).toBeNull();
  });

  it("does not touch the lifecycle", async () => {
    // Archiving an ACTIVE campaign is a filing decision, not a pricing one: the prices
    // stay live, the scheduler keeps seeing it, and a `status` written here would be the
    // app quietly ending a campaign a merchant only meant to tidy away.
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ id: "c1", note: null });

    await setArchived("shop", "c1", true, "ada");

    expect(prisma.campaign.update.mock.calls[0]![0].data).not.toHaveProperty("status");
  });
});

describe("the note", () => {
  it("keeps the replaced text, because nothing else can reconstruct it", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ id: "c1", note: "Old reason" });
    prisma.campaign.update.mockResolvedValue({ note: "New reason" });

    await setNote("shop", "c1", "New reason", "ada");

    expect(prisma.auditLogEntry.create.mock.calls[0]![0].data).toMatchObject({
      action: "campaign.note",
      before: { note: "Old reason" },
      after: { note: "New reason" },
    });
  });

  it("treats blank as no note at all", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ id: "c1", note: "Old" });

    await setNote("shop", "c1", "   ", "ada");

    expect(prisma.campaign.update.mock.calls[0]![0].data.note).toBeNull();
  });
});
