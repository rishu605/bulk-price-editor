/**
 * The editor's preview says what the run will do.
 *
 * Rule 4: preview and execution share one code path, because a preview that can
 * disagree with execution is worthless. The editor previously honoured that only in the
 * weakest sense — it showed a *count* and five variant names, and to see what happened
 * to a price you had to create the campaign first.
 *
 * Now it prices. Which means the claim has to be checked rather than asserted: this
 * scenario previews a draft, applies the same rule as a real campaign, and compares
 * row for row against the store the fake Shopify actually ends up holding.
 *
 * The case that matters most is overlap. A variant already on sale is exactly where a
 * naive preview lies — it would show a discount off the full price, while the run
 * resolves by priority and does something else.
 */

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";
import { previewDraft } from "../../app/services/campaigns/draft-preview.server";
import { DEFAULT_SETTINGS, writeSettings } from "../../app/services/settings.server";
import { withChaos } from "../harness/scenario";

const RULE = { kind: "percent-change", percent: -20 } as const;
const DRAFT = {
  ast: { groups: [] },
  rule: RULE,
  compareAtPolicy: { kind: "leave" } as const,
  rounding: { default: "none" as const, byCurrency: {} },
  priority: 500,
};

describe("chaos: the editor's preview and the run agree", () => {
  it("prices every row the way the run will", async () => {
    await withChaos(
      "draft-preview",
      { catalog: { products: 4, variantsPerProduct: 3 }, percent: -20 },
      async (ctx) => {
        const { shopId, campaignId } = ctx.fixture;

        // The fixture's campaign uses the same rule, so the draft preview and this
        // campaign's run must reach identical prices. Preview the draft with the
        // fixture campaign not yet applied, so both start from the same baselines.
        const preview = await previewDraft(shopId, DRAFT, 100);

        expect(preview.matched, "the whole catalogue is in scope").toBe(12);
        expect(preview.changing, "a -20% campaign moves every price").toBe(12);
        expect(preview.blocked).toBeNull();

        const predicted = new Map(preview.rows.map((row) => [row.variantGid, row.after]));

        await ctx.apply();

        // What the store actually holds now.
        const live = ctx.livePrices();

        for (const [variantGid, after] of predicted) {
          expect(
            live.get(variantGid),
            `preview promised ${after} for ${variantGid}; the storefront says ` +
              `${live.get(variantGid)}`,
          ).toBe(after);
        }

        await ctx.expectHonest(await ctx.latestRunId("APPLY"));
        // The campaign this ran is the fixture's, not the draft — the draft was never
        // persisted, which is the whole point of previewing one.
        const drafts = await prisma.campaign.count({ where: { shopId, id: "draft" } });
        expect(drafts, "previewing must not create a campaign").toBe(0);
        expect(campaignId).not.toBe("draft");
      },
    );
  });

  it("tells a merchant when their own floor would stop the run", async () => {
    await withChaos(
      "draft-preview-blocked",
      { catalog: { products: 2, variantsPerProduct: 2 }, percent: -20 },
      async (ctx) => {
        const { shopId } = ctx.fixture;

        // Blocking is the merchant's own instruction, and before this it reached them
        // as a thrown error *after* they had committed rather than a sentence while
        // they were still editing.
        await writeSettings(shopId, {
          ...DEFAULT_SETTINGS,
          minPrice: 100_000,
          violationPolicy: "block",
        });

        const blocked = await previewDraft(
          shopId,
          { ...DRAFT, rule: { kind: "percent-change", percent: -90 } },
          100,
        );

        expect(
          blocked.blocked,
          "the merchant's own floor must be reported while editing, not thrown on submit",
        ).not.toBeNull();
        expect(blocked.blocked?.reason).toContain("below-floor");

        // And with the shop set to clamp, the same draft previews clamped prices --
        // which is the point: the preview follows the shop's setting, exactly as the
        // campaign created from it will (#338).
        await writeSettings(shopId, { ...DEFAULT_SETTINGS, minPrice: 100_000 });

        const clamped = await previewDraft(
          shopId,
          { ...DRAFT, rule: { kind: "percent-change", percent: -90 } },
          100,
        );

        expect(clamped.blocked, "clamp does not block").toBeNull();
        expect(clamped.matched).toBe(4);
        expect(
          new Set(clamped.rows.map((row) => row.after)).size,
          "every price clamped to the same floor, which is what clamp means",
        ).toBe(1);
      },
    );
  });

  it("does not promise a price on a variant another campaign owns", async () => {
    await withChaos(
      "draft-preview-overlap",
      { catalog: { products: 3, variantsPerProduct: 2 }, percent: -20 },
      async (ctx) => {
        const { shopId, campaignId } = ctx.fixture;

        // The fixture's campaign runs at priority 900. Make it ACTIVE *without*
        // applying it, so it wins the overlap and its rows are real changes.
        //
        // Applying it first is the version of this test that proves nothing: every row
        // then sits at its campaign price, `planRun` does not emit no-op rows at all,
        // and a preview that wrongly claimed the winner's rows would still report zero
        // changing. Mutation testing is what surfaced that -- the first draft of this
        // scenario passed with the ownership filter deleted.
        await prisma.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });

        const preview = await previewDraft(
          shopId,
          { ...DRAFT, priority: 1, rule: { kind: "percent-change", percent: -50 } },
          100,
        );

        expect(preview.matched, "still in scope").toBe(6);
        expect(
          preview.changing,
          "a lower-priority draft controls nothing, and must not claim to",
        ).toBe(0);
        expect(
          preview.rows,
          "rows belonging to the campaign that actually won must not appear here at all",
        ).toEqual([]);
        expect(preview.alreadyCorrect + preview.skipped).toBe(0);
      },
    );
  });
});
