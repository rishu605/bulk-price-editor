/**
 * A two-person rule for campaigns big enough to matter.
 *
 * The point is not the record — the audit log already has that. It is that a campaign
 * above the threshold physically cannot run until somebody other than its author says so,
 * which means the check has to be in the run path. An approval a scheduler can walk past
 * is not an approval, and a scheduled campaign is exactly where somebody would notice too
 * late.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos, type ChaosContext } from "../harness/scenario";

async function requireApprovalAbove(chaos: ChaosContext, threshold: number) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: chaos.fixture.shopId } });
  await prisma.shop.update({
    where: { id: chaos.fixture.shopId },
    data: {
      settings: { ...((shop.settings ?? {}) as object), approvalThreshold: threshold } as never,
    },
  });
}

describe("chaos: approvals", () => {
  it("refuses to run a large campaign nobody has approved", async () => {
    await withChaos(
      "approval-required",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId } = chaos.fixture;
        await requireApprovalAbove(chaos, 5);

        const result = await chaos.apply();

        expect(result.verified).toBe(0);
        expect(result.messages.join(" ")).toContain("approval");
        // Nothing written and nothing half-written. A refusal has to happen before the
        // first price moves, not after some of them.
        expect(chaos.fake.writeLog).toHaveLength(0);
        expect(await prisma.variantChange.count({ where: { shopId } })).toBe(0);
      },
    );
  });

  it("lets a small campaign run without one", async () => {
    await withChaos(
      "approval-under-threshold",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        await requireApprovalAbove(chaos, 5);

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        expect(applied.verified).toBe(3);
      },
    );
  });

  it("runs once somebody else has approved it", async () => {
    await withChaos(
      "approval-granted",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        await requireApprovalAbove(chaos, 5);

        const { requestApproval, decideApproval } = await import(
          "../../app/services/approvals.server"
        );

        await requestApproval(shopId, campaignId, "alice@example.com");
        await decideApproval(shopId, campaignId, "bob@example.com", "approve");

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);
        expect(applied.verified).toBe(variantGids.length);

        // Who approved it, in the audit log, because that is the question a compliance
        // review asks and the campaign row cannot answer.
        const logged = await prisma.auditLogEntry.findFirst({
          where: { shopId, action: "approval.approved" },
        });
        expect(logged?.actor).toBe("bob@example.com");
      },
    );
  });

  it("refuses to let the author approve their own campaign", async () => {
    await withChaos(
      "approval-self",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;
        await requireApprovalAbove(chaos, 5);

        const { requestApproval, decideApproval, SelfApprovalError } = await import(
          "../../app/services/approvals.server"
        );

        await requestApproval(shopId, campaignId, "alice@example.com");

        // The entire point. Anyone can click a button; what a two-person rule buys is
        // that a second person looked.
        await expect(
          decideApproval(shopId, campaignId, "alice@example.com", "approve"),
        ).rejects.toBeInstanceOf(SelfApprovalError);

        const result = await chaos.apply();
        expect(result.verified).toBe(0);
      },
    );
  });

  it("does not run a campaign that was declined", async () => {
    await withChaos(
      "approval-declined",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId } = chaos.fixture;
        await requireApprovalAbove(chaos, 5);

        const { requestApproval, decideApproval } = await import(
          "../../app/services/approvals.server"
        );

        await requestApproval(shopId, campaignId, "alice@example.com");
        await decideApproval(shopId, campaignId, "bob@example.com", "decline", "Too deep");

        const result = await chaos.apply();

        expect(result.verified).toBe(0);
        // The reason travels with the refusal. "Declined" alone sends somebody to ask
        // around; "declined by Bob: too deep" is actionable.
        expect(result.messages.join(" ")).toContain("Too deep");
      },
    );
  });

  it("asks again when the campaign grows past what was approved", async () => {
    await withChaos(
      "approval-grew",
      { catalog: { products: 10, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId, variantGids } = chaos.fixture;
        await requireApprovalAbove(chaos, 3);

        // Approved while scoped to half the catalogue.
        await prisma.variantIndex.updateMany({
          where: { shopId, variantGid: { in: variantGids.slice(0, 5) } },
          data: { tags: ["chaos", "HALF"] },
        });
        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: {
            schedule: {
              ...(campaign.schedule as object),
              ast: { groups: [{ conditions: [{ field: "tag", value: "HALF" }] }] },
            } as never,
          },
        });

        const { requestApproval, decideApproval } = await import(
          "../../app/services/approvals.server"
        );
        await requestApproval(shopId, campaignId, "alice@example.com");
        await decideApproval(shopId, campaignId, "bob@example.com", "approve");

        // Then widened to the whole catalogue. An approval granted for five products is
        // not an approval for ten.
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { schedule: { ...(campaign.schedule as object), ast: { groups: [] } } as never },
        });

        const result = await chaos.apply();

        expect(result.verified).toBe(0);
        expect(result.messages.join(" ")).toContain("approval");
      },
    );
  });

  it("never asks for approval on a revert", async () => {
    await withChaos(
      "approval-revert",
      { catalog: { products: 8, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const { shopId, campaignId, variantGids, baseline } = chaos.fixture;
        await requireApprovalAbove(chaos, 5);

        const { requestApproval, decideApproval } = await import(
          "../../app/services/approvals.server"
        );
        await requestApproval(shopId, campaignId, "alice@example.com");
        await decideApproval(shopId, campaignId, "bob@example.com", "approve");

        const applied = await chaos.apply();
        await chaos.expectHonest(applied.runId);

        // Approval withdrawn, or simply a new threshold. Ending a sale must never wait
        // for a signature — a storefront left discounted because an approver is on
        // holiday is the same revenue incident as one left discounted by a downgrade.
        await requireApprovalAbove(chaos, 1);

        const reverted = await chaos.revert();
        await chaos.expectHonest(reverted.runId);

        for (const gid of variantGids) {
          expect(Number(chaos.fake.priceOf(gid)!.replace(".", ""))).toBe(baseline.get(gid));
        }
      },
    );
  });
});
