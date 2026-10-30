/**
 * What a campaign prices, in columns of its own (#884), and since the contract nowhere else
 * (#1141).
 *
 * Pinned here: that every writer writes the columns and nothing of a definition into the
 * schedule JSON; that every reader reads the columns alone, whatever a blob says; and what a
 * column at its default means. The chaos scenario `definition-columns` runs the contract's
 * migration against rows of every shape the blob has held -- a rollback's included -- and
 * reads them back through these readers.
 */

import { Prisma } from "@prisma/client";
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

import { OWN_KEYS } from "../../lib/campaigns/own-record";
import { START_CONFIRMED_KEY } from "../../lib/campaigns/start-confirmation";
import {
  astOf,
  campaignDefinition,
  createCampaign,
  DEFINITION,
  definitionData,
  IS_PRACTICE,
  isPractice,
  productStatusesFor,
  roundingFor,
  segmentIdOf,
  toResolvable,
  unsavedCampaign,
  type Definition,
} from "./model.server";
import type { CampaignInput } from "./types";

const INPUT: CampaignInput = {
  name: "Alpine clearance",
  ast: { groups: [{ conditions: [{ field: "tag", value: "alpine" }] }] },
  rule: { kind: "percent-change", percent: -30 },
  compareAtPolicy: { kind: "leave" },
  rounding: { default: "charm99", byCurrency: { JPY: "nearest10" } },
  productStatuses: ["ACTIVE", "DRAFT"],
  segmentId: "seg-1",
  practice: true,
};

/** The keys #884's release copied into the blob, which no blob holds since #1141. */
const COPIED_KEYS = ["ast", "productStatuses", "segmentId", "rounding", "practice"];

/** A row as the app stores it, from what `createCampaign` handed Prisma. */
async function created(input: CampaignInput) {
  await createCampaign("shop", input);
  return prisma.campaign.create.mock.calls.at(-1)![0].data as Record<string, unknown>;
}

/** Every reader's answer for a campaign, as one comparable value. */
function readings(campaign: never) {
  return {
    ast: astOf(campaign),
    productStatuses: productStatusesFor(campaign),
    segmentId: segmentIdOf(campaign),
    practice: isPractice(campaign),
    rounding: toResolvable({ id: "c", createdAt: new Date(0), ...(campaign as object) } as never).roundingPolicy,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.campaign.create.mockResolvedValue({ id: "c1", name: "Alpine clearance", status: "DRAFT" });
});

describe("a campaign as the app writes it", () => {
  it("has its definition in its columns", async () => {
    const row = await created(INPUT);

    expect(row).toMatchObject({
      filter: { groups: INPUT.ast.groups, productStatuses: ["ACTIVE", "DRAFT"] },
      segmentId: "seg-1",
      rounding: INPUT.rounding,
      practice: true,
    });
  });

  it("has none of it in its schedule JSON (#1141)", async () => {
    const row = await created(INPUT);

    expect(row.schedule).toEqual({ kind: "manual" });
    for (const key of COPIED_KEYS) expect(row.schedule, key).not.toHaveProperty(key);
  });

  it("keeps the window and its own record there, and only those", async () => {
    const startAt = "2026-11-27T09:00:00.000Z";
    const confirmation = { by: "staff:1", at: "2026-10-30T09:00:00.000Z" } as never;
    const row = await created({ ...INPUT, practice: undefined, schedule: { kind: "window", startAt }, startConfirmed: confirmation });

    expect(row.schedule).toEqual({ kind: "window", startAt, [START_CONFIRMED_KEY]: confirmation });
    expect(row.status).toBe("SCHEDULED");
  });

  it("writes no segment and not practice as the columns' defaults", async () => {
    const row = await created({ ...INPUT, segmentId: undefined, practice: undefined });

    expect(row).toMatchObject({ segmentId: null, practice: false });
    expect(readings(row as never)).toMatchObject({ segmentId: null, practice: false });
  });

  it("is planned before it is saved from the same columns (#1009)", async () => {
    const unsaved = await unsavedCampaign("shop", INPUT);
    const row = await created(INPUT);

    expect(readings(unsaved as never)).toEqual(readings(row as never));
    expect(unsaved).toMatchObject({ segmentId: "seg-1", practice: true, rounding: INPUT.rounding, schedule: { kind: "manual" } });
  });

  it("writes a null rounding as a database null, not as JSON null", async () => {
    const row = await created({ ...INPUT, rounding: undefined as never });

    expect(row.rounding).toBe(Prisma.DbNull);
    expect(readings({ ...row, rounding: null } as never).rounding).toEqual(roundingFor(null));
  });
});

describe("reading a definition: the columns alone (#1141)", () => {
  it("ignores a blob that still holds a copy, as one #884's release wrote may", () => {
    // #884's release writes the copy beside the columns, and a rollback to it, or a write of
    // its while this deploys, leaves one behind. Nothing reads it, even where it disagrees
    // with a column at its default.
    const stale = {
      filter: { groups: [{ conditions: [{ field: "vendor", value: "Burton" }] }], productStatuses: ["DRAFT"] },
      segmentId: null,
      rounding: null,
      practice: false,
      schedule: {
        kind: "manual",
        ast: { groups: [] },
        productStatuses: ["ACTIVE"],
        segmentId: "seg-blob",
        rounding: "charm99",
        practice: true,
      },
    } as never;

    expect(readings(stale)).toEqual({
      ast: { groups: [{ conditions: [{ field: "vendor", value: "Burton" }] }], productStatuses: ["DRAFT"] },
      productStatuses: ["DRAFT"],
      segmentId: null,
      practice: false,
      rounding: roundingFor(null),
    });
  });

  it("reads a definition with no schedule at all, which `DEFINITION` no longer selects", () => {
    expect(DEFINITION).not.toHaveProperty("schedule");
    const columns = { filter: { groups: [] }, segmentId: "seg-1", rounding: "charm99", practice: true } as never;
    expect(readings(columns)).toEqual({
      ast: { groups: [], productStatuses: ["ACTIVE"] },
      productStatuses: ["ACTIVE"],
      segmentId: "seg-1",
      practice: true,
      rounding: roundingFor("charm99"),
    });
  });

  it("reads the columns' defaults as answers: active products only, no segment, no rounding, not practice", () => {
    // A filter with no statuses is a campaign from before #751, which covered the archive
    // because nobody asked; null is a filter nothing since #884 writes, read as no conditions.
    for (const filter of [{ groups: [] }, null]) {
      const campaign = { filter, segmentId: null, rounding: null, practice: false } as never;
      expect(astOf(campaign)).toEqual({ groups: [], productStatuses: ["ACTIVE"] });
      expect(readings(campaign)).toMatchObject({ segmentId: null, practice: false, rounding: roundingFor(null) });
    }
  });

  it("finds practice campaigns in a query by the column alone", () => {
    expect(IS_PRACTICE).toEqual({ practice: true });
  });
});

describe("writing a definition", () => {
  const DEFINED: Definition = {
    filter: { groups: [], productStatuses: ["ACTIVE"] },
    segmentId: null,
    rounding: null,
    practice: false,
  };

  it("writes its four columns and no schedule (#1141)", () => {
    expect(Object.keys(definitionData(DEFINED)).sort()).toEqual(Object.keys(DEFINITION).sort());
    expect(definitionData(DEFINED)).toEqual({ filter: DEFINED.filter, segmentId: null, rounding: Prisma.DbNull, practice: false });
  });

  it("names no column after a key of the blob's own record", () => {
    const own: readonly string[] = OWN_KEYS;
    expect(Object.keys(DEFINITION).filter((key) => own.includes(key))).toEqual([]);
  });

  it("round-trips through the readers", () => {
    const defined: Definition = { ...DEFINED, segmentId: "seg-2", rounding: "nearest100", practice: true };
    const data = definitionData(defined);
    const row = { ...data, rounding: data.rounding === Prisma.DbNull ? null : data.rounding } as never;

    expect(campaignDefinition(row)).toEqual(defined);
  });
});
