/**
 * That a run's log lines say which run they belong to.
 *
 * `runCampaign` is the function both writers share. A queued apply reaches it through the
 * job wrapper, and an inline Apply or Revert reaches it straight from a route — and per
 * CLAUDE.md rule 2 both genuinely write prices. So this is the one place that gives both
 * processes the same fields; binding only in the worker would have left the web half, the
 * half a merchant is watching while it happens, with nothing to correlate on.
 *
 * Checked as source because the alternative is a Postgres, an Admin client and a
 * campaign, and none of that would make the assertion stronger — what is being asserted
 * is that two calls exist and are in the right order relative to a third. `sourceOf`
 * strips comments, so the notes beside these calls cannot satisfy the checks on their own.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../../lib/testing/source";

const source = sourceOf("app/services/campaigns/run.server.ts");

describe("the run boundary binds its ids", () => {
  it("wraps the run in the shop and campaign", () => {
    expect(
      source,
      "runCampaign no longer binds a log context, so an inline apply logs without a shop",
    ).toMatch(/withLogContext\(\s*\{\s*shopId,\s*campaignId\s*\}/);
  });

  it("adds the run id, which does not exist until the run row does", () => {
    expect(
      source,
      "nothing binds the run id, so every line after the claim is unattributable",
    ).toMatch(/addLogContext\(\{\s*runId:\s*run\.id\s*\}\)/);
  });

  /**
   * The half worth guarding. `addLogContext` before the `campaign_runs` row exists has
   * no id to add and would bind nothing — and it would still look correct in review,
   * because the call is there.
   */
  it("adds it after the row is created, not before", () => {
    const created = source.indexOf("prisma.campaignRun.create");
    const bound = source.indexOf("addLogContext(");

    expect(created, "the run row is no longer created here").toBeGreaterThan(-1);
    expect(bound, "the run id is no longer bound here").toBeGreaterThan(-1);
    expect(
      bound,
      "the run id is bound before the row that mints it, so it binds nothing",
    ).toBeGreaterThan(created);
  });

  /**
   * `withLogContext` has to enclose the work, not sit beside it. A binding that wrapped
   * nothing would pass both checks above and produce no ids at all.
   *
   * Asserted as "the callback *is* the call" rather than "the two appear near each
   * other". The proximity version was written first and a deliberately broken copy —
   * `withLogContext(…, async () => {})` on the line above an unwrapped run — passed it,
   * because the two tokens were still 60 characters apart.
   */
  it("binds around the run rather than beside it", () => {
    expect(
      source,
      "the context is bound but does not enclose executeCampaignRun, so the run logs " +
        "without ids while the binding still looks present",
    ).toMatch(
      /withLogContext\(\s*\{\s*shopId,\s*campaignId\s*\},\s*\(\)\s*=>\s*executeCampaignRun\(/,
    );
  });

  /**
   * The other way to lose it: leave the wrapped path alone and add a second, unwrapped
   * caller beside it. Every check above still passes.
   */
  it("has no second path into the run that skips the binding", () => {
    const calls = [...source.matchAll(/(?<!function\s)\bexecuteCampaignRun\(/g)].length;

    expect(
      calls,
      "executeCampaignRun is called from more than one place, so at least one path into " +
        "a run is not inside a log context",
    ).toBe(1);
  });
});
