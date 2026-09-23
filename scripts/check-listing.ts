/**
 * Checks the App Store listing copy against the limits it will actually be pasted into,
 * and against the code it makes claims about.
 *
 * Three things drift here, and only a third party ever notices:
 *
 * - **Copy against Shopify's field limits.** A field that is four characters too long is
 *   discovered by the Partner Dashboard silently truncating it, which is how a listing
 *   ends up ending mid-word.
 * - **The stated limit against the real one.** The doc writes "Limit 30" beside each
 *   field. If that number is wrong, every count under it is checked against a fiction, so
 *   the limits live here and the doc's own number is asserted to match.
 * - **The pricing table against `plans.ts`.** A listing that disagrees with what the
 *   merchant is charged is the review nobody recovers from. The table is parsed and
 *   compared field by field rather than read.
 *
 * Also refuses em and en dashes, which are a house style rule for this copy.
 */

import { readFileSync } from "node:fs";
import { PLANS, PLAN_ORDER, type Plan } from "../app/lib/billing/plans";

const DOC = "docs/listing/copy.md";

interface Field {
  /** Exact `## ` heading in the doc. */
  heading: string;
  /** Shopify's limit, per field, in characters. */
  limit: number;
  /** Whether the fenced block holds one value or one value per line. */
  multi: boolean;
  /** Maximum number of entries, for multi fields. */
  max?: number;
}

const FIELDS: Field[] = [
  { heading: "App name", limit: 30, multi: false },
  { heading: "App card subtitle", limit: 62, multi: false },
  { heading: "App introduction", limit: 100, multi: false },
  { heading: "App details", limit: 500, multi: false },
  { heading: "Feature list", limit: 80, multi: true, max: 5 },
  { heading: "Search terms", limit: 20, multi: true, max: 5 },
  { heading: "Screenshot captions", limit: 100, multi: true, max: 5 },
];

export interface Problem {
  field: string;
  message: string;
}

/** The text of a `## ` section, up to the next `## `. */
export function sectionOf(doc: string, heading: string): string | null {
  const start = doc.indexOf(`\n## ${heading}\n`);
  if (start === -1) return null;
  const after = doc.indexOf("\n## ", start + 1);
  return doc.slice(start, after === -1 ? doc.length : after);
}

/** The first fenced block in a section, verbatim. */
export function fencedBlock(section: string): string | null {
  const match = section.match(/```\n([\s\S]*?)\n```/);
  return match ? match[1] : null;
}

/** The limit the doc claims for a field, so it can be checked against the real one. */
export function statedLimit(section: string): number | null {
  const match = section.match(/limit (\d+)/i);
  return match ? Number(match[1]) : null;
}

export function checkCopy(doc: string): Problem[] {
  const problems: Problem[] = [];

  for (const field of FIELDS) {
    const section = sectionOf(doc, field.heading);
    if (!section) {
      problems.push({ field: field.heading, message: "no section with this heading" });
      continue;
    }

    const stated = statedLimit(section);
    if (stated === null) {
      problems.push({ field: field.heading, message: "section does not state its limit" });
    } else if (stated !== field.limit) {
      problems.push({
        field: field.heading,
        message: `doc says limit ${stated}, Shopify's limit is ${field.limit}`,
      });
    }

    const block = fencedBlock(section);
    if (block === null) {
      problems.push({ field: field.heading, message: "no fenced block holding the value" });
      continue;
    }

    const values = field.multi ? block.split("\n").filter((line) => line.trim() !== "") : [block];

    if (field.max !== undefined && values.length > field.max) {
      problems.push({
        field: field.heading,
        message: `${values.length} entries, Shopify accepts at most ${field.max}`,
      });
    }

    for (const value of values) {
      if (value.length > field.limit) {
        problems.push({
          field: field.heading,
          message: `${value.length}/${field.limit} chars: ${JSON.stringify(value.slice(0, 40))}...`,
        });
      }
    }
  }

  return problems;
}

/** Em and en dashes, anywhere in the copy. A house rule, so it is checked not trusted. */
export function checkDashes(doc: string): Problem[] {
  return doc
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => line.includes("—") || line.includes("–"))
    .map(({ number }) => ({ field: "house style", message: `em or en dash on line ${number}` }));
}

function dollars(minor: number): string {
  return minor === 0 ? "Free" : `$${(minor / 100).toFixed(2)} / month`;
}

function variants(plan: Plan): string {
  return plan.variantLimit === null ? "Unlimited" : plan.variantLimit.toLocaleString("en-US");
}

/**
 * The pricing table, compared with `plans.ts` cell by cell.
 *
 * Parsed rather than eyeballed, because the failure this catches is a price changing in
 * code and the listing keeping the old one.
 */
export function checkPricing(doc: string): Problem[] {
  const section = sectionOf(doc, "Pricing");
  if (!section) return [{ field: "Pricing", message: "no Pricing section" }];

  const rows = new Map<string, string[]>();
  for (const line of section.split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 5) continue;
    if (cells[0] === "Plan" || cells[0].startsWith("---")) continue;
    rows.set(cells[0], cells);
  }

  const problems: Problem[] = [];

  for (const id of PLAN_ORDER) {
    const plan = PLANS[id];
    const row = rows.get(plan.name);
    if (!row) {
      problems.push({ field: "Pricing", message: `no row for the ${plan.name} plan` });
      continue;
    }

    const expected = [
      plan.name,
      dollars(plan.priceMinor),
      variants(plan),
      plan.markets ? "Yes" : "No",
      plan.b2b ? "Yes" : "No",
    ];
    const columns = ["plan", "price", "variants", "markets", "b2b"];

    expected.forEach((want, index) => {
      if (row[index] !== want) {
        problems.push({
          field: "Pricing",
          message: `${plan.name} ${columns[index]}: listing says ${JSON.stringify(row[index])}, plans.ts says ${JSON.stringify(want)}`,
        });
      }
    });
  }

  if (rows.size !== PLAN_ORDER.length) {
    problems.push({
      field: "Pricing",
      message: `${rows.size} rows in the table, ${PLAN_ORDER.length} plans in plans.ts`,
    });
  }

  return problems;
}

export function checkAll(doc: string): Problem[] {
  return [...checkCopy(doc), ...checkDashes(doc), ...checkPricing(doc)];
}

function main(): void {
  const doc = readFileSync(DOC, "utf8");
  const problems = checkAll(doc);

  if (problems.length === 0) {
    console.log(`${DOC}: every field within its limit, pricing matches plans.ts, no em dashes.`);
    return;
  }

  console.error(`${DOC}: ${problems.length} problem(s)\n`);
  for (const problem of problems) {
    console.error(`  ${problem.field}: ${problem.message}`);
  }
  process.exit(1);
}

// Guarded, so importing this to test it does not run it.
if (process.argv[1]?.includes("check-listing")) {
  main();
}
