/**
 * The guard's whole job is to be an estimate and a sentence, so both are tested.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { DEFAULT_THRESHOLD } from "../planning/write-path";
import {
  MAX_INLINE_ROWS,
  MS_PER_SYNC_PRODUCT,
  MS_PER_TAGGED_PRODUCT,
  NEVER_INLINE,
  PAGE_INLINE,
  PAGE_INLINE_BUDGET_MS,
  REQUEST_CEILING_MS,
  estimateMs,
  handedOver,
  overBudget,
} from "./inline-budget";

const untagged = (variants: number, products = variants) => ({ variants, products, taggedProducts: 0 });

describe("the inline budget", () => {
  it("sits well under the request ceiling rather than at it", () => {
    // The per-product figures came from one store; a shop being throttled by the Admin
    // API is slower, and planning and read-back share the same five minutes.
    expect(PAGE_INLINE_BUDGET_MS).toBeLessThanOrEqual(REQUEST_CEILING_MS * 0.5);
  });


  it("never fits a run that takes the bulk path, whatever the budget (#790)", () => {
    // The 3,666-variant campaign that showed a merchant a bare "502" at five minutes while
    // it kept writing. The old 120,000-row limit let it through at 3% of the limit.
    const bulk = { variants: 3_666, products: 1_600, taggedProducts: 1_600 };
    expect(estimateMs(bulk), "Shopify's queue is not ours to estimate").toBeNull();
    expect(overBudget(bulk, PAGE_INLINE_BUDGET_MS)).toMatch(/3,666 variants.*bulk operation/);
    expect(overBudget(bulk, Number.MAX_SAFE_INTEGER), "not even an enormous budget").not.toBeNull();

    // One over the threshold is the bulk path; at it, sync.
    expect(estimateMs(untagged(DEFAULT_THRESHOLD + 1, 1))).toBeNull();
    expect(estimateMs(untagged(DEFAULT_THRESHOLD, 1))).not.toBeNull();
  });

  it("costs the sync path per product, not per variant", () => {
    // A product's variants share one call.
    expect(estimateMs(untagged(150, 10))).toBe(10 * MS_PER_SYNC_PRODUCT);
    // So 900 variants on 900 products -- under the bulk threshold -- is far over budget.
    expect(overBudget(untagged(900), PAGE_INLINE_BUDGET_MS)).toMatch(/900 variants, and pricing 900 products takes about 11 minutes/);
  });

  it("counts the tag kit, one call a product after the prices", () => {
    const products = Math.floor(PAGE_INLINE_BUDGET_MS / MS_PER_SYNC_PRODUCT);
    const work = { variants: products, products, taggedProducts: 0 };
    expect(overBudget(work, PAGE_INLINE_BUDGET_MS), "fits on prices alone").toBeNull();

    const tagged = { ...work, taggedProducts: products };
    expect(estimateMs(tagged)).toBe(products * (MS_PER_SYNC_PRODUCT + MS_PER_TAGGED_PRODUCT));
    expect(overBudget(tagged, PAGE_INLINE_BUDGET_MS), "the tags are what does not fit").toMatch(/pricing and tagging/);
  });

  it("lets a small campaign run where it was asked", () => {
    expect(overBudget(untagged(40, 20), PAGE_INLINE_BUDGET_MS)).toBeNull();
    expect(overBudget({ variants: 0, products: 0, taggedProducts: 0 }, 1)).toBeNull();
  });

  it("takes the caller's budget rather than assuming its own", () => {
    // Flow waits ten seconds, the page five minutes: the deadline belongs to the caller.
    const work = untagged(20);
    expect(overBudget(work, 5_000)).toMatch(/about 10 seconds — longer than this request can wait/);
    expect(overBudget(work, PAGE_INLINE_BUDGET_MS)).toBeNull();
  });

});

describe("what is written where it was asked, and what is the worker's (D29, #808)", () => {
  it("writes a tiny run on the page, as it always did", () => {
    // A merchant's one-variant revert, and App Review's few-variant apply and revert.
    expect(handedOver(untagged(1), PAGE_INLINE)).toBeNull();
    expect(handedOver(untagged(MAX_INLINE_ROWS), PAGE_INLINE)).toBeNull();
    expect(handedOver({ variants: 0, products: 0, taggedProducts: 0 }, PAGE_INLINE)).toBeNull();
  });

  it("says the bulk path or the time first, which say more than a count", () => {
    expect(handedOver(untagged(5_000, 50), PAGE_INLINE)).toMatch(/5,000 variants, which go to Shopify as one bulk operation/);
    expect(handedOver(untagged(20), { rows: MAX_INLINE_ROWS, budgetMs: 5_000 })).toMatch(/longer than this request can wait/);
  });

  it("hands anything larger to the worker, and says how large and why", () => {
    const reason = handedOver(untagged(MAX_INLINE_ROWS + 1), PAGE_INLINE);
    expect(reason).toMatch(/covers 51 variants, more than the 50 Anchor writes while the page waits/);
    // However quick the writing would be: the bound is the rows, not only the time.
    expect(overBudget(untagged(MAX_INLINE_ROWS + 1, 1), PAGE_INLINE_BUDGET_MS)).toBeNull();
  });

  it("keeps the rows small enough that the page's time budget never binds below them", () => {
    // Fifty products, each priced and tagged on the sync path, inside the page's budget.
    const worst = { variants: MAX_INLINE_ROWS, products: MAX_INLINE_ROWS, taggedProducts: MAX_INLINE_ROWS };
    expect(estimateMs(worst)!).toBeLessThanOrEqual(PAGE_INLINE_BUDGET_MS);
    expect(handedOver(worst, PAGE_INLINE)).toBeNull();
    // And small: the number is the epic's own example, not a budget in disguise.
    expect(MAX_INLINE_ROWS).toBeLessThanOrEqual(50);
  });

  it("hands every run Flow starts to the worker, an empty one included", () => {
    for (const variants of [0, 1, MAX_INLINE_ROWS, 100_000]) {
      expect(handedOver(untagged(variants), NEVER_INLINE), `${variants} variants`).toMatch(/Shopify Flow are always written by the background worker/);
    }
  });

  it("never refuses for size: there is no refusal left to give", () => {
    expect(sourceOf("app/lib/execution/inline-budget.ts")).not.toContain("refuseInline");
    expect(sourceOf("app/services/campaigns/run.server.ts")).not.toContain("refuseInline");
  });
});

/**
 * The limit is the caller's, which makes it two halves of a contract: `runCampaign` knows how
 * to hand a run over, and the caller declares what it may write while it waits. Nothing at
 * runtime checks that they agree -- a route that called `runCampaign` with no limit would
 * compile, pass every other test, and write a 100,000-variant apply inside its request on a
 * store large enough to matter (#803).
 *
 * So no route calls it: every route starts a run through `startRun`, which always passes one,
 * and says which caller it is. That is this repo's dominant bug class, so it is read off the
 * source rather than a hand-kept list.
 */
describe("every route starts a run through the one helper that sets its limit (#808)", () => {
  const routes = readdirSync(join(process.cwd(), "app/routes")).filter(
    (file) => (file.endsWith(".tsx") || file.endsWith(".ts")) && !file.endsWith(".test.tsx") && !file.endsWith(".test.ts"),
  );
  const sources = routes.map((file) => ({ file, source: sourceOf("app/routes", file) }));

  it("finds the routes that start runs at all, so a rename cannot empty this suite", () => {
    const starters = sources.filter(({ source }) => /\bstartRun\(/.test(source));
    expect(starters.map(({ file }) => file).sort()).toEqual([
      "app.campaigns.$id.tsx",
      "flow.actions.end-campaign.tsx",
      "flow.actions.start-campaign.tsx",
    ]);
  });

  it.each(["runCampaign", "syncCatalogViaBulk", "captureBaselines"])("no route reaches %s directly", (name) => {
    const callers = sources.filter(({ source }) => new RegExp(`\\b${name}\\b`).test(source)).map(({ file }) => file);
    expect(callers, `a route calling ${name} writes inside its request, whatever its size`).toEqual([]);
  });

  it("says which caller it is, every time", () => {
    for (const { file, source } of sources) {
      for (const call of source.split("startRun(").slice(1)) {
        expect(call, `${file} starts a run without naming its caller`).toMatch(/^[^;]*?,\s*"(page|flow)"\s*,/);
      }
    }
    // Flow is never the page: its runs are all the worker's.
    expect(sourceOf("app/routes/flow.actions.start-campaign.tsx")).toContain('"flow"');
    expect(sourceOf("app/routes/flow.actions.end-campaign.tsx")).toContain('"flow"');
  });

  it("is the helper that always passes a limit", () => {
    const helper = sourceOf("app/services/campaigns/start-run.server.ts");
    expect(helper).toMatch(/inline: caller === "page" \? PAGE_INLINE : NEVER_INLINE/);
  });

  it("leaves the worker and the scheduler unlimited", () => {
    // They have no request attached, so no request's limit applies to them.
    for (const path of ["app/worker/handlers.server.ts", "app/services/scheduler.server.ts"]) {
      const source = sourceOf(path);
      expect(source, `${path} has no request attached, so a request's limit must not apply to it`).not.toMatch(/\binline:/);
      expect(source).not.toContain("startRun");
    }
  });
});
