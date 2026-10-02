/**
 * The guard's whole job is to be an estimate and a sentence, so both are tested.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { DEFAULT_THRESHOLD } from "../planning/write-path";
import {
  MS_PER_SYNC_PRODUCT,
  MS_PER_TAGGED_PRODUCT,
  PAGE_INLINE_BUDGET_MS,
  REQUEST_CEILING_MS,
  estimateMs,
  overBudget,
  refuseInline,
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

  it("names the size, the reason and the way forward when it has to refuse", () => {
    const message = refuseInline(overBudget(untagged(500_000, 2_000), PAGE_INLINE_BUDGET_MS)!);

    // The error taxonomy: the object, the cause, the next action.
    expect(message, "the merchant needs to know how big is too big").toContain("500,000");
    expect(message, "a refusal with no way forward is a dead end").toMatch(/schedul/i);
    expect(message, "and why, or it reads as an arbitrary product limit").toMatch(/request|cut off|time limit/i);
  });
});

/**
 * The guard is opt-in, which makes it two halves of a contract: `runCampaign` knows how
 * to refuse, and each caller declares whether it has a deadline. Nothing at runtime
 * checks that they agree -- a route that forgets the option compiles, passes every
 * other test, and fails only on a store large enough to matter.
 *
 * That is this repo's dominant bug class, so it gets read off the source rather than a
 * hand-kept list.
 */
describe("every caller that runs inside a request declares its deadline", () => {
  const routes = readdirSync(join(process.cwd(), "app/routes"));

  /** The argument text of each `runCampaign(...)` call in a file. */
  function callsIn(source: string): string[] {
    const found: string[] = [];
    let at = source.indexOf("runCampaign(");

    while (at !== -1) {
      let depth = 0;
      let i = at + "runCampaign".length;
      const start = i + 1;

      for (; i < source.length; i += 1) {
        if (source[i] === "(") depth += 1;
        else if (source[i] === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
      }

      found.push(source.slice(start, i));
      at = source.indexOf("runCampaign(", i);
    }

    return found;
  }

  const callers = routes
    .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".test.tsx") && !file.endsWith(".test.ts"))
    .flatMap((file) => {
      const source = sourceOf("app/routes", file);
      // The import line is not a call.
      return callsIn(source)
        .filter((args) => args.includes(","))
        .map((args) => ({ file, args }));
    });

  it("finds the route callers at all, so a rename cannot empty this suite", () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it.each(callers.map((c) => [c.file, c.args] as const))(
    "%s declares inlineBudgetMs",
    (file, args) => {
      const reverts = /revert:\s*true/.test(args);

      if (reverts) {
        // Bounded too, since #772 -- but never refused. For a revert the limit means "too
        // large for this request, so the background worker does it": ending a sale must
        // always be possible, and a store left discounted is the incident the guard exists
        // to prevent. Unbounded, a large revert outlived its request and kept writing.
        expect(
          args,
          `${file} reverts inside an HTTP request without declaring a row limit, so a large ` +
            "revert would run past the proxy's timeout instead of going to the worker",
        ).toContain("inlineBudgetMs");
        return;
      }

      expect(
        args,
        `${file} applies a campaign inside an HTTP request without declaring a budget. ` +
          "A bulk-path run outlives the proxy, which closes the connection while the run " +
          "keeps writing: the merchant sees a 502 and their prices move anyway (#790).",
      ).toContain("inlineBudgetMs");
    },
  );

  it("leaves the worker and the scheduler unlimited", () => {
    // "Schedule it instead" is only honest advice if the scheduler has no such ceiling.
    for (const path of ["app/worker/handlers.server.ts", "app/services/scheduler.server.ts"]) {
      const source = sourceOf(path);
      expect(
        source,
        `${path} has no request attached, so a request deadline must not apply to it`,
      ).not.toContain("inlineBudgetMs");
    }
  });
});
