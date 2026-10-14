/**
 * The typed confirmation asks about how deep a campaign cuts, not only how many prices it
 * writes, and Settings decides both numbers (A-3.11, #818).
 *
 * It counted rows and nothing else: over 1,000 written prices the Apply dialog asked for
 * "apply" to be typed, under it nothing did. So 95% off a handful of variants -- a typo for
 * 9.5%, or an exact price on the wrong collection -- applied from a one-click dialog.
 * "Reduce by 150%" took every price in scope to one cent, and a fixed reduction larger than
 * the prices did the same, with a strike-through from the real price.
 *
 * Through the real preview -- the object the Apply dialog renders -- and the campaign page's
 * own action, as Apply posts it, with only `authenticate.admin` replaced. Settings are saved
 * through the Settings page's own action.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { percentText } from "../../app/lib/campaigns/blast-radius";
import { money } from "../../app/lib/money/money";
import { previewCampaign } from "../../app/services/campaigns/preview.server";
import { BLAST_RADIUS_THRESHOLD } from "../../app/services/campaigns/types";
import { readSettings } from "../../app/services/settings.server";
import type { JobRef, QueueName } from "../../app/worker/queues";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos } from "../harness/scenario";

let pending = { shop: "", endpoint: "", staff: "" };
const enqueued: Array<{ name: QueueName; ref: JobRef }> = [];

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({
      session: { shop: pending.shop },
      sessionToken: pending.staff ? { sub: pending.staff } : undefined,
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

// Nothing here is large enough to leave the request, and a job that did would land in the
// local Redis rather than fail: recorded instead, and asserted empty.
vi.mock("../../app/worker/web-queue.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/worker/web-queue.server")>()),
  webQueue: () => ({
    async enqueue(name: QueueName, ref: JobRef) {
      enqueued.push({ name, ref });
    },
    async depths() {
      return {};
    },
    async close() {},
  }),
}));

vi.mock("../../app/services/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../app/services/admin-client.server")>();
  return { ...actual, adminClientForShop: async () => chaosAdminClient(pending.endpoint) };
});

type Answer = { ok: boolean; message: string };

/** A press on the campaign page, as its buttons post it: the intent, and what was typed. */
async function press(intent: string, campaignId: string, confirmation?: string): Promise<Answer> {
  const { action } = await import("../../app/routes/app.campaigns.$id");
  const body = new FormData();
  body.set("intent", intent);
  if (confirmation !== undefined) body.set("confirmation", confirmation);
  const response = await action({
    request: new Request(`https://example.invalid/app/campaigns/${campaignId}`, { method: "POST", body }),
    params: { id: campaignId },
    context: {},
  } as never);
  return (response instanceof Response ? await response.json() : response) as Answer;
}

/**
 * A Settings save by this staff member, posting every field the page renders, as stored,
 * with these changed and those in `omit` left out.
 */
async function save(
  shopId: string,
  staff: string,
  fields: Record<string, string>,
  omit: string[] = [],
): Promise<Answer & { problems: string[] }> {
  const { action } = await import("../../app/routes/app.settings._index");
  pending = { ...pending, staff };
  const current = await readSettings(shopId);
  const page: Record<string, string> = {
    minMarginPercent: current.minMarginPercent?.toString() ?? "",
    minPrice: current.minPrice?.toString() ?? "",
    violationPolicy: current.violationPolicy,
    missingCostPolicy: current.missingCostPolicy,
    "rounding.default": current.rounding.default,
    approvalThreshold: current.approvalThreshold?.toString() ?? "",
    confirmAboveVariants: current.confirmAboveVariants.toString(),
    confirmAboveChangePercent: current.confirmAboveChangePercent.toString(),
    email: "",
    ...fields,
  };
  const body = new FormData();
  for (const [key, value] of Object.entries(page)) if (!omit.includes(key)) body.set(key, value);
  return (await action({
    request: new Request("https://example.invalid/app/settings", { method: "POST", body }),
    params: {},
    context: {},
  } as never)) as Answer & { problems: string[] };
}

/** The thresholds' own audit entries, oldest first. */
const confirmationEntries = (shopId: string) =>
  prisma.auditLogEntry.findMany({
    where: { shopId, action: "settings.confirmation.update" },
    orderBy: { createdAt: "asc" },
    select: { actor: true, before: true, after: true },
  });

const status = async (id: string) => (await prisma.campaign.findUniqueOrThrow({ where: { id } })).status;
const runsOf = (campaignId: string) => prisma.campaignRun.count({ where: { campaignId } });

describe("chaos: the typed confirmation reads the depth of a change (#818)", () => {
  it("asks for 95% off eight variants, names how many and the largest, and refuses the Apply without the word", async () => {
    await withChaos("blast-radius-depth", { catalog: { products: 8, variantsPerProduct: 1 }, percent: -95 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint(), staff: "" };
      enqueued.length = 0;
      const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
      const sale = (gid: string) => (Math.round(baseline.get(gid)! * 0.05) / 100).toFixed(2);
      const untouched = () => variantGids.every((gid) => chaos.fake.priceOf(gid) === full(gid));

      // The dialog's data: under every count, over the change threshold, every row named.
      const preview = await previewCampaign(shopId, campaignId);
      expect(preview.counts.planned).toBe(8);
      expect(preview.counts.planned, "the count alone would not have asked").toBeLessThan(BLAST_RADIUS_THRESHOLD);
      expect(preview.blastRadius, "95% off eight variants applied from a one-click dialog").toBe(true);
      expect(preview.confirm).toMatchObject({
        thresholds: { variants: 1_000, changePercent: 50 },
        planned: 8,
        largeChanges: 8,
        atMinimum: 0,
      });
      const largest = preview.confirm!.largest!;
      expect(largest.direction).toBe("down");
      expect(percentText(largest.basisPoints)).toBe("95%");
      expect(variantGids, "the largest is not named by its title").toContain(largest.title);
      expect(largest.before).toBe(`$${full(largest.title)}`);
      expect(largest.after).toBe(`$${sale(largest.title)}`);

      // Apply without the word, and with a near miss: refused, in the dialog's sentences,
      // and nothing is written or even started.
      for (const typed of [undefined, "", "appl"]) {
        const refused = await press("apply", campaignId, typed);
        expect(refused.ok, `the Apply went through with ${JSON.stringify(typed)} typed`).toBe(false);
        expect(refused.message).toContain("8 prices move more than 50% from their baseline");
        expect(refused.message).toContain(`the largest is “${largest.title}”, down 95%`);
        expect(refused.message).toContain("Type “apply” in the confirmation box");
        expect(refused.message, "the refusal carries a price").not.toContain("$");
      }
      expect(untouched(), "a refused Apply wrote a price").toBe(true);
      expect(await status(campaignId)).toBe("DRAFT");
      expect(await runsOf(campaignId), "a refused Apply started a run").toBe(0);

      // With the word: applied, verified clean, at 95% off.
      const applied = await press("apply", campaignId, "apply");
      expect(applied.ok, applied.message).toBe(true);
      expect(await status(campaignId)).toBe("ACTIVE");
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe(sale(gid));
      await chaos.expectHonest(await chaos.latestRunId("APPLY"));

      // Reverting never asks: it is the way back.
      const reverted = await press("revert", campaignId);
      expect(reverted.ok, reverted.message).toBe(true);
      expect(untouched()).toBe(true);
      expect(enqueued, "a run this small left the request").toEqual([]);
    });
  });

  it("follows the thresholds Settings saves, audit-logs each change, and keeps them through other saves", async () => {
    await withChaos("blast-radius-settings", { catalog: { products: 8, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint(), staff: "" };
      enqueued.length = 0;
      const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
      const untouched = () => variantGids.every((gid) => chaos.fake.priceOf(gid) === full(gid));

      // An ordinary 10% sale on eight variants asks for nothing under the defaults, which
      // a shop whose settings predate the thresholds reads as.
      expect(await readSettings(shopId)).toMatchObject({ confirmAboveVariants: 1_000, confirmAboveChangePercent: 50 });
      expect((await previewCampaign(shopId, campaignId)).blastRadius).toBe(false);

      // A small shop lowers the count: stored, logged with who and from what, and the
      // same eight-price sale now asks.
      const lowered = await save(shopId, "alice", { confirmAboveVariants: "5" });
      expect(lowered.ok, lowered.problems.join(" ")).toBe(true);
      expect(await confirmationEntries(shopId)).toEqual([
        { actor: "staff:alice", before: { confirmAboveVariants: 1_000 }, after: { confirmAboveVariants: 5 } },
      ]);
      const counted = await previewCampaign(shopId, campaignId);
      expect(counted.blastRadius, "a lowered count in Settings changed nothing").toBe(true);
      expect(counted.confirm).toMatchObject({ thresholds: { variants: 5 }, planned: 8, largeChanges: 0 });
      const byCount = await press("apply", campaignId);
      expect(byCount.ok).toBe(false);
      expect(byCount.message).toContain("This campaign writes 8 prices, more than the 5 your settings allow");
      expect(untouched()).toBe(true);

      // Another person puts the count back and lowers the change threshold to 5%: one
      // entry naming both, and the 10% sale is now deep enough to ask.
      expect((await save(shopId, "bob", { confirmAboveVariants: "1000", confirmAboveChangePercent: "5" })).ok).toBe(true);
      expect((await confirmationEntries(shopId)).at(-1)).toEqual({
        actor: "staff:bob",
        before: { confirmAboveVariants: 5, confirmAboveChangePercent: 50 },
        after: { confirmAboveVariants: 1_000, confirmAboveChangePercent: 5 },
      });
      const byDepth = await press("apply", campaignId);
      expect(byDepth.ok, "a lowered change threshold in Settings changed nothing").toBe(false);
      expect(byDepth.message).toContain("8 prices move more than 5% from their baseline");
      expect(untouched()).toBe(true);

      // Other saves keep them: one posting the fields as the page shows them, one that
      // does not carry them at all. No threshold entry for either.
      expect((await save(shopId, "alice", { minPrice: "1" })).ok).toBe(true);
      expect((await save(shopId, "alice", { minPrice: "2" }, ["confirmAboveVariants", "confirmAboveChangePercent"])).ok).toBe(true);
      expect(await readSettings(shopId), "an unrelated save moved a threshold").toMatchObject({
        minPrice: 2,
        confirmAboveVariants: 1_000,
        confirmAboveChangePercent: 5,
      });
      expect(await confirmationEntries(shopId), "an unrelated save logged a threshold change").toHaveLength(2);

      // Refused by the field's name, with nothing written: not the thresholds, not the
      // margin typed beside them, no audit entry of any kind.
      const auditBefore = await prisma.auditLogEntry.count({ where: { shopId } });
      const refusals: Array<[Record<string, string>, RegExp]> = [
        [{ confirmAboveVariants: "" }, /^Ask for typed confirmation above \(variants\) must be a whole number of 1 or more, such as the default 1,000\. It is empty\.$/],
        [{ confirmAboveVariants: "0" }, /^Ask for typed confirmation above \(variants\) must be .* “0” is not\.$/],
        [{ confirmAboveChangePercent: "150" }, /^Or when a price moves more than \(%\) must be a whole number from 1 to 100, such as the default 50\. “150” is not\.$/],
        [{ confirmAboveChangePercent: "abc" }, /“abc” is not\.$/],
      ];
      for (const [fields, message] of refusals) {
        const refused = await save(shopId, "alice", { ...fields, minMarginPercent: "30" });
        expect(refused.ok, `${JSON.stringify(fields)} was saved`).toBe(false);
        expect(refused.problems).toHaveLength(1);
        expect(refused.problems[0]).toMatch(message);
        expect(await readSettings(shopId)).toMatchObject({
          minMarginPercent: null,
          confirmAboveVariants: 1_000,
          confirmAboveChangePercent: 5,
        });
      }
      expect(await prisma.auditLogEntry.count({ where: { shopId } }), "a refused save wrote an audit entry").toBe(auditBefore);

      // Back to 50%: the sale applies without the word.
      expect((await save(shopId, "alice", { confirmAboveChangePercent: "50" })).ok).toBe(true);
      const applied = await press("apply", campaignId);
      expect(applied.ok, applied.message).toBe(true);
      expect(await status(campaignId)).toBe("ACTIVE");
      expect(enqueued).toEqual([]);
    });
  });

  it("refuses Reduce by 100% or more in the form, and a stored one in the preview and on the server", async () => {
    await withChaos("blast-radius-free", { catalog: { products: 8, variantsPerProduct: 1 }, percent: -150 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint(), staff: "" };
      enqueued.length = 0;
      const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);
      const untouched = () => variantGids.every((gid) => chaos.fake.priceOf(gid) === full(gid));

      // The form: the editor's create action refuses 100 and 150, naming the field.
      const { action: create } = await import("../../app/routes/app.campaigns.new");
      const { ANCHOR_ERROR } = await import("../../app/lib/errors/guard.server");
      for (const ruleValue of ["100", "150"]) {
        const body = new FormData();
        for (const [key, value] of Object.entries({ name: `Free ${ruleValue}`, ruleKind: "percent-change", ruleValue, ruleDirection: "down" })) {
          body.set(key, value);
        }
        let refused: { code?: string; userMessage?: string } | undefined;
        try {
          await create({ request: new Request("https://example.invalid/app/campaigns/new", { method: "POST", body }), params: {}, context: {} } as never);
        } catch (thrown) {
          refused = (thrown as { data?: Record<string, { code?: string; userMessage?: string }> }).data?.[ANCHOR_ERROR];
        }
        expect(refused?.code, `Reduce by ${ruleValue}% was created`).toBe("VALIDATION");
        expect(refused?.userMessage).toMatch(new RegExp(`^A ${ruleValue}% reduction would make every price free or negative`));
        expect(await prisma.campaign.count({ where: { shopId, name: `Free ${ruleValue}` } })).toBe(0);
      }

      // The server: a campaign stored with Reduce by 150% -- made before the form refused
      // it, or by a path that skipped the form -- is refused by the preview, by Apply even
      // with the word typed, and by the run itself, which the scheduler and Flow reach
      // without the page.
      for (const percent of [-150, -100]) {
        await prisma.campaign.update({
          where: { id: campaignId },
          data: { ruleRows: [{ segmentIds: [], rule: { kind: "percent-change", percent } }] },
        });
        const said = `This campaign reduces prices by ${-percent}%, which would make every price free or negative`;

        const preview = await previewCampaign(shopId, campaignId);
        expect(preview.refused, `the preview offers an Apply of ${percent}%`).toMatch(new RegExp(`^${said}`));

        const pressed = await press("apply", campaignId, "apply");
        expect(pressed.ok, `Reduce by ${-percent}% applied with the word typed`).toBe(false);
        expect(pressed.message).toMatch(new RegExp(`^${said}`));

        await expect(chaos.apply(), "the run path priced it").rejects.toThrow(new RegExp(said));
        expect(untouched(), `Reduce by ${-percent}% wrote a price`).toBe(true);
        expect(await status(campaignId)).toBe("DRAFT");
        expect(await runsOf(campaignId)).toBe(0);
      }
      expect(enqueued).toEqual([]);
    });
  });

  it("asks when a campaign would take more than a handful of prices to the smallest price, whatever the change threshold", async () => {
    await withChaos("blast-radius-minimum", { catalog: { products: 8, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, domain, campaignId, variantGids, baseline } = chaos.fixture;
      pending = { shop: domain, endpoint: chaos.server.endpoint(), staff: "" };
      enqueued.length = 0;
      const full = (gid: string) => (baseline.get(gid)! / 100).toFixed(2);

      // $200 off prices of $10 to $110: every one would go below zero and is written at
      // 0.01 instead. The change threshold is raised as far as it goes, so the depth
      // test cannot be what asks.
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { ruleRows: [{ segmentIds: [], rule: { kind: "fixed-change", amount: { ...money(-20_000, "USD") } } }] },
      });
      expect((await save(shopId, "alice", { confirmAboveChangePercent: "100" })).ok).toBe(true);

      const preview = await previewCampaign(shopId, campaignId);
      expect(preview.counts.clampedToMinimum).toBe(8);
      expect(preview.confirm).toMatchObject({ largeChanges: 0, atMinimum: 8, thresholds: { changePercent: 100 } });
      expect(preview.blastRadius, "eight prices at one cent applied from a one-click dialog").toBe(true);

      const refused = await press("apply", campaignId);
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("8 prices would reach zero or below, and would be written at the smallest price instead.");
      expect(variantGids.every((gid) => chaos.fake.priceOf(gid) === full(gid))).toBe(true);

      const applied = await press("apply", campaignId, "apply");
      expect(applied.ok, applied.message).toBe(true);
      for (const gid of variantGids) expect(chaos.fake.priceOf(gid)).toBe("0.01");
      expect(enqueued).toEqual([]);
    });
  });
});
