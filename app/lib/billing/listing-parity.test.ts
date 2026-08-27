/**
 * The App Store listing's prices are the prices merchants are charged.
 *
 * `docs/app-store-listing.md` carries a pricing table, and `plans.ts` carries the tiers
 * billing actually enforces. Nothing connected them: a price edited in one would leave
 * the other quietly wrong, and the direction that matters is the bad one — a listing
 * promising $14.90 while Shopify charges $19.90 is a policy problem and a one-star
 * review, and the merchant finds out at the checkout rather than from us.
 *
 * The doc says so itself — "a listing that disagrees with what the merchant is charged is
 * a review nobody recovers from" — which is a good sentence and, until now, an unenforced
 * one. This is the same shape as every expensive bug in this codebase: two halves of a
 * contract that only a human comparison validates.
 *
 * The table is the source under test, not the source of truth. `plans.ts` is what runs.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PLANS, PLAN_ORDER } from "./plans";

const listing = readFileSync(join(process.cwd(), "docs", "app-store-listing.md"), "utf8");

/** The pricing table, as `{ plan → cells }`. */
function tableRows(): Map<string, string[]> {
  const rows = new Map<string, string[]>();

  for (const line of listing.split("\n")) {
    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean);
    // A data row: five columns whose first is a plan name we know.
    if (cells.length === 5 && PLAN_ORDER.some((id) => PLANS[id].name === cells[0])) {
      rows.set(cells[0], cells);
    }
  }
  return rows;
}

/** "$14.90/month" → 1490. "Free" → 0. */
function minorFrom(cell: string): number {
  if (/^free$/i.test(cell)) return 0;
  const match = /\$([0-9]+)\.([0-9]{2})/.exec(cell);
  if (!match) throw new Error(`not a price: "${cell}"`);
  return Number(match[1]) * 100 + Number(match[2]);
}

describe("the listing's pricing table", () => {
  const rows = tableRows();

  it("has a row for every plan, and no plan the listing invents", () => {
    expect([...rows.keys()].sort()).toEqual(PLAN_ORDER.map((id) => PLANS[id].name).sort());
  });

  it.each(PLAN_ORDER)("charges for %s what the listing says", (id) => {
    const plan = PLANS[id];
    const cells = rows.get(plan.name);
    expect(cells, `${plan.name} is missing from the listing`).toBeDefined();

    expect(
      minorFrom(cells![1]),
      `the listing says ${cells![1]} for ${plan.name}; billing charges ${plan.priceMinor} minor units`,
    ).toBe(plan.priceMinor);
  });

  it.each(PLAN_ORDER)("states %s's variant cap correctly", (id) => {
    const plan = PLANS[id];
    const stated = rows.get(plan.name)![2];

    if (plan.variantLimit === null) {
      expect(stated.toLowerCase(), "an uncapped plan must not advertise a number").toBe(
        "unlimited",
      );
      return;
    }
    expect(Number(stated.replace(/[,\s]/g, "")), `${plan.name}'s cap`).toBe(plan.variantLimit);
  });

  it.each(PLAN_ORDER)("states whether %s includes markets and wholesale", (id) => {
    const plan = PLANS[id];
    const [, , , markets, wholesale] = rows.get(plan.name)!;

    // A listing that advertises a surface the plan gates is the same failure as a wrong
    // price, arriving later: the merchant subscribes for markets and cannot use them.
    expect(/yes/i.test(markets), `${plan.name} markets`).toBe(plan.markets);
    expect(/yes/i.test(wholesale), `${plan.name} wholesale`).toBe(plan.b2b);
  });

  it("states the trial length the paid plans actually grant", () => {
    const trials = new Set(
      PLAN_ORDER.filter((id) => PLANS[id].priceMinor > 0).map((id) => PLANS[id].trialDays),
    );
    expect(trials.size, "the plans disagree about the trial; the listing can only say one").toBe(1);

    const days = [...trials][0];
    expect(listing).toContain(`${days}-day free trial`);
  });
});
