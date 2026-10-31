/**
 * A recapture during a sale, and the campaign that was running (#781).
 *
 * On DartMode Labs, 25 Sep: "QA Recapture Board" at $100, 20% off, applied to $80 and
 * verified, ledger Before 100.00. The whole catalogue was recaptured over the sale with the
 * typed phrase, and every one of its 3,673 baselines was superseded, the board's at $80. Then
 * the campaign still read "Running, and every row was read back and verified", its preview
 * proposed 80.00 → 64.00, one click on Apply took the board to $64 (36% off) "all verified",
 * and its Revert tab said it reverts to 80.00, with nothing about the $100 the ledger had.
 *
 * Now the recapture leaves alone a baseline its live price already equals, the campaign says it
 * needs a decision, Apply asks for the word and names the compounding (on the page and on the
 * run's own plan), and the revert report gives the price from before the campaign.
 *
 * Driven through the campaign page's own loader and action and the recapture service the page
 * and Flow call. Only `authenticate.admin` and `adminClientForShop` are replaced.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { DANGEROUS_PHRASE, recapturedMessage } from "../../app/lib/baselines/recapture";
import { notBeforeSentence } from "../../app/lib/reporting/rollback";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { planRecapture, recapture } from "../../app/services/recapture.server";
import { redefine } from "../harness/definition";
import { chaosAdminContext } from "../harness/http-client";
import { type ChaosContext, fixtureAdminClient, ledgerOf, withChaos } from "../harness/scenario";

/** A staff member's id, as App Bridge's session token carries it. */
const STAFF = "91614707946";
let pending = { shop: "", endpoint: "" };

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: { sub: STAFF },
      admin: chaosAdminContext(pending.endpoint),
    }),
  },
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async (domain: string) => fixtureAdminClient(domain, pending.endpoint) };
});

const CATALOG = { catalog: { products: 2, variantsPerProduct: 1 }, percent: -20 } as const;

function formOf(fields: Record<string, string>): FormData {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return body;
}

/** The campaign page's action, as its buttons post to it. */
async function press(campaignId: string, fields: Record<string, string>) {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  return (await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body: formOf(fields) }),
    params: { id: campaignId },
    context: {},
  } as never)) as { ok: boolean; message: string };
}

/** The campaign page, as its loader hands it to the browser. */
async function page(campaignId: string) {
  const { loader } = await import("../../app/routes/app.campaigns.$id");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`),
    params: { id: campaignId },
    context: {},
  } as never)) as unknown as Awaited<ReturnType<typeof import("../../app/routes/app.campaigns.$id").loader>>;
}

/** One variant's normal price, $`minor / 100`, everywhere the fixture recorded it. */
async function priceAt(chaos: ChaosContext, variantGid: string, minor: number) {
  const { shopId } = chaos.fixture;
  chaos.fake.variants.get(variantGid)!.price = (minor / 100).toFixed(2);
  chaos.fixture.baseline.set(variantGid, minor);
  await prisma.variantIndex.updateMany({ where: { shopId, variantGid }, data: { price: BigInt(minor) } });
  await prisma.baseline.updateMany({ where: { shopId, variantGid, supersededAt: null }, data: { basePrice: BigInt(minor) } });
  await prisma.priceSurfaceEntry.updateMany({ where: { shopId, variantGid, surfaceKind: "BASE" }, data: { livePrice: BigInt(minor) } });
}

/** A campaign that covers the board only, so the other variant is in a recapture's scope and on no sale. */
async function onlyTheBoard(chaos: ChaosContext) {
  pending = { shop: chaos.fixture.domain, endpoint: chaos.server.endpoint() };
  const [board, other] = chaos.fixture.variantGids;
  await priceAt(chaos, board!, 10_000);
  await redefine(chaos.fixture.campaignId, { ast: { groups: [{ conditions: [{ field: "variantGid", value: [board!] }] }] } });
  return { board: board!, other: other! };
}

const current = (shopId: string, variantGid: string) =>
  prisma.baseline.findFirstOrThrow({ where: { shopId, variantGid, surfaceKind: "BASE", supersededAt: null } });

describe("chaos: a recapture over a running sale (#781)", () => {
  it("leaves unchanged baselines, flags the campaign, asks before compounding, and gives the price before it", async () => {
    await withChaos("recapture-during-sale", CATALOG, async (chaos) => {
      const { shopId, campaignId, domain } = chaos.fixture;
      const { board, other } = await onlyTheBoard(chaos);

      // 1. A 20% sale: $100 to $80, verified, the ledger saying Before 100.00.
      const applied = await press(campaignId, { intent: "apply" });
      expect(applied.ok, applied.message).toBe(true);
      expect(chaos.fake.priceOf(board)).toBe("80.00");
      const [sold] = await ledgerOf(await chaos.latestRunId("APPLY"));
      expect(sold).toMatchObject({ variantGid: board, beforePrice: 10_000n, intendedPrice: 8_000n, status: "VERIFIED" });
      const untouched = await current(shopId, other);

      // 2. The recapture's warning names what it does to the running campaign, not only to future ones.
      const plan = await planRecapture(shopId);
      expect(plan.warning).toContain(
        "That campaign would then read its own sale price as the normal one: applying it again would discount the sale " +
          "price a second time, and reverting would leave the sale price in place instead of the price from before the sale.",
      );

      // The whole catalogue, confirmed: the board's baseline becomes $80, and the other's, already
      // its live price, is left alone and said to be already correct.
      const result = await recapture(shopId, { confirmation: DANGEROUS_PHRASE, actor: `staff:${STAFF}`, expectedScope: plan.scope });
      expect(result).toMatchObject({ scope: 2, captured: 1, superseded: 1, alreadyCurrent: 1 });
      expect(recapturedMessage(result)).toBe("Recaptured 1 baseline across 2 variants, superseding 1. 1 was already correct.");
      expect((await current(shopId, board)).basePrice).toBe(8_000n);
      const left = await current(shopId, other);
      expect(left.id, "a baseline whose price had not changed was superseded").toBe(untouched.id);
      expect(left.capturedAt).toEqual(untouched.capturedAt);
      expect(await prisma.baseline.count({ where: { shopId, variantGid: other } }), "a no-op entry in its history").toBe(1);

      // 3. The campaign is flagged, not "verified".
      const flagged = await page(campaignId);
      expect(flagged.state).toBe("ACTIVE");
      expect(flagged.lifecycle.label).toBe("Active — needs a decision");
      expect(flagged.lifecycle.tone).toBe("warning");
      expect(flagged.lifecycle.explanation).not.toContain("verified");
      expect(flagged.lifecycle.explanation).toContain("the baseline of 1 of its variants was recaptured at the sale price");
      expect(flagged.needsAttention, "the page's banner").toBe(true);
      expect(flagged.preview.recapturedAtSale).toBe(1);

      // 4. Its preview still proposes 80.00 → 64.00, which is why Apply now asks, naming the compounding.
      expect(flagged.preview.rows[0]).toMatchObject({ variantGid: board, status: "pending" });
      expect(flagged.preview.rows[0]!.before).toContain("80.00");
      expect(flagged.preview.rows[0]!.after).toContain("64.00");
      expect(flagged.preview.blastRadius).toBe(true);
      expect(flagged.preview.confirm?.compounding).toEqual({ count: 1, title: board });

      const refused = await press(campaignId, { intent: "apply" });
      expect(refused.ok, "Apply compounded the sale without asking").toBe(false);
      expect(refused.message).toMatch(/would be discounted again: its baseline was recaptured at the sale price.*compounds the discount/);
      expect(refused.message).toContain("Type “apply”");
      expect(chaos.fake.priceOf(board)).toBe("80.00");

      // The run checks its own plan too (rule 4), so a press over a preview that said less is refused.
      await expect(
        runCampaign(shopId, campaignId, fixtureAdminClient(domain, chaos.server.endpoint())!, {
          actor: `staff:${STAFF}`,
          untypedPress: true,
        }),
      ).rejects.toThrow(/compounds the discount/);
      expect(chaos.fake.priceOf(board)).toBe("80.00");
      expect((await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })).status).toBe("ACTIVE");

      // 5. The revert report gives the price the ledger recorded before the campaign.
      const row = flagged.rollback!.rows.find((entry) => entry.variantGid === board)!;
      expect(row.revertsTo).toContain("80.00");
      expect(row.before).toContain("100.00");
      expect(flagged.rollback!.notBefore).toMatchObject({ count: 1, recaptured: 1 });
      expect(notBeforeSentence(flagged.rollback!.notBefore)).toMatch(
        /^1 variant reverts to a different price from the one the ledger recorded before this campaign: “.*” reverts to \$?80\.00, not \$?100\.00\. Its baseline was recaptured at this campaign's sale price/,
      );

      // Typed anyway, the compounding happens as the merchant was told, and the campaign still
      // says so: its baseline is still the first sale price, and the report still has $100.
      const typed = await press(campaignId, { intent: "apply", confirmation: "apply" });
      expect(typed.ok, typed.message).toBe(true);
      expect(chaos.fake.priceOf(board)).toBe("64.00");
      const compounded = await page(campaignId);
      expect(compounded.lifecycle.label).toBe("Active — needs a decision");
      expect(compounded.rollback!.rows.find((entry) => entry.variantGid === board)!.before).toContain("100.00");
    });
  });

  it("says nothing new of a sale nobody recaptured under, and reverts it to its baseline", async () => {
    await withChaos("recapture-during-sale-none", CATALOG, async (chaos) => {
      const { campaignId } = chaos.fixture;
      const { board } = await onlyTheBoard(chaos);

      const applied = await press(campaignId, { intent: "apply" });
      expect(applied.ok, applied.message).toBe(true);

      const live = await page(campaignId);
      expect(live.lifecycle.label).toBe("Active");
      expect(live.lifecycle.explanation).toContain("every row was read back and verified");
      expect(live.needsAttention).toBe(false);
      expect(live.preview.recapturedAtSale).toBe(0);
      expect(live.preview.confirm?.compounding).toBeUndefined();
      expect(live.rollback!.notBefore).toBeUndefined();
      expect(live.rollback!.rows.find((entry) => entry.variantGid === board)!.before).toBeNull();

      // Applying again asks nothing and changes nothing: every price is computed from its baseline.
      const again = await press(campaignId, { intent: "apply" });
      expect(again.ok, again.message).toBe(true);
      expect(chaos.fake.priceOf(board)).toBe("80.00");

      const reverted = await press(campaignId, { intent: "revert" });
      expect(reverted.ok, reverted.message).toBe(true);
      expect(chaos.fake.priceOf(board)).toBe("100.00");
    });
  });
});
