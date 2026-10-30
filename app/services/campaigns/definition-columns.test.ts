/**
 * What a campaign prices, in columns of its own and, for one release, in its schedule JSON
 * too (#884).
 *
 * Pinned here: that every writer writes both halves and they agree; that every reader takes
 * the column first and the blob only where the column is at its default; and that a row the
 * release before wrote -- definition in the blob, columns at null and false -- reads exactly
 * as it did. The chaos scenario `definition-columns` runs the migration's backfill against
 * rows of every shape the blob has held, and compares these readers before and after.
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

import { DEFINITION_KEYS, OWN_KEYS, WINDOW_KEYS } from "../../lib/campaigns/schedule-blob";
import { START_CONFIRMED_KEY } from "../../lib/campaigns/start-confirmation";
import {
  astOf,
  campaignDefinition,
  createCampaign,
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

/** A row as this release stores it, from what `createCampaign` handed Prisma. */
async function created(input: CampaignInput) {
  await createCampaign("shop", input);
  return prisma.campaign.create.mock.calls.at(-1)![0].data as Record<string, unknown>;
}

/** The row's columns, at their defaults, as the release before leaves them: its blob alone. */
const blobOnly = (row: Record<string, unknown>) =>
  ({ ...row, filter: null, segmentId: null, rounding: null, practice: false }) as never;
/** The row's columns alone, with a blob holding the window only: what the contract reads. */
const columnsOnly = (row: Record<string, unknown>) => {
  const schedule = { ...(row.schedule as Record<string, unknown>) };
  for (const key of DEFINITION_KEYS) delete schedule[key];
  return { ...row, schedule } as never;
};

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

describe("a campaign as this release writes it", () => {
  it("has its definition in its columns", async () => {
    const row = await created(INPUT);

    expect(row).toMatchObject({
      filter: { groups: INPUT.ast.groups, productStatuses: ["ACTIVE", "DRAFT"] },
      segmentId: "seg-1",
      rounding: INPUT.rounding,
      practice: true,
    });
  });

  it("has the same definition in its blob, where the release before reads it", async () => {
    const row = await created(INPUT);

    // The blob's shape is the one that release reads: `ast` without the statuses, beside it.
    expect(row.schedule).toEqual({
      kind: "manual",
      ast: { groups: INPUT.ast.groups },
      productStatuses: ["ACTIVE", "DRAFT"],
      segmentId: "seg-1",
      rounding: INPUT.rounding,
      practice: true,
    });
    expect(readings(blobOnly(row))).toEqual(readings(row as never));
    expect(readings(columnsOnly(row))).toEqual(readings(row as never));
  });

  it("leaves out of the blob what the release before never wrote: no segment, not practice", async () => {
    const row = await created({ ...INPUT, segmentId: undefined, practice: undefined });

    expect(row).toMatchObject({ segmentId: null, practice: false });
    expect(row.schedule).not.toHaveProperty("segmentId");
    expect(row.schedule).not.toHaveProperty("practice");
    expect(readings(blobOnly(row))).toEqual(readings(row as never));
  });

  it("keeps the window and its own record beside the blob's definition", async () => {
    const startAt = "2026-11-27T09:00:00.000Z";
    const confirmation = { by: "staff:1", at: "2026-10-30T09:00:00.000Z" } as never;
    const row = await created({ ...INPUT, practice: undefined, schedule: { kind: "window", startAt }, startConfirmed: confirmation });

    expect(row.schedule).toMatchObject({ kind: "window", startAt, [START_CONFIRMED_KEY]: confirmation });
    expect(row.status).toBe("SCHEDULED");
  });

  it("is planned before it is saved from the same columns (#1009)", async () => {
    const unsaved = await unsavedCampaign("shop", INPUT);
    const row = await created(INPUT);

    expect(readings(unsaved as never)).toEqual(readings(row as never));
    expect(unsaved).toMatchObject({ segmentId: "seg-1", practice: true, rounding: INPUT.rounding });
  });

  it("writes a null rounding as a database null, not as JSON null", async () => {
    const row = await created({ ...INPUT, rounding: undefined as never });

    expect(row.rounding).toBe(Prisma.DbNull);
    expect(row.schedule).not.toHaveProperty("rounding");
  });
});

describe("a campaign the release before wrote: its columns at their defaults", () => {
  const BLOB = {
    filter: null,
    segmentId: null,
    rounding: null,
    practice: false,
    schedule: {
      kind: "manual",
      ast: { groups: [{ conditions: [{ field: "tag", value: "alpine" }] }] },
      productStatuses: ["ACTIVE", "ARCHIVED"],
      segmentId: "seg-1",
      rounding: { default: "charm95", byCurrency: {} },
      practice: true,
    },
  } as never;

  it("is read from its blob", () => {
    expect(astOf(BLOB)).toEqual({ groups: [{ conditions: [{ field: "tag", value: "alpine" }] }], productStatuses: ["ACTIVE", "ARCHIVED"] });
    expect(segmentIdOf(BLOB)).toBe("seg-1");
    expect(isPractice(BLOB)).toBe(true);
    expect(readings(BLOB).rounding).toEqual(roundingFor({ default: "charm95", byCurrency: {} }));
  });

  it("is read the same with no columns at all, as a caller holding only the blob has", () => {
    const { schedule } = BLOB as { schedule: unknown };
    expect(readings({ schedule } as never)).toEqual(readings(BLOB));
  });

  it("is read as it always was in every shape the blob has held", () => {
    // Before #751, no statuses: active only. Before per-currency rounding, a bare name.
    // Before rounding, none. A filter that was never written: every variant.
    const old = { filter: null, segmentId: null, rounding: null, practice: false, schedule: { kind: "manual", rounding: "charm99" } } as never;
    expect(astOf(old)).toEqual({ groups: [], productStatuses: ["ACTIVE"] });
    expect(readings(old).rounding).toEqual(roundingFor("charm99"));
    expect(readings({ ...(old as object), schedule: { kind: "manual" } } as never).rounding).toEqual(roundingFor(undefined));

    // Statuses inside `ast` were never what `astOf` read: the blob's own list, or the default.
    const inside = { schedule: { ast: { groups: [], productStatuses: ["DRAFT"] } } } as never;
    expect(productStatusesFor(inside)).toEqual(["ACTIVE"]);
    // Practice only for a JSON true.
    expect(isPractice({ practice: false, schedule: { practice: "true" } } as never)).toBe(false);
  });
});

describe("the column first", () => {
  it("wins over a blob that says otherwise, wherever it is off its default", () => {
    // Not a state any release writes -- the two always agree -- but the order is the rule:
    // a column off its default was written by this release, and the blob cannot know better.
    const disagreeing = {
      filter: { groups: [{ conditions: [{ field: "vendor", value: "Burton" }] }], productStatuses: ["DRAFT"] },
      segmentId: "seg-column",
      rounding: "whole",
      practice: true,
      schedule: { ast: { groups: [] }, productStatuses: ["ACTIVE"], segmentId: "seg-blob", rounding: "charm99" },
    } as never;

    expect(astOf(disagreeing)).toEqual({ groups: [{ conditions: [{ field: "vendor", value: "Burton" }] }], productStatuses: ["DRAFT"] });
    expect(segmentIdOf(disagreeing)).toBe("seg-column");
    expect(isPractice(disagreeing)).toBe(true);
    expect(readings(disagreeing).rounding).toEqual(roundingFor("whole"));
  });

  it("takes a filter column with no statuses as no statuses recorded, not the blob's", () => {
    const column = { filter: { groups: [] }, schedule: { productStatuses: ["DRAFT"] } } as never;
    expect(productStatusesFor(column)).toEqual(["ACTIVE"]);
  });

  it("finds practice campaigns in a query the same way", () => {
    expect(IS_PRACTICE).toEqual({ OR: [{ practice: true }, { schedule: { path: ["practice"], equals: true } }] });
  });
});

describe("writing a definition over a blob", () => {
  const DEFINED: Definition = {
    filter: { groups: [], productStatuses: ["ACTIVE"] },
    segmentId: null,
    rounding: null,
    practice: false,
  };

  it("replaces whatever the blob held of one, and nothing else", () => {
    const stale = {
      kind: "window",
      startAt: "2026-11-27T09:00:00.000Z",
      zone: "Europe/London",
      ast: { groups: [{ conditions: [] }] },
      productStatuses: ["DRAFT"],
      segmentId: "seg-old",
      rounding: "charm99",
      practice: true,
      [OWN_KEYS[0]]: { by: "staff:1" },
    };

    const { schedule } = definitionData(stale, DEFINED);

    expect(schedule).toEqual({
      kind: "window",
      startAt: "2026-11-27T09:00:00.000Z",
      zone: "Europe/London",
      [OWN_KEYS[0]]: { by: "staff:1" },
      ast: { groups: [] },
      productStatuses: ["ACTIVE"],
    });
  });

  it("names no key that is also a window key or the campaign's own", () => {
    const others: readonly string[] = [...WINDOW_KEYS, ...OWN_KEYS];
    expect(DEFINITION_KEYS.filter((key) => others.includes(key))).toEqual([]);
  });

  it("does not touch the blob it is handed", () => {
    const blob = { kind: "manual", practice: true };
    definitionData(blob, DEFINED);
    expect(blob).toEqual({ kind: "manual", practice: true });
  });

  it("round-trips through the readers", () => {
    const defined: Definition = { ...DEFINED, segmentId: "seg-2", rounding: "nearest100", practice: true };
    const data = definitionData({ kind: "manual" }, defined);
    const row = { ...data, rounding: data.rounding === Prisma.DbNull ? null : data.rounding } as never;

    expect(campaignDefinition(row)).toEqual(defined);
    expect(campaignDefinition(blobOnly(row))).toEqual(defined);
  });
});
