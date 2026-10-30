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

import { duplicateCampaign, housekeepingAction, setArchived, setNote } from "./housekeeping.server";
import { astOf, campaignDefinition, isPractice, segmentIdOf, toResolvable } from "./model.server";

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
  // What it prices, in its columns (#884) and -- as `createCampaign` writes it this release --
  // in the blob too: a window, and beside it the things that decide a price (#762).
  filter: { groups: [{ conditions: [{ field: "title", value: "Alpine" }] }], productStatuses: ["ACTIVE", "DRAFT"] },
  segmentId: "seg-1",
  rounding: { default: "charm99", byCurrency: { JPY: "nearest10" } },
  practice: true,
  schedule: {
    kind: "window",
    startAt: "2026-07-01T09:00:00.000Z",
    endAt: "2026-07-31T23:59:00.000Z",
    revertBufferMinutes: 10,
    clockNotes: ["The clocks go forward…"],
    ast: { groups: [{ conditions: [{ field: "title", value: "Alpine" }] }] },
    productStatuses: ["ACTIVE", "DRAFT"],
    segmentId: "seg-1",
    rounding: { default: "charm99", byCurrency: { JPY: "nearest10" } },
    practice: true,
  },
  segments: [{ id: "seg-1" }],
};

/** The same campaign as the release before wrote it: the definition in the blob alone (#884). */
const BLOB_ONLY = { ...SOURCE, filter: null, segmentId: null, rounding: null, practice: false };

/** A copy as the readers see it: its columns, its blob, or both. */
const columnsOf = (data: Record<string, unknown>) =>
  ({ filter: data.filter, segmentId: data.segmentId, rounding: data.rounding, practice: data.practice, schedule: data.schedule }) as never;
const blobOf = (data: Record<string, unknown>) => ({ schedule: data.schedule }) as never;

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
    for (const field of ["startAt", "endAt", "enrollPendingAt", "enrollPendingVariantGids", "runs", "id"]) {
      expect(data, `a copy must not carry ${field}`).not.toHaveProperty(field);
    }
    // The window inside the blob as well: a copy runs by hand until somebody dates it.
    expect(data.schedule.kind).toBe("manual");
    for (const key of ["startAt", "endAt", "revertBufferMinutes", "clockNotes"]) {
      expect(data.schedule, `a copy must not carry the schedule's ${key}`).not.toHaveProperty(key);
    }
  });

  it("prices exactly what its source prices (#762)", async () => {
    // The copy used to get the column default `{}`: an empty filter -- the whole
    // catalogue -- no segment, no rounding, and not practice, so it could be applied.
    // Read back through the model's own readers, the way a run reads it.
    await duplicateCampaign("shop", "c1", "ada");

    const { data } = prisma.campaign.create.mock.calls[0]![0];
    const copy = columnsOf(data);
    const source = SOURCE as never;

    expect(astOf(copy)).toEqual(astOf(source));
    expect(astOf(copy).groups).toHaveLength(1);
    expect(astOf(copy).productStatuses).toEqual(["ACTIVE", "DRAFT"]);
    expect(segmentIdOf(copy)).toBe("seg-1");
    expect(isPractice(copy), "a practice campaign's copy could be applied").toBe(true);
    expect(toResolvable({ ...SOURCE, ...data, id: "copy-1", createdAt: new Date() } as never).roundingPolicy).toEqual(
      toResolvable({ ...SOURCE, id: "c1", createdAt: new Date() } as never).roundingPolicy,
    );
  });

  it("copies the definition into the copy's own columns (#884)", async () => {
    await duplicateCampaign("shop", "c1", "ada");

    const { data } = prisma.campaign.create.mock.calls[0]![0];
    expect(data).toMatchObject({ filter: SOURCE.filter, segmentId: "seg-1", rounding: SOURCE.rounding, practice: true });
    // And the blob says the same, for the release before: a rollback reads the copy alike.
    expect(campaignDefinition(blobOf(data))).toEqual(campaignDefinition(columnsOf(data)));
  });

  it("copies a campaign the release before made, whose definition is in its blob alone (#884)", async () => {
    // A row written by the release before -- in the migration's wake, or during a rollback --
    // has its columns at their defaults. Its copy is still the same campaign, and has its
    // columns filled from the blob.
    prisma.campaign.findFirstOrThrow.mockResolvedValue(BLOB_ONLY);

    await duplicateCampaign("shop", "c1", "ada");

    const { data } = prisma.campaign.create.mock.calls[0]![0];
    expect(campaignDefinition(BLOB_ONLY as never)).toEqual(campaignDefinition(SOURCE as never));
    expect(data).toMatchObject({ filter: SOURCE.filter, segmentId: "seg-1", rounding: SOURCE.rounding, practice: true });
    expect(campaignDefinition(columnsOf(data))).toEqual(campaignDefinition(SOURCE as never));
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

describe("a practice campaign's real copy (#1077)", () => {
  /** What the page's action does with a press, as its form posts it. */
  const press = (intent: string) =>
    housekeepingAction("shop", "c1", "ada", new Map([["intent", intent]]) as unknown as FormData);
  /** A record less some of its keys. */
  const without = (record: Record<string, unknown>, ...keys: string[]) =>
    Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

  it("is the same copy, without the practice flag", async () => {
    // The same copier as Duplicate, so it prices exactly what its source previewed.
    await duplicateCampaign("shop", "c1", "ada");
    const duplicate = prisma.campaign.create.mock.calls[0]![0].data;
    await duplicateCampaign("shop", "c1", "ada", { real: true });
    const real = prisma.campaign.create.mock.calls[1]![0].data;

    expect(isPractice(columnsOf(real)), "the real copy is practice").toBe(false);
    expect(isPractice(blobOf(real)), "the real copy is practice to the release before").toBe(false);
    expect(isPractice(columnsOf(duplicate)), "Duplicate stopped keeping practice (#762)").toBe(true);
    expect(real.schedule).toEqual(without(duplicate.schedule, "practice"));
    expect(without(real, "name", "schedule", "practice")).toEqual(without(duplicate, "name", "schedule", "practice"));
    expect(real.status).toBe("DRAFT");
  });

  it("is named for what it is", async () => {
    await duplicateCampaign("shop", "c1", "ada", { real: true });

    expect(prisma.campaign.create.mock.calls[0]![0].data.name).toBe("Summer sale (real)");
  });

  it("is refused for a rule every Apply refuses (#818), and nothing is made", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({
      ...SOURCE,
      ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent: -150 } }],
    });

    await expect(duplicateCampaign("shop", "c1", "ada", { real: true })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(prisma.campaign.create).not.toHaveBeenCalled();
  });

  it("is recorded as a copy that is not practice", async () => {
    await duplicateCampaign("shop", "c1", "ada", { real: true });

    expect(prisma.auditLogEntry.create.mock.calls[0]![0].data).toMatchObject({
      action: "campaign.duplicate",
      after: { from: "c1", practice: false },
    });
  });

  it("is what the page's real-copy press makes, landing on the copy", async () => {
    const reply = await press("real-copy");

    expect(reply).toMatchObject({ ok: true, redirectTo: "/app/campaigns/copy-1?duplicated=1" });
    expect(isPractice(columnsOf(prisma.campaign.create.mock.calls[0]![0].data))).toBe(false);
  });

  it("is real of a practice campaign the release before made, though only its blob said so (#884)", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue(BLOB_ONLY);

    await press("real-copy");

    const { data } = prisma.campaign.create.mock.calls[0]![0];
    expect(isPractice(columnsOf(data))).toBe(false);
    expect(data.schedule).not.toHaveProperty("practice");
    expect(segmentIdOf(columnsOf(data)), "the real copy lost its segment").toBe("seg-1");
  });

  it("leaves Duplicate's press making a practice copy", async () => {
    await press("duplicate");

    expect(isPractice(columnsOf(prisma.campaign.create.mock.calls[0]![0].data))).toBe(true);
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
