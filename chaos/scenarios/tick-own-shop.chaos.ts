/**
 * A scenario's scheduler tick leaves other shops' campaigns alone (#881).
 *
 * `tick` reads every shop in the database, and scenarios handed the fake's client to any
 * domain. Locally the database holds the dev stores' real campaigns: a due one there was
 * run against this scenario's fake server, which called its variants deleted, and the real
 * campaign was marked COMPLETED in the local database while Shopify still showed its sale.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { money } from "../../app/lib/money/money";
import { createCampaign } from "../../app/services/campaigns/model.server";
import { fixtureAdminClient, withChaos } from "../harness/scenario";

let endpoint = "";
vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, endpoint) };
});

/** A window that opened five minutes ago: the next tick applies it. */
function dueWindow() {
  const startAt = new Date(Date.now() - 5 * 60_000);
  const endAt = new Date(Date.now() + 24 * 60 * 60_000);
  return { startAt, endAt, schedule: { kind: "window", startAt: startAt.toISOString(), endAt: endAt.toISOString() } };
}

describe("chaos: a scenario's scheduler tick", () => {
  it("runs its own shop's due campaign and leaves another shop's alone", async () => {
    await withChaos("tick-own-shop", { catalog: { products: 1, variantsPerProduct: 1 }, percent: -20 }, async (chaos) => {
      endpoint = chaos.server.endpoint();
      const { campaignId } = chaos.fixture;

      // A shop that is not this scenario's: a dev store's, with a campaign due now.
      const other = await prisma.shop.create({ data: { domain: `not-a-fixture-${Date.now()}.myshopify.com` } });
      try {
        const theirs = await createCampaign(other.id, {
          name: "A dev store's real sale",
          rule: { kind: "set-exact", amount: money(100, "USD") },
          compareAtPolicy: { kind: "leave" },
          rounding: { default: "none", byCurrency: {} },
          ast: { groups: [] },
          schedule: { kind: "manual" },
        });
        const window = dueWindow();
        await prisma.campaign.update({
          where: { id: theirs.id },
          data: { status: "SCHEDULED", startAt: window.startAt, endAt: window.endAt, schedule: window.schedule as never },
        });
        // And this scenario's own campaign, due too: the control.
        const own = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            status: "SCHEDULED",
            startAt: window.startAt,
            endAt: window.endAt,
            schedule: { ...(own.schedule as object), ...window.schedule } as never,
          },
        });

        const { tick } = await import("../../app/services/scheduler.server");
        await tick(new Date());

        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status, "the scenario's own campaign did not run").toBe("ACTIVE");
        expect((await prisma.campaign.findUniqueOrThrow({ where: { id: theirs.id } })).status, "another shop's campaign was run against the fake").toBe("SCHEDULED");
        expect(await prisma.campaignRun.count({ where: { campaignId: theirs.id } })).toBe(0);
      } finally {
        await prisma.shop.delete({ where: { id: other.id } });
      }
    });
  });
});
