/**
 * Every email's outcome is kept, the address's changes are attributed, and a test email
 * can be sent on demand (#1119, #1121, #1122).
 *
 * App Review saved an address, reverted a campaign "to trigger the email", and none came:
 * the install could not send, and nothing recorded that it had tried. These hold the
 * sender to saying what it did, every time, without ever letting the saying fail a run.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  audit: [] as { action: string; entity?: string; entityId?: string; actor?: string | null; before?: unknown; after?: unknown }[],
  auditFails: false,
  recentTest: false,
}));

vi.mock("../db.server", () => ({
  default: {
    shop: {
      findUnique: async () => ({ settings: db.settings, domain: "boltify-apps.myshopify.com" }),
      findUniqueOrThrow: async () => ({ settings: db.settings }),
      update: async ({ data }: { data: { settings: Record<string, unknown> } }) => {
        db.settings = data.settings;
      },
    },
    auditLogEntry: {
      create: async ({ data }: { data: (typeof db.audit)[number] }) => {
        if (db.auditFails) throw new Error("database is gone");
        db.audit.push(data);
      },
      findFirst: async () => (db.recentTest ? { id: "a1" } : null),
    },
  },
}));

import {
  DEFAULT_PREFERENCES,
  mailConfigured,
  notify,
  sendTestEmail,
  wants,
  writePreferences,
} from "./notifications.server";
import { NOTIFICATION_DELIVERY, readDelivery } from "../lib/notifications/delivery";
import type { RunNotification } from "../lib/notifications/templates";

const reverted: RunNotification = {
  kind: "revert-completed",
  campaignId: "c1",
  campaignName: "Summer sale",
  counts: { verified: 3, skipped: 0, clamped: 0, failed: 0, unverified: 0 },
};

const recorded = () => {
  const entries = db.audit.filter((entry) => entry.action === NOTIFICATION_DELIVERY);
  return entries.map((entry) => ({ ...readDelivery(entry.after, new Date()), entity: entry.entity, entityId: entry.entityId }));
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("NOTIFICATION_FROM_EMAIL", "anchor@mail.example.com");
  db.settings = { notifications: { ...DEFAULT_PREFERENCES, email: "ops@shop.com" } };
  db.audit = [];
  db.auditFails = false;
  db.recentTest = false;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
});

describe("mailConfigured", () => {
  it("is what notify asks, so Settings cannot promise what the sender will not do", async () => {
    vi.stubEnv("NOTIFICATION_FROM_EMAIL", "");
    expect(mailConfigured()).toBe(false);
    expect(await notify("s1", reverted)).toMatchObject({ sent: false, reason: "unconfigured" });
    vi.stubEnv("NOTIFICATION_FROM_EMAIL", "anchor@mail.example.com");
    expect(mailConfigured()).toBe(true);
  });
});

describe("notify keeps what happened (#1121)", () => {
  it("records a sent email: where it went, about which campaign, for which run", async () => {
    const result = await notify("s1", reverted, { runId: "run_1" });
    expect(result).toEqual({ sent: true, to: "ops@shop.com" });
    expect(recorded()).toEqual([
      expect.objectContaining({
        kind: "revert-completed",
        outcome: "sent",
        to: "ops@shop.com",
        campaign: "Summer sale",
        runId: "run_1",
        entity: "campaign",
        entityId: "c1",
      }),
    ]);
  });

  it("records each reason nothing was sent", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    await notify("s1", reverted);
    vi.stubEnv("RESEND_API_KEY", "re_test");

    db.settings = { notifications: { ...DEFAULT_PREFERENCES, email: null } };
    await notify("s1", reverted);

    db.settings = { notifications: { ...DEFAULT_PREFERENCES, email: "ops@shop.com", onRevert: false } };
    await notify("s1", reverted);

    db.settings = { notifications: { ...DEFAULT_PREFERENCES, email: "ops@shop.com" } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422 }));
    await notify("s1", reverted);

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    await notify("s1", reverted);

    expect(recorded().map(({ outcome, status }) => ({ outcome, status }))).toEqual([
      { outcome: "unconfigured", status: null },
      { outcome: "no-recipient", status: null },
      { outcome: "muted", status: null },
      { outcome: "failed", status: 422 },
      { outcome: "failed", status: null },
    ]);
  });

  it("still answers when the record cannot be written: telling must never become a failure", async () => {
    db.auditFails = true;
    await expect(notify("s1", reverted)).resolves.toEqual({ sent: true, to: "ops@shop.com" });
  });
});

describe("writePreferences names who changed what (#1119)", () => {
  it("records only the fields that moved, with the actor", async () => {
    await writePreferences("s1", { ...DEFAULT_PREFERENCES, email: "new@shop.com", onRevert: false }, "staff:42");
    const entry = db.audit.find((e) => e.action === "settings.notifications.update");
    expect(entry).toMatchObject({
      actor: "staff:42",
      before: { email: "ops@shop.com", onRevert: true },
      after: { email: "new@shop.com", onRevert: false },
    });
  });

  it("writes nothing to the log when a save changed none of them", async () => {
    await writePreferences("s1", { ...DEFAULT_PREFERENCES, email: "ops@shop.com" }, "staff:42");
    expect(db.audit.filter((e) => e.action === "settings.notifications.update")).toEqual([]);
  });
});

describe("the test email (#1122)", () => {
  it("is wanted even with every notification switched off", () => {
    const off = { ...DEFAULT_PREFERENCES, email: "ops@shop.com", onPartialOrFailure: false, onDrift: false, onRevert: false };
    expect(wants(off, { kind: "test", shopName: "s", switchedOn: [] })).toBe(true);
  });

  it("goes to the saved address through notify, and says so", async () => {
    const result = await sendTestEmail("s1", "boltify-apps.myshopify.com");
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Sent to ops@shop.com");

    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0]![1] as { body: string }).body));
    expect(body.to).toEqual(["ops@shop.com"]);
    expect(body.subject).toContain("boltify-apps.myshopify.com");
    expect(body.text).toContain("A campaign was reverted");
    expect(recorded()).toEqual([expect.objectContaining({ kind: "test", outcome: "sent", entity: "shop", entityId: "s1" })]);
  });

  it("asks for an address before there is one", async () => {
    db.settings = { notifications: { ...DEFAULT_PREFERENCES, email: null } };
    const result = await sendTestEmail("s1", "shop");
    expect(result).toEqual({ ok: false, message: expect.stringContaining("Save an address first") });
  });

  it("says Anchor cannot send, as Anchor's problem, when the install is not configured", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    const result = await sendTestEmail("s1", "shop");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("on our side");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends at most one every thirty seconds, and says so", async () => {
    db.recentTest = true;
    const result = await sendTestEmail("s1", "shop");
    expect(result).toEqual({ ok: false, message: expect.stringContaining("less than 30 seconds ago") });
    expect(fetch).not.toHaveBeenCalled();
  });
});
