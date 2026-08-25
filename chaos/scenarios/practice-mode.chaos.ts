/**
 * A practice campaign, and the promise that it writes nothing.
 *
 * Practice mode exists for the merchant with fifty thousand products who is not going
 * to risk a live price to find out what the app does — which is exactly the merchant
 * worth converting. They are told, in those words, that nothing will be written.
 *
 * A promise like that is only worth making if it is impossible to break by accident, so
 * it is enforced in `runCampaign` — the one function that writes prices — rather than
 * by hiding a button. This proves it holds when the button is bypassed entirely.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { withChaos } from "../harness/scenario";

describe("chaos: practice mode", () => {
  it("refuses to run at all, and leaves every price untouched", async () => {
    await withChaos(
      "practice-mode",
      { catalog: { products: 5, variantsPerProduct: 2 }, percent: -30 },
      async (chaos) => {
        const { campaignId, variantGids, baseline } = chaos.fixture;

        const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { schedule: { ...(campaign.schedule as object), practice: true } as never },
        });

        // Called directly, as a scheduler tick or a stray caller would — not through
        // the UI that knows to hide the button.
        await expect(chaos.apply()).rejects.toThrow(/practice campaign/i);

        // Nothing written, nothing planned, nothing even attempted.
        expect(chaos.fake.writeLog).toHaveLength(0);
        for (const gid of variantGids) {
          expect(chaos.fake.priceOf(gid)).toBe((baseline.get(gid)! / 100).toFixed(2));
        }

        // And no run row either. A practice campaign showing a run in its history
        // would suggest something happened, which is the impression the whole feature
        // exists to avoid.
        expect(await prisma.campaignRun.count({ where: { campaignId } })).toBe(0);

        // The campaign is not left mid-transition. Refusing before the state machine
        // moves is what keeps it clean.
        const after = await prisma.campaign.findUniqueOrThrow({
          where: { id: campaignId },
          select: { status: true },
        });
        expect(after.status).toBe("DRAFT");
      },
    );
  });

  it("runs normally once it is no longer practice", async () => {
    // The guard has to be about the flag, not about something incidental to how the
    // fixture is built -- otherwise it might be refusing for the wrong reason.
    await withChaos(
      "practice-mode-cleared",
      { catalog: { products: 3, variantsPerProduct: 1 }, percent: -30 },
      async (chaos) => {
        const outcome = await chaos.apply();
        await chaos.expectHonest(outcome.runId);
        expect(outcome.verified).toBe(3);
      },
    );
  });
});
