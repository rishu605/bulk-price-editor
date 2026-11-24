/**
 * A campaign keeps the store's floor-breach policy from the move that starts it (#789).
 *
 * Until then it is planned with the store's setting as it is, and the run plans after the
 * campaign has moved to Applying -- so the move itself has to write it, or a campaign made
 * under Clamp and previewed blocked under Block would be run clamping. Both ways into a state
 * with prices live write it: `transitionCampaign` (a press, Flow, the worker's claim) and
 * `claimForSchedule` (a scheduled start). A move between running states writes nothing: a
 * resume or a held campaign's re-apply keeps what it started with.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { prisma, readSettings } = vi.hoisted(() => ({
  prisma: {
    campaign: { findFirstOrThrow: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    campaignRun: { create: vi.fn() },
    auditLogEntry: { create: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
  readSettings: vi.fn(),
}));
vi.mock("../../db.server", () => ({ default: prisma }));
vi.mock("../settings.server", () => ({ readSettings }));

import { claimForQueue, claimForSchedule, transitionCampaign } from "./lifecycle.server";

const SHOP = "shop_1";

beforeEach(() => {
  vi.clearAllMocks();
  readSettings.mockResolvedValue({ violationPolicy: "block" });
  prisma.campaign.updateMany.mockResolvedValue({ count: 1 });
  prisma.auditLogEntry.findFirst.mockResolvedValue(null);
  prisma.campaignRun.create.mockResolvedValue({ id: "run_1" });
  prisma.$transaction.mockImplementation((work: (tx: typeof prisma) => unknown) => work(prisma));
});

const written = () => prisma.campaign.updateMany.mock.calls[0]![0].data;

describe("the move that starts a campaign writes the store's policy beside the status", () => {
  it.each(["DRAFT", "SCHEDULED", "COMPLETED"])("from %s, by hand", async (from) => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ status: from });
    await transitionCampaign(SHOP, "c1", "APPLYING", { reason: "apply requested", actor: "staff:1" });
    expect(written()).toEqual({ status: "APPLYING", guardrailViolationPolicy: "block" });
  });

  it("at a scheduled start", async () => {
    prisma.campaign.findFirst.mockResolvedValue({ status: "SCHEDULED" });
    await claimForSchedule(SHOP, "c1", "apply", "system");
    expect(written()).toEqual({ status: "APPLYING", guardrailViolationPolicy: "block" });
  });

  it("when a press is claimed for the queue", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ status: "DRAFT" });
    await claimForQueue(SHOP, "c1", "APPLYING", QUEUED, { reason: "apply requested", actor: "staff:1" });
    expect(written()).toEqual({ status: "APPLYING", guardrailViolationPolicy: "block" });
  });
});

/** A press over fifty variants, which the worker writes (#808). */
const QUEUED = { kind: "APPLY" as const, plannedRows: 500, request: {} };

describe("a campaign with a policy of its own keeps that one instead (#816)", () => {
  const guardrails = { violationPolicy: "clamp" };

  it("pressed by hand", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ status: "DRAFT", guardrails });
    await transitionCampaign(SHOP, "c1", "APPLYING", { reason: "apply requested", actor: "staff:1" });
    expect(written()).toEqual({ status: "APPLYING", guardrailViolationPolicy: "clamp" });
  });

  it("at a scheduled start", async () => {
    prisma.campaign.findFirst.mockResolvedValue({ status: "SCHEDULED", guardrails });
    await claimForSchedule(SHOP, "c1", "apply", "system");
    expect(written()).toEqual({ status: "APPLYING", guardrailViolationPolicy: "clamp" });
  });

  it("claimed for the queue, which the worker then plans under", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ status: "DRAFT", guardrails });
    await claimForQueue(SHOP, "c1", "APPLYING", QUEUED, { reason: "apply requested", actor: "staff:1" });
    expect(written()).toEqual({ status: "APPLYING", guardrailViolationPolicy: "clamp" });
    expect(readSettings).not.toHaveBeenCalled();
  });
});

describe("a campaign already running keeps the one it started with", () => {
  it.each(["ACTIVE", "HELD", "PARTIAL"])("re-applied from %s", async (from) => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ status: from });
    await transitionCampaign(SHOP, "c1", "APPLYING", { reason: "resume requested", actor: "staff:1" });
    expect(written()).toEqual({ status: "APPLYING" });
    expect(readSettings).not.toHaveBeenCalled();
  });

  it("at a scheduled end", async () => {
    prisma.campaign.findFirst.mockResolvedValue({ status: "ACTIVE" });
    await claimForSchedule(SHOP, "c1", "revert", "system");
    expect(written()).toEqual({ status: "REVERTING" });
  });

  it("and so does a move between states with nothing live", async () => {
    prisma.campaign.findFirstOrThrow.mockResolvedValue({ status: "SCHEDULED" });
    await transitionCampaign(SHOP, "c1", "DRAFT", { reason: "unscheduled", actor: "staff:1" });
    expect(written()).toEqual({ status: "DRAFT" });
  });
});
