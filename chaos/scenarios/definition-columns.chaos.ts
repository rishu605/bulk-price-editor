/**
 * What a campaign prices moves out of its schedule JSON into columns, and no campaign prices
 * differently for it (#884).
 *
 * The expand release. Campaigns already in the database are filled by the migration's
 * backfill, from every shape the blob has held. Campaigns the release before writes -- in the
 * migration's wake, or during a rollback -- have the definition in the blob alone and their
 * columns at null and false, and every reader takes those from the blob. Each is checked here
 * against a real Postgres: the readers' answers before the backfill, after it, and from the
 * columns alone, which is all the contract release will read.
 *
 * Then the writers that copy or clear a schedule -- Duplicate, Make a real copy, Unschedule --
 * on a campaign the release before made: each comes out with its columns filled, and its copy
 * prices what the source prices.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { DEFINITION_KEYS } from "../../app/lib/campaigns/schedule-blob";
import { rawSource } from "../../app/lib/testing/source";
import { duplicateCampaign } from "../../app/services/campaigns/housekeeping.server";
import {
  astOf,
  campaignDefinition,
  IS_PRACTICE,
  isPractice,
  productStatusesFor,
  scopeOf,
  segmentIdOf,
  toResolvable,
} from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { reschedule, unschedule } from "../../app/services/campaigns/schedule-control.server";
import { referencingCampaigns } from "../../app/services/segments-crud.server";
import { astToWhere } from "../../app/services/segments.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;
const MIGRATION = "prisma/migrations/20261030090000_campaign_definition_columns/migration.sql";

/** The migration's backfill, confined to one shop: the chaos database is shared. */
async function backfill(shopId: string): Promise<void> {
  const sql = rawSource(MIGRATION).replace(/--.*$/gm, "");
  const update = sql
    .split(";")
    .map((statement) => statement.trim())
    .find((statement) => statement.startsWith("UPDATE"));
  expect(update, "the migration has no backfill").toBeDefined();
  await prisma.$executeRawUnsafe(`${update} WHERE "shopId" = $1`, shopId);
}

/**
 * Every shape a campaign's blob has held, as the release before inserts it: the definition
 * there, and the columns left at their defaults.
 */
const OLD_BLOBS: Record<string, Record<string, unknown>> = {
  "as #751 to #884 wrote it": {
    kind: "manual",
    ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
    productStatuses: ["ACTIVE", "DRAFT"],
    segmentId: "seg-deleted-long-ago",
    rounding: { default: "charm99", byCurrency: { JPY: "nearest10" } },
    practice: true,
  },
  "from before #751, with no statuses": {
    kind: "manual",
    ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
    rounding: "charm99",
  },
  "from before rounding": { kind: "manual", ast: { groups: [] } },
  "with nothing but its kind": { kind: "manual" },
  "with JSON nulls": { kind: "manual", ast: null, productStatuses: null, segmentId: null, rounding: null, practice: false },
  "with statuses inside its ast, which were never read": {
    kind: "manual",
    ast: { groups: [], productStatuses: ["ARCHIVED"] },
  },
  "practice as a string, which was never practice": { kind: "manual", ast: { groups: [] }, practice: "true" },
  "scheduled, with its window and its own record": {
    kind: "window",
    startAt: "2027-01-01T09:00:00.000Z",
    endAt: "2027-01-02T09:00:00.000Z",
    zone: "Europe/London",
    startConfirmed: { by: "staff:1", at: "2026-10-30T09:00:00.000Z" },
    ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
    productStatuses: ["ACTIVE"],
    rounding: { default: "none", byCurrency: {} },
  },
};

/** Every reader's answer for a campaign, and how many variants its scope covers. */
async function readings(shopId: string, campaign: Parameters<typeof campaignDefinition>[0]) {
  return {
    ast: astOf(campaign),
    productStatuses: productStatusesFor(campaign),
    segmentId: segmentIdOf(campaign),
    practice: isPractice(campaign),
    rounding: toResolvable({ ...(campaign as object), id: "c", createdAt: new Date(0) } as never).roundingPolicy,
    covers: await prisma.variantIndex.count({ where: astToWhere(shopId, await scopeOf(shopId, campaign)) }),
  };
}

/** The columns alone, with the blob's copy of the definition taken out: what the contract reads. */
function columnsOnly<T extends { schedule: unknown }>(campaign: T): T {
  const schedule = { ...(campaign.schedule as Record<string, unknown>) };
  for (const key of DEFINITION_KEYS) delete schedule[key];
  return { ...campaign, schedule };
}

/** A campaign as the release before inserts one: the fixture's rule, its definition in `schedule`. */
async function insertedByTheReleaseBefore(shopId: string, fixtureId: string, name: string, schedule: object) {
  const fixture = await prisma.campaign.findUniqueOrThrow({ where: { id: fixtureId } });
  return prisma.campaign.create({
    data: {
      shopId,
      name,
      status: (schedule as { kind?: string }).kind === "window" ? "SCHEDULED" : "DRAFT",
      ruleRows: fixture.ruleRows as never,
      surfaces: fixture.surfaces as never,
      compareAtPolicy: fixture.compareAtPolicy as never,
      guardrails: {} as never,
      schedule: schedule as never,
    },
  });
}

describe("chaos: a campaign's definition in columns of its own (#884)", () => {
  it("fills them from every shape the blob has held, and every reader answers as before", async () => {
    await withChaos("definition-columns-backfill", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;

      const ids = new Map<string, string>();
      for (const [shape, blob] of Object.entries(OLD_BLOBS)) {
        ids.set(shape, (await insertedByTheReleaseBefore(shopId, campaignId, shape, blob)).id);
      }
      const load = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

      // Before: columns at their defaults, every answer from the blob.
      const before = new Map<string, Awaited<ReturnType<typeof readings>>>();
      for (const [shape, id] of ids) {
        const row = await load(id);
        expect(row, `${shape}: the release before left a column off its default`).toMatchObject({
          filter: null,
          segmentId: null,
          rounding: null,
          practice: false,
        });
        before.set(shape, await readings(shopId, row));
      }
      // The answers the blob always gave, so "the same as before" is not the same mistake twice.
      expect(before.get("from before #751, with no statuses")!.productStatuses).toEqual(["ACTIVE"]);
      expect(before.get("from before #751, with no statuses")!.covers).toBe(3);
      expect(before.get("with nothing but its kind")!.ast).toEqual({ groups: [], productStatuses: ["ACTIVE"] });
      expect(before.get("as #751 to #884 wrote it")!.covers, "a deleted segment's campaign priced something").toBe(0);
      expect(before.get("as #751 to #884 wrote it")!.practice).toBe(true);
      expect(before.get("practice as a string, which was never practice")!.practice).toBe(false);
      expect(before.get("with statuses inside its ast, which were never read")!.productStatuses).toEqual(["ACTIVE"]);

      await backfill(shopId);

      for (const [shape, id] of ids) {
        const row = await load(id);
        expect(row.filter, `${shape}: the backfill left the filter empty`).not.toBeNull();
        expect(row.schedule, `${shape}: the backfill touched the blob`).toEqual(OLD_BLOBS[shape]);
        expect(await readings(shopId, row), `${shape}: reads differently once backfilled`).toEqual(before.get(shape));
        expect(await readings(shopId, columnsOnly(row)), `${shape}: the columns alone are not the campaign`).toEqual(
          before.get(shape),
        );
      }
      expect(await load(ids.get("as #751 to #884 wrote it")!)).toMatchObject({
        filter: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }], productStatuses: ["ACTIVE", "DRAFT"] },
        segmentId: "seg-deleted-long-ago",
        rounding: { default: "charm99", byCurrency: { JPY: "nearest10" } },
        practice: true,
      });
      expect(await load(ids.get("with JSON nulls")!)).toMatchObject({ segmentId: null, rounding: null, practice: false });

      // Run again -- as the contract will, for rows a rollback inserted -- it changes nothing.
      const definitions = () =>
        prisma.campaign.findMany({
          where: { shopId },
          orderBy: { id: "asc" },
          select: { id: true, filter: true, segmentId: true, rounding: true, practice: true, schedule: true },
        });
      const once = await definitions();
      await backfill(shopId);
      expect(await definitions()).toEqual(once);

      // A campaign this release made reads the same from its blob, as the release before reads
      // it in a rollback, as from its columns.
      const made = await load(campaignId);
      expect(await readings(shopId, { ...made, filter: null, segmentId: null, rounding: null, practice: false })).toEqual(
        await readings(shopId, made),
      );
      expect(await readings(shopId, columnsOnly(made))).toEqual(await readings(shopId, made));
    });
  });

  it("copies, really copies and unschedules a campaign the release before made, filling its columns", async () => {
    await withChaos("definition-columns-writers", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());

      // A practice campaign the release before made, on the fixture's products, charm-rounded.
      const practice = await insertedByTheReleaseBefore(shopId, campaignId, "Old practice", {
        kind: "manual",
        ast: { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] },
        productStatuses: ["ACTIVE"],
        rounding: "charm99",
        practice: true,
      });
      expect(await prisma.campaign.count({ where: { shopId, ...IS_PRACTICE } }), "Home missed a practice campaign").toBe(1);
      const source = await previewCampaign(shopId, practice.id, { limit: 100 });
      expect(source.rows.map((row) => row.variantGid).sort()).toEqual([...variantGids].sort());

      // Duplicate: practice still, in its column now, and refused by the run.
      const copy = await duplicateCampaign(shopId, practice.id, "staff@example.com");
      const copied = await prisma.campaign.findUniqueOrThrow({ where: { id: copy.id } });
      expect(copied).toMatchObject({ practice: true, rounding: "charm99", filter: { productStatuses: ["ACTIVE"] } });
      expect(campaignDefinition(columnsOnly(copied))).toEqual(campaignDefinition(practice));
      await expect(runCampaign(shopId, copy.id, client, { actor: "chaos" })).rejects.toThrow(/practice campaign/);
      expect(await prisma.campaign.count({ where: { shopId, ...IS_PRACTICE } })).toBe(2);

      // Make a real copy: not practice in either place, and it prices what its source previewed.
      const real = await duplicateCampaign(shopId, practice.id, "staff@example.com", { real: true });
      const made = await prisma.campaign.findUniqueOrThrow({ where: { id: real.id } });
      expect(made.practice).toBe(false);
      expect(made.schedule).not.toHaveProperty("practice");
      expect(campaignDefinition(columnsOnly(made))).toEqual({ ...campaignDefinition(practice), practice: false });
      const preview = await previewCampaign(shopId, real.id, { limit: 100 });
      const after = (rows: typeof preview.rows) => new Map(rows.map((row) => [row.variantGid, row.after]));
      expect(after(preview.rows)).toEqual(after(source.rows));
      const applied = await runCampaign(shopId, real.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(applied.clean).toBe(true);
      expect(applied.verified).toBe(variantGids.length);
      for (const gid of variantGids) {
        expect(chaos.fake.priceOf(gid), "the real copy lost its rounding").toMatch(/\.99$/);
      }

      // Unschedule: the dates go, the definition stays -- in its columns now, and in the blob.
      const scheduled = await insertedByTheReleaseBefore(shopId, campaignId, "Old scheduled", OLD_BLOBS["scheduled, with its window and its own record"]!);
      await unschedule(shopId, scheduled.id, "staff@example.com");
      const drafted = await prisma.campaign.findUniqueOrThrow({ where: { id: scheduled.id } });
      expect(drafted.status).toBe("DRAFT");
      expect(drafted.schedule).toMatchObject({ kind: "manual", ast: OLD_BLOBS["scheduled, with its window and its own record"]!.ast });
      expect(drafted.schedule).not.toHaveProperty("startAt");
      expect(drafted).toMatchObject({ filter: { productStatuses: ["ACTIVE"] }, rounding: { default: "none", byCurrency: {} } });
      expect(campaignDefinition(columnsOnly(drafted))).toEqual(campaignDefinition(scheduled));

      // New dates: the window changes, the definition stays, written both ways.
      const moved = await insertedByTheReleaseBefore(shopId, campaignId, "Old moved", OLD_BLOBS["scheduled, with its window and its own record"]!);
      const window = { startUtc: "2027-02-01T09:00:00.000Z", endUtc: null, clockNotes: [], zone: "UTC" };
      await reschedule(shopId, moved.id, window, "staff@example.com");
      const redated = await prisma.campaign.findUniqueOrThrow({ where: { id: moved.id } });
      expect(redated.schedule).toMatchObject({ kind: "window", startAt: window.startUtc, zone: "UTC", productStatuses: ["ACTIVE"] });
      expect(redated.schedule).not.toHaveProperty("endAt");
      expect(redated).toMatchObject({ filter: { productStatuses: ["ACTIVE"] }, rounding: { default: "none", byCurrency: {} } });
      expect(campaignDefinition(columnsOnly(redated))).toEqual(campaignDefinition(moved));
    });
  });

  it("keeps a segment from being deleted while a campaign names it in either place", async () => {
    await withChaos("definition-columns-segment", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const segmentId = "seg-named-not-related";

      // Neither has the relation the delete guard reads first: one names the segment in its
      // blob alone, as the release before wrote it; one in its column alone, as the contract will.
      const old = await insertedByTheReleaseBefore(shopId, campaignId, "Old segment sale", { kind: "manual", segmentId });
      const contract = await insertedByTheReleaseBefore(shopId, campaignId, "New segment sale", { kind: "manual" });
      await prisma.campaign.update({ where: { id: contract.id }, data: { segmentId } });

      const named = await referencingCampaigns(shopId, segmentId);
      expect(named.map((campaign) => campaign.id).sort()).toEqual([old.id, contract.id].sort());
    });
  });
});
