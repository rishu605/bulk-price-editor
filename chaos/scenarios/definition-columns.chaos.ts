/**
 * What a campaign prices is read from its columns alone, and the schedule JSON holds no copy
 * of it (#1141, the contract of #884), and no campaign prices differently for it.
 *
 * #884's expand release read each column first and the blob behind it. A rollback to the
 * release before it inserts campaigns with the definition in the blob alone and the columns
 * at null and false; this release reads no blob, so its migration fills those columns once
 * more and only then strips the copy. Here, against a real Postgres: rows of every shape the
 * blob has held, inserted as that rollback inserts them after #884's migration ran, and a row
 * as #884's release wrote it, go through the contract's migration and read correctly from
 * their columns, with nothing of a definition left in their blobs.
 *
 * Then the writers that copy or clear a schedule -- Duplicate, Make a real copy, Unschedule,
 * new dates -- write the columns and nothing of a definition into the blob, and an unschedule
 * or new dates keep only the campaign's own record beside the window.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { QUEUED_REFUSED_KEY } from "../../app/lib/campaigns/queued-refusal";
import { START_CONFIRMED_KEY } from "../../app/lib/campaigns/start-confirmation";
import { rawSource } from "../../app/lib/testing/source";
import { duplicateCampaign } from "../../app/services/campaigns/housekeeping.server";
import {
  campaignDefinition,
  createCampaign,
  definitionData,
  IS_PRACTICE,
  isPractice,
  productStatusesFor,
  scopeOf,
  type Definition,
} from "../../app/services/campaigns/model.server";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { reschedule, unschedule } from "../../app/services/campaigns/schedule-control.server";
import { referencingCampaigns } from "../../app/services/segments-crud.server";
import { astToWhere, type FilterAst } from "../../app/services/segments.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

const CATALOG = { catalog: { products: 3, variantsPerProduct: 1 }, percent: -20 } as const;
const EXPAND = "prisma/migrations/20261030090000_campaign_definition_columns/migration.sql";
const CONTRACT = "prisma/migrations/20261031120000_campaign_definition_contract/migration.sql";

/** The keys #884's release copied into the blob, which the contract strips. */
const COPIED_KEYS = ["ast", "productStatuses", "segmentId", "rounding", "practice"];

/** A migration's statements that change rows, comments out and whitespace collapsed. */
function updatesOf(path: string): string[] {
  return rawSource(path)
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => statement.startsWith("UPDATE"));
}

/** The contract's migration, confined to one shop: the chaos database is shared. */
async function contract(shopId: string): Promise<void> {
  const updates = updatesOf(CONTRACT);
  expect(updates, "the contract no longer backfills, then strips").toHaveLength(2);
  for (const update of updates) {
    await prisma.$executeRawUnsafe(`${update} ${/\bWHERE\b/.test(update) ? "AND" : "WHERE"} "shopId" = $1`, shopId);
  }
}

/** A blob without the copy, as the strip leaves it. */
function stripped(blob: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(blob).filter(([key]) => !COPIED_KEYS.includes(key)));
}

const CHAOS_TAG: FilterAst = { groups: [{ conditions: [{ field: "tag", value: "chaos" }] }] };

/**
 * Every shape a campaign's blob has held, as the release before #884 inserts it: the definition
 * there, and the columns at their defaults. Beside each, the definition its columns must hold
 * once the contract's migration has run -- what #884's readers read from that blob -- and how
 * many of the fixture's three variants that prices.
 */
const OLD_BLOBS: Record<string, { blob: Record<string, unknown>; definition: Definition; covers: number }> = {
  "as #751 to #884 wrote it": {
    blob: {
      kind: "manual",
      ast: CHAOS_TAG,
      productStatuses: ["ACTIVE", "DRAFT"],
      segmentId: "seg-deleted-long-ago",
      rounding: { default: "charm99", byCurrency: { JPY: "nearest10" } },
      practice: true,
    },
    definition: {
      filter: { ...CHAOS_TAG, productStatuses: ["ACTIVE", "DRAFT"] },
      segmentId: "seg-deleted-long-ago",
      rounding: { default: "charm99", byCurrency: { JPY: "nearest10" } },
      practice: true,
    },
    // Its segment is gone, so it prices nothing (#776).
    covers: 0,
  },
  "from before #751, with no statuses": {
    blob: { kind: "manual", ast: CHAOS_TAG, rounding: "charm99" },
    definition: { filter: CHAOS_TAG, segmentId: null, rounding: "charm99", practice: false },
    covers: 3,
  },
  "from before rounding": {
    blob: { kind: "manual", ast: { groups: [] } },
    definition: { filter: { groups: [] }, segmentId: null, rounding: null, practice: false },
    covers: 3,
  },
  "with nothing but its kind": {
    blob: { kind: "manual" },
    definition: { filter: { groups: [] }, segmentId: null, rounding: null, practice: false },
    covers: 3,
  },
  "with JSON nulls": {
    blob: { kind: "manual", ast: null, productStatuses: null, segmentId: null, rounding: null, practice: false },
    definition: { filter: { groups: [], productStatuses: null as never }, segmentId: null, rounding: null, practice: false },
    covers: 3,
  },
  "with statuses inside its ast, which were never read": {
    blob: { kind: "manual", ast: { groups: [], productStatuses: ["ARCHIVED"] } },
    definition: { filter: { groups: [] }, segmentId: null, rounding: null, practice: false },
    covers: 3,
  },
  "practice as a string, which was never practice": {
    blob: { kind: "manual", ast: { groups: [] }, practice: "true" },
    definition: { filter: { groups: [] }, segmentId: null, rounding: null, practice: false },
    covers: 3,
  },
  "scheduled, with its window and its own record": {
    blob: {
      kind: "window",
      startAt: "2027-01-01T09:00:00.000Z",
      endAt: "2027-01-02T09:00:00.000Z",
      zone: "Europe/London",
      [START_CONFIRMED_KEY]: { by: "staff:1", at: "2026-10-30T09:00:00.000Z" },
      ast: CHAOS_TAG,
      productStatuses: ["ACTIVE"],
      rounding: { default: "none", byCurrency: {} },
    },
    definition: {
      filter: { ...CHAOS_TAG, productStatuses: ["ACTIVE"] },
      segmentId: null,
      rounding: { default: "none", byCurrency: {} },
      practice: false,
    },
    covers: 3,
  },
};

/** A campaign as the release before #884 inserts one: the fixture's rule, its definition in `schedule`. */
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

/** The same, as #884's release inserts it: the definition in its columns and copied into the blob. */
async function insertedByTheExpandRelease(shopId: string, fixtureId: string, name: string, shape: (typeof OLD_BLOBS)[string]) {
  const row = await insertedByTheReleaseBefore(shopId, fixtureId, name, shape.blob);
  return prisma.campaign.update({ where: { id: row.id }, data: definitionData(shape.definition) });
}

describe("chaos: a campaign's definition in its columns alone (#1141)", () => {
  it("re-runs #884's backfill exactly, before it strips the copy", () => {
    const [backfill, strip] = updatesOf(CONTRACT);
    expect(updatesOf(EXPAND), "#884's migration changed").toHaveLength(1);
    expect(backfill, "the contract fills a row differently from #884").toBe(updatesOf(EXPAND)[0]);
    expect(strip).toContain(`"schedule" - 'ast' - 'productStatuses' - 'segmentId' - 'rounding' - 'practice'`);
  });

  it("fills the columns of a row a rollback inserted after #884's migration, then strips every copy", async () => {
    await withChaos("definition-contract-migration", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const load = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });

      // A row as #884's release wrote it, columns and copy agreeing.
      const expand = await insertedByTheExpandRelease(shopId, campaignId, "Expand-era sale", OLD_BLOBS["as #751 to #884 wrote it"]!);
      expect((await load(expand.id)).schedule, "the expand-era row has no copy to strip").toHaveProperty("ast");

      // Then a rollback to the release before #884, which inserts rows of every shape it has held.
      const ids = new Map<string, string>();
      for (const [shape, { blob }] of Object.entries(OLD_BLOBS)) {
        ids.set(shape, (await insertedByTheReleaseBefore(shopId, campaignId, shape, blob)).id);
      }
      for (const [shape, id] of ids) {
        expect(await load(id), `${shape}: the release before left a column off its default`).toMatchObject({
          filter: null,
          segmentId: null,
          rounding: null,
          practice: false,
        });
      }

      await contract(shopId);

      for (const [shape, id] of ids) {
        const row = await load(id);
        const { blob, definition, covers } = OLD_BLOBS[shape]!;
        expect(campaignDefinition(row), `${shape}: reads differently once contracted`).toEqual(definition);
        expect(row.schedule, `${shape}: the copy is still in the blob`).toEqual(stripped(blob));
        const scope = await scopeOf(shopId, row);
        expect(await prisma.variantIndex.count({ where: astToWhere(shopId, scope) }), `${shape}: prices another scope`).toBe(covers);
      }
      // The answers the blob always gave, so "as the blob said" is not the same mistake twice.
      expect(productStatusesFor(await load(ids.get("from before #751, with no statuses")!))).toEqual(["ACTIVE"]);
      expect(productStatusesFor(await load(ids.get("with statuses inside its ast, which were never read")!))).toEqual(["ACTIVE"]);
      expect(productStatusesFor(await load(ids.get("with JSON nulls")!))).toEqual(["ACTIVE"]);
      expect(await prisma.campaign.count({ where: { shopId, ...IS_PRACTICE } }), "Home's practice count").toBe(2);

      // The expand-era row keeps the columns it wrote, and loses only its copy.
      const contracted = await load(expand.id);
      expect(campaignDefinition(contracted)).toEqual(campaignDefinition(expand));
      expect(contracted.schedule).toEqual({ kind: "manual" });
      // And the fixture, which this release made, had nothing to strip.
      expect((await load(campaignId)).schedule).toEqual({ kind: "manual" });

      // Run again, it changes nothing.
      const rows = () =>
        prisma.campaign.findMany({
          where: { shopId },
          orderBy: { id: "asc" },
          select: { id: true, filter: true, segmentId: true, rounding: true, practice: true, schedule: true },
        });
      const once = await rows();
      await contract(shopId);
      expect(await rows()).toEqual(once);
    });
  });

  it("copies, really copies, unschedules and redates a campaign with nothing of its definition in the blob", async () => {
    await withChaos("definition-contract-writers", CATALOG, async (chaos) => {
      const { shopId, campaignId, variantGids } = chaos.fixture;
      const client = chaosAdminClient(chaos.server.endpoint());
      const load = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
      const fixture = await load(campaignId);

      // A practice campaign on the fixture's products, charm-rounded, made by this release.
      const practice = await createCampaign(shopId, {
        name: "Practice",
        ast: CHAOS_TAG,
        rule: { kind: "percent-change", percent: -20 },
        compareAtPolicy: { kind: "leave" },
        rounding: "charm99" as never,
        practice: true,
      });
      const made = await load(practice.id);
      expect(made).toMatchObject({ practice: true, rounding: "charm99", filter: { ...CHAOS_TAG, productStatuses: ["ACTIVE"] } });
      expect(made.schedule, "the blob holds a definition").toEqual({ kind: "manual" });
      const source = await previewCampaign(shopId, practice.id, { limit: 100 });
      expect(source.rows.map((row) => row.variantGid).sort()).toEqual([...variantGids].sort());

      // Duplicate: practice still, in its column, and refused by the run.
      const copy = await load((await duplicateCampaign(shopId, practice.id, "staff@example.com")).id);
      expect(campaignDefinition(copy)).toEqual(campaignDefinition(made));
      expect(copy.schedule).toEqual({ kind: "manual" });
      await expect(runCampaign(shopId, copy.id, client, { actor: "chaos" })).rejects.toThrow(/practice campaign/);
      expect(await prisma.campaign.count({ where: { shopId, ...IS_PRACTICE } })).toBe(2);

      // Make a real copy: not practice, and it prices what its source previewed.
      const real = await load((await duplicateCampaign(shopId, practice.id, "staff@example.com", { real: true })).id);
      expect(campaignDefinition(real)).toEqual({ ...campaignDefinition(made), practice: false });
      expect(real.schedule).toEqual({ kind: "manual" });
      const preview = await previewCampaign(shopId, real.id, { limit: 100 });
      const after = (rows: typeof preview.rows) => new Map(rows.map((row) => [row.variantGid, row.after]));
      expect(after(preview.rows)).toEqual(after(source.rows));
      const applied = await runCampaign(shopId, real.id, client, { actor: "chaos", verifySampleRate: 1 });
      expect(applied.clean).toBe(true);
      expect(applied.verified).toBe(variantGids.length);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid), "the real copy lost its rounding").toMatch(/\.99$/);

      // A scheduled campaign with its own record beside the window, and what became of a start.
      const own = {
        [START_CONFIRMED_KEY]: { by: "staff:1", at: "2026-10-30T09:00:00.000Z", planned: 3, largeChanges: 0, largestBasisPoints: 0, atMinimum: 0 },
        [QUEUED_REFUSED_KEY]: { verb: "apply", reason: "x", at: "2026-10-30T09:00:00.000Z" },
      };
      const window = {
        kind: "window",
        startAt: "2027-01-01T09:00:00.000Z",
        endAt: "2027-01-02T09:00:00.000Z",
        revertBufferMinutes: 15,
        zone: "Europe/London",
        startRefused: { reason: "No.", at: "2026-12-31T09:00:00.000Z", startAt: "2027-01-01T09:00:00.000Z" },
      };
      const scheduledWith = async (name: string, extra: object = {}) => {
        const { id } = await createCampaign(shopId, {
          name,
          ast: CHAOS_TAG,
          rule: { kind: "percent-change", percent: -20 },
          compareAtPolicy: { kind: "leave" },
          rounding: { default: "none", byCurrency: {} },
          schedule: { kind: "window", startAt: window.startAt, endAt: window.endAt },
        });
        await prisma.campaign.update({ where: { id }, data: { schedule: { ...window, ...own, ...extra } as never } });
        return load(id);
      };

      // Unschedule: the dates go, and all about them; the campaign's own record stays.
      const drafted = await scheduledWith("Unscheduled");
      await unschedule(shopId, drafted.id, "staff@example.com");
      const unscheduled = await load(drafted.id);
      expect(unscheduled.status).toBe("DRAFT");
      expect(unscheduled.schedule).toEqual({ ...own, kind: "manual" });
      expect(campaignDefinition(unscheduled)).toEqual(campaignDefinition(drafted));

      // New dates: the window is the new one, the buffer kept; the own record stays.
      const moved = await scheduledWith("Redated");
      const redate = { startUtc: "2027-02-01T09:00:00.000Z", endUtc: null, clockNotes: [], zone: "UTC" };
      await reschedule(shopId, moved.id, redate, "staff@example.com");
      const redated = await load(moved.id);
      expect(redated.schedule).toEqual({ ...own, kind: "window", startAt: redate.startUtc, revertBufferMinutes: 15, zone: "UTC" });
      expect(campaignDefinition(redated)).toEqual(campaignDefinition(moved));

      // And either one leaves behind a copy #884's release wrote, which nothing reads.
      const stale = await scheduledWith("Expand-era", { ast: { groups: [] }, productStatuses: ["ARCHIVED"], practice: true });
      expect(isPractice(stale), "a stale copy made it practice").toBe(false);
      await unschedule(shopId, stale.id, "staff@example.com");
      expect((await load(stale.id)).schedule).toEqual({ ...own, kind: "manual" });
      expect(campaignDefinition(await load(stale.id))).toEqual(campaignDefinition(stale));
      expect(campaignDefinition(stale).filter).toEqual(campaignDefinition(fixture).filter);
    });
  });

  it("keeps a segment from being deleted while a campaign a rollback made names it, once its column is filled", async () => {
    await withChaos("definition-contract-segment", CATALOG, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const segmentId = "seg-named-not-related";

      // Neither has the relation the delete guard reads first. One was inserted by the release
      // before #884, naming the segment in its blob alone; one names it in its column alone.
      const old = await insertedByTheReleaseBefore(shopId, campaignId, "Old segment sale", { kind: "manual", segmentId });
      const current = await insertedByTheReleaseBefore(shopId, campaignId, "New segment sale", { kind: "manual" });
      await prisma.campaign.update({ where: { id: current.id }, data: { filter: { groups: [] }, segmentId } });

      await contract(shopId);

      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: old.id } })).schedule).toEqual({ kind: "manual" });
      const named = await referencingCampaigns(shopId, segmentId);
      expect(named.map((campaign) => campaign.id).sort()).toEqual([old.id, current.id].sort());
    });
  });
});
