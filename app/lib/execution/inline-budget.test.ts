/**
 * The guard's whole job is to be a number and a sentence, so both are tested.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_INLINE_ROWS,
  MS_PER_VARIANT,
  REQUEST_CEILING_MS,
  estimateMinutes,
  refuseInline,
} from "./inline-budget";

describe("the inline apply budget", () => {
  it("sits under the request ceiling rather than at it", () => {
    const atTheLimit = MAX_INLINE_ROWS * MS_PER_VARIANT;

    expect(
      atTheLimit,
      "a limit at the cliff edge refuses nothing that would actually have failed",
    ).toBeLessThan(REQUEST_CEILING_MS);

    // Better than half the budget left over at the limit. The per-variant figure came
    // from one store on one afternoon; a shop being throttled by the Admin API will be
    // slower, and the guard has to still be a guard when that happens.
    expect(atTheLimit).toBeLessThan(REQUEST_CEILING_MS * 0.75);
  });

  it("does not refuse a run size that already works today", () => {
    // 62,535 variants applied and reverted clean on anchor-perf in 109 and 113 seconds.
    // If this guard would have refused that, the guard is the bug.
    expect(refuseInline(62_535)).toBeNull();
  });

  it("allows exactly the limit and refuses one more", () => {
    expect(refuseInline(MAX_INLINE_ROWS)).toBeNull();
    expect(refuseInline(MAX_INLINE_ROWS + 1)).not.toBeNull();
  });

  it("names the size, the reason and the way forward", () => {
    const message = refuseInline(500_000);
    expect(message).toBeTruthy();

    // The error taxonomy: the object, the cause, the next action.
    expect(message, "the merchant needs to know how big is too big").toContain("500,000");
    expect(message, "a refusal with no way forward is a dead end").toMatch(/schedul/i);
    expect(message, "and why, or it reads as an arbitrary product limit").toMatch(
      /request|cut off|time limit/i,
    );
  });

  it("estimates in minutes a merchant can act on", () => {
    expect(estimateMinutes(120_000)).toBe(4);

    // Never "0 minutes", which reads as "this is instant, why did you refuse it".
    expect(estimateMinutes(1)).toBe(1);
  });

  it("takes the caller's limit rather than assuming its own", () => {
    // The ceiling belongs to the caller. A future caller with a tighter deadline -- a
    // webhook that must answer in seconds -- passes its own number.
    expect(refuseInline(10, 5)).not.toBeNull();
    expect(refuseInline(10, 5000)).toBeNull();
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
      const source = readFileSync(join(process.cwd(), "app/routes", file), "utf8");
      // The import line is not a call.
      return callsIn(source)
        .filter((args) => args.includes(","))
        .map((args) => ({ file, args }));
    });

  it("finds the route callers at all, so a rename cannot empty this suite", () => {
    expect(callers.length).toBeGreaterThanOrEqual(3);
  });

  it.each(callers.map((c) => [c.file, c.args] as const))(
    "%s passes inlineRowLimit or is a revert",
    (file, args) => {
      const reverts = /revert:\s*true/.test(args);

      if (reverts) {
        expect(
          args,
          `${file} reverts, and a revert must never be refused for its size — ` +
            "a store left discounted is the incident the guard exists to prevent",
        ).not.toContain("inlineRowLimit");
        return;
      }

      expect(
        args,
        `${file} applies a campaign inside an HTTP request without declaring a row ` +
          "limit. Above ~170,000 variants the proxy closes the connection while the " +
          "run keeps writing: the merchant sees an error and their prices move anyway.",
      ).toContain("inlineRowLimit");
    },
  );

  it("leaves the worker and the scheduler unlimited", () => {
    // "Schedule it instead" is only honest advice if the scheduler has no such ceiling.
    for (const path of ["app/worker/handlers.server.ts", "app/services/scheduler.server.ts"]) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(
        source,
        `${path} has no request attached, so a request deadline must not apply to it`,
      ).not.toContain("inlineRowLimit");
    }
  });
});

/**
 * A refusal that renders as a success is worse than no guard at all: the merchant is
 * told their campaign was applied, and it was not.
 *
 * `refused` was on `RunOutcome` for the plan gate and read by nobody, so every
 * refusal already rendered as "Applied 0 variants, all verified." Asserted from the
 * source because the alternative is mounting the whole route to check a ternary.
 */
describe("a refused apply does not render as a successful one", () => {
  const page = readFileSync(join(process.cwd(), "app/routes/app.campaigns.$id.tsx"), "utf8");

  it("handles the refusal before the generic outcome message", () => {
    // The branch, not the field. Matching the field alone survives the branch being
    // disabled, because the field is still named inside the body it no longer reaches.
    const refusal = page.indexOf("if (result.refused)");
    // The template literal, not the phrase: it appears in two comments above this,
    // and a source check that matches its own documentation proves nothing.
    const generic = page.indexOf("${verb} ${result.verified} variants, all verified.");

    expect(refusal, "the campaign page must read the refusal at all").toBeGreaterThan(-1);
    expect(
      refusal,
      "a refusal reaching the generic message renders as a green tick over a run that never happened",
    ).toBeLessThan(generic);
  });

  it("gives it its own tone rather than success or critical", () => {
    expect(page).toContain('result.tone ?? "critical"');
  });
});
