/**
 * A merchant's Apply, Revert and Resume are recorded as theirs, not the Scheduler's (#912).
 *
 * The page passed the merchant to the run, and the run dropped them on every move it made:
 * the claim, the finish, the stop part-way. The record fell back to "system", which the page
 * shows as the Scheduler, so "who started this sale?" -- the question an audit trail exists
 * to answer -- read as the app having done it on its own.
 *
 * Through the campaign page's own action, with a session token naming staff user 42.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: "42" },
      admin: {
        async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
          const response = await fetch(pending.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, variables: options?.variables ?? {} }),
          });
          return { json: () => response.json() };
        },
      },
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(pending.endpoint) };
});

async function press(intent: string, campaignId: string) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  body.set("intent", intent);
  body.set("confirmation", "apply");
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as { ok: boolean; message: string };
}

/** Every recorded move of the campaign since `since`, as "actor: from → to". */
async function moves(shopId: string, campaignId: string, since: Date) {
  const entries = await prisma.auditLogEntry.findMany({
    where: { shopId, entityId: campaignId, action: "campaign.transition", createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
  });
  return entries.map((entry) => {
    const before = entry.before as { status?: string } | null;
    const after = entry.after as { status?: string } | null;
    return `${entry.actor}: ${before?.status} → ${after?.status}`;
  });
}

describe("chaos: who pressed Apply, Revert and Resume", () => {
  it("records the merchant on the claim, the finish and the stop part-way", async () => {
    await withChaos("page-actor", { catalog: { products: 4, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, domain, campaignId } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint() };

      const start = new Date(Date.now() - 1000);
      expect((await press("apply", campaignId)).ok).toBe(true);
      expect((await press("revert", campaignId)).ok).toBe(true);
      expect(await moves(shopId, campaignId, start), "a merchant's press was credited to the Scheduler").toEqual([
        "staff:42: DRAFT → APPLYING",
        "staff:42: APPLYING → ACTIVE",
        "staff:42: ACTIVE → REVERTING",
        "staff:42: REVERTING → COMPLETED",
      ]);

      // A revert that stops part-way, and the Resume that finishes it.
      await prisma.campaign.update({ where: { id: campaignId }, data: { status: "DRAFT" } });
      expect((await press("apply", campaignId)).ok).toBe(true);
      const second = new Date();
      chaos.arm([{ fault: "server-error", match: (query) => query.includes("productVariantsBulkUpdate"), after: 1 }]);
      await press("revert", campaignId);
      chaos.heal();
      expect((await press("resume", campaignId)).ok).toBe(true);
      const after = await moves(shopId, campaignId, second);
      expect(after.length).toBeGreaterThan(0);
      for (const move of after) expect(move, "a merchant's press was credited to the Scheduler").toMatch(/^staff:42: /);
      expect(after).toContain("staff:42: PARTIAL → REVERTING");
    });
  });

  it("still records a run nobody pressed -- the scheduler's -- as the system's", async () => {
    await withChaos("page-actor-scheduled", { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      const { shopId, campaignId } = chaos.fixture;
      const start = new Date(Date.now() - 1000);
      await chaos.apply();
      expect(await moves(shopId, campaignId, start)).toEqual(["system: DRAFT → APPLYING", "system: APPLYING → ACTIVE"]);
    });
  });
});
