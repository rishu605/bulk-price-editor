/**
 * The runbook, executed rather than read.
 *
 * `docs/runbooks.md` carries seventeen SQL statements an operator pastes during an
 * incident. They are markdown. The schema they read is Prisma's, and the only thing that
 * would notice a renamed column is the person pasting the query at 3am — who gets a
 * syntax error instead of an answer, at the worst moment the app has.
 *
 * That is this repo's most familiar bug class one file boundary along: two halves of a
 * contract validated by neither TypeScript nor CI. The alert-to-runbook bijection already
 * exists for the same reason — two alerts had linked to a page about a different incident.
 *
 * Every statement here is **extracted from the markdown**, never retyped. A copy in a test
 * would drift from the document an operator actually opens, which is the failure being
 * guarded against wearing a different hat.
 *
 * ## Two levels, and the second is the point
 *
 * Parsing is the cheap check: does the column still exist. The expensive question is
 * whether the query filed under an incident actually *surfaces* that incident. A detection
 * query returning zero rows on a healthy system is indistinguishable from one that is
 * broken, so the only way to know is to create the state and run it.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import prisma from "../../app/db.server";

const RUNBOOK = join(process.cwd(), "docs", "runbooks.md");

/** Distinct enough that clearing leftovers cannot reach a scenario's or a merchant's shop. */
const DRILL_SHOP_PREFIX = "runbook-drill-";

/**
 * Every SQL statement the runbook tells somebody to run.
 *
 * Fenced blocks and inline backticks both, because the runbook uses both and an operator
 * does not distinguish them. Each keeps the heading it lives under, so a failure names the
 * section to fix rather than a line number.
 */
export function runbookStatements(markdown: string): Array<{ section: string; sql: string }> {
  const found: Array<{ section: string; sql: string }> = [];
  let section = "(before any heading)";

  // Fenced blocks are multi-line, so the document is walked once rather than scanned with
  // two independent regexes — that is what keeps each statement attached to its heading.
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const heading = /^#{2,3}\s+(.*)$/.exec(line);
    if (heading) {
      section = heading[1].trim();
      continue;
    }

    if (line.trim() === "```sql") {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i].trim() !== "```"; i++) body.push(lines[i]);
      found.push({ section, sql: body.join("\n") });
      continue;
    }

    for (const match of line.matchAll(/`(SELECT [^`]+)`/g)) {
      found.push({ section, sql: match[1] });
    }
  }

  return found;
}

/**
 * The statement with its worked-example placeholders filled in.
 *
 * The runbook writes `$1` and `'<id>'` where an operator substitutes a real value. Both
 * become a literal that matches nothing, because this is checking that the query *runs*,
 * not what it returns — and a value that matched something would make the check depend on
 * whatever else is in the database.
 */
export function runnable(sql: string): string {
  return sql
    .replace(/\$1/g, "'no-such-shop'")
    .replace(/'<id>'/g, "'no-such-id'")
    .trim()
    .replace(/;\s*$/, "");
}

describe("chaos: every command in the runbook still works", () => {
  const statements = runbookStatements(readFileSync(RUNBOOK, "utf8"));

  it("finds the statements it is protecting", () => {
    // A floor, so this file cannot quietly pass by extracting nothing — the failure mode
    // of every census check, and the reason the other ones in this repo carry a number.
    // Seventeen at the time of writing; the floor is lower so adding a runbook section
    // is not a reason to edit this test, and removing most of them is.
    expect(statements.length).toBeGreaterThanOrEqual(15);
  });

  it("attributes each statement to the section an operator would be reading", () => {
    for (const { section, sql } of statements) {
      expect(section, `no heading found above: ${sql.slice(0, 60)}`).not.toBe(
        "(before any heading)",
      );
    }
  });

  it("runs every one of them against the real schema", async () => {
    const broken: string[] = [];

    for (const { section, sql } of statements) {
      try {
        // EXPLAIN rather than the statement itself: it parses and resolves every table
        // and column without reading a row, so this cannot be slow and cannot depend on
        // what happens to be in the database.
        await prisma.$queryRawUnsafe(`EXPLAIN ${runnable(sql)}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        broken.push(`[${section}] ${sql.replace(/\s+/g, " ").slice(0, 100)}\n    ${message}`);
      }
    }

    expect(
      broken,
      "a runbook command no longer runs — an operator would hit this mid-incident",
    ).toEqual([]);
  });
});

/**
 * The one query whose correctness cannot be checked by parsing it.
 *
 * A campaign in a claim state with no run behind it is invisible to the reaper, which
 * reads `campaign_runs`. Since #339 the case self-heals, so on a healthy system this query
 * returns nothing — and a query that returns nothing because it is broken looks exactly
 * the same. The state has to exist for the rehearsal to mean anything.
 *
 * Built directly rather than by breaking a run, deliberately. The runbook says a campaign
 * found in this state is "either an older stranding or a case where a run *is* live", and
 * an older stranding is precisely a row that no current code path produces.
 */
describe("chaos: the stuck-run drill", () => {
  const statements = runbookStatements(readFileSync(RUNBOOK, "utf8"));

  /** The runbook's own text for a query, found by something it uniquely contains. */
  const runbookQuery = (contains: string): string => {
    const match = statements.find((s) => s.sql.includes(contains));
    if (!match) throw new Error(`The runbook no longer contains a query with "${contains}"`);
    return match.sql.trim().replace(/;\s*$/, "");
  };

  it("finds a campaign stranded in APPLYING with no run behind it", async () => {
    // A scenario killed mid-run leaves its shop behind, and the domain is unique. Clear
    // any before creating this one, so a crash yesterday does not fail the drill today
    // for a reason that has nothing to do with the runbook.
    const stale = await prisma.shop.findMany({
      where: { domain: { startsWith: DRILL_SHOP_PREFIX } },
      select: { id: true },
    });
    for (const { id } of stale) {
      await prisma.campaignRun.deleteMany({ where: { shopId: id } });
      await prisma.campaign.deleteMany({ where: { shopId: id } });
      await prisma.shop.delete({ where: { id } });
    }

    const shop = await prisma.shop.create({
      data: { domain: `${DRILL_SHOP_PREFIX}${process.pid}.myshopify.com` },
    });

    try {
      const stranded = await prisma.campaign.create({
        data: {
          shopId: shop.id,
          name: "Stranded by an older release",
          status: "APPLYING",
          ruleRows: [] as never,
          surfaces: { base: true, priceLists: [] } as never,
        },
      });
      const healthy = await prisma.campaign.create({
        data: {
          shopId: shop.id,
          name: "Ordinary draft",
          status: "DRAFT",
          ruleRows: [] as never,
          surfaces: { base: true, priceLists: [] } as never,
        },
      });

      const detect = runbookQuery("HAVING count(r.id) = 0");
      const found = await prisma.$queryRawUnsafe<Array<{ id: string }>>(detect);
      const ids = found.map((row) => row.id);

      expect(ids, "the runbook's detection query missed the incident it is filed under").toContain(
        stranded.id,
      );
      // Not a query that simply lists every campaign. A drill that passes because the
      // query is too broad has rehearsed nothing.
      expect(ids).not.toContain(healthy.id);

      // The second query is what the runbook says to check *before* acting, because
      // retrying Apply on a campaign whose run is genuinely live is the damaging mistake
      // it warns about. Rehearse both answers, not just the convenient one.
      const distinguish = runbookQuery('FROM campaign_runs WHERE "campaignId"');

      const whenStranded = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        distinguish.replace("'<id>'", `'${stranded.id}'`),
      );
      expect(whenStranded, "an empty result is what tells the operator retrying is safe").toEqual(
        [],
      );

      await prisma.campaignRun.create({
        data: {
          shopId: shop.id,
          campaignId: stranded.id,
          kind: "APPLY",
          occurrenceKey: `drill-${stranded.id}`,
          status: "EXECUTING",
        },
      });

      const whenLive = await prisma.$queryRawUnsafe<Array<{ status: string; count: bigint }>>(
        distinguish.replace("'<id>'", `'${stranded.id}'`),
      );
      expect(whenLive.map((row) => row.status), "a live run must be visible to the operator").toContain(
        "EXECUTING",
      );

      // And with a run row attached, the campaign is no longer what the detection query
      // is looking for — the two queries have to agree or the runbook contradicts itself.
      const afterRun = await prisma.$queryRawUnsafe<Array<{ id: string }>>(detect);
      expect(afterRun.map((row) => row.id)).not.toContain(stranded.id);
    } finally {
      await prisma.campaignRun.deleteMany({ where: { shopId: shop.id } });
      await prisma.campaign.deleteMany({ where: { shopId: shop.id } });
      await prisma.shop.delete({ where: { id: shop.id } });
    }
  });
});
