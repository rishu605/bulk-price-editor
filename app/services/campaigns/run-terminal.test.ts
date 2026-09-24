/**
 * A run row never outlives the process running it.
 *
 * `campaignRun` is the ledger's account of what the app is doing to a storefront right
 * now. A row left `EXECUTING` with nothing behind it is the worst shape that record can
 * take: the campaign itself is fine — `releaseClaim` frees it — so nothing looks stuck,
 * and the run sits there claiming to be in progress for ever.
 *
 * #649 found it on the bulk path. A submission Shopify refused threw straight past the
 * terminal update at the end of `executeCampaignRun`, because only the *market* section
 * had a try/catch and the base-price section had none. But the gap was never specific to
 * that path: every `await` between creating the row and updating it had the same hole,
 * which is why the fix is at the boundary rather than around the one call that exposed it.
 *
 * ## Why this is a source check
 *
 * The same reason `one-writer.test.ts` is one: `run.server.ts` needs a database, a
 * Shopify client and a campaign to run at all, so the behaviour belongs to the chaos
 * suite. What is checkable here is the structure the behaviour depends on — and the two
 * properties below are the ones that make calling it unconditionally safe. Neither is
 * obvious from reading the catch, and both are easy to remove by accident.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";

const RUN = sourceOf("app/services/campaigns/run.server.ts");

/** The body of `failRun`, which is what the two properties below are about. */
function failRunBody(): string {
  const start = RUN.indexOf("async function failRun(");
  expect(start, "failRun should exist").toBeGreaterThan(-1);

  const after = RUN.indexOf("\nasync function ", start + 1);
  return RUN.slice(start, after === -1 ? RUN.length : after);
}

describe("a failed run reaches a terminal state", () => {
  it("finishes the run row before rethrowing", () => {
    // Ordering matters: `releaseClaim` is what lets another worker pick the campaign up,
    // so the row has to be settled first. And both have to happen before the rethrow,
    // which is what leaves the function.
    const fail = RUN.indexOf("await failRun(");
    const release = RUN.indexOf("await releaseClaim(");
    const rethrow = RUN.indexOf("    throw error;");

    expect(fail, "the catch must finish the run row").toBeGreaterThan(-1);
    expect(fail, "the run row is settled before the campaign is released").toBeLessThan(
      release,
    );
    expect(release, "both happen before the error leaves").toBeLessThan(rethrow);
  });

  it("cannot rewrite a run that already finished", () => {
    // The catch covers everything after the row is created — including the lines *after*
    // the run is marked COMPLETED, such as `transitionCampaign` and the mirror refresh.
    // A throw there must not turn a clean run into a failed one, so the update is
    // filtered to the non-terminal states. Without this filter the guard would be worse
    // than the bug it fixes: it would lie about runs that succeeded.
    const body = failRunBody();

    expect(body, "the update must be filtered by status").toMatch(/status:\s*\{\s*in:\s*\[/);
    for (const live of ["PLANNING", "QUEUED", "EXECUTING", "VERIFYING"]) {
      expect(body, `${live} is a state a dead run can be left in`).toContain(live);
    }
    for (const terminal of ["COMPLETED", "PARTIAL", "CANCELLED"]) {
      expect(body, `${terminal} runs must not be rewritten`).not.toContain(terminal);
    }
    // `updateMany`, because `update` throws when the filter matches nothing — which is
    // exactly what happens on the path this is designed to tolerate.
    expect(body).toContain("updateMany");
  });

  it("cannot replace the error it was called about", () => {
    // It runs inside a catch whose job is to rethrow the original failure. A database
    // hiccup here replacing "Shopify refused this submission" with a Prisma error would
    // lose the only useful sentence the merchant was going to get.
    const body = failRunBody();

    expect(body, "failRun must swallow its own failure").toMatch(/catch\s*\(/);
    expect(body, "and say so somewhere it can be read").toMatch(/logger\.error/);
  });
});
