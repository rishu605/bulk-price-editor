/**
 * Every database state a merchant can see, rendered.
 *
 * The app stores states as Prisma enums and used to put a lot of them straight into
 * badges: `VERIFIED`, `CSV_IMPORT`, `DRIFT_ADOPTION`. Three places had grown their own
 * `toLowerCase().replace(/_/g, " ")` to cope, which lowercases `CSV` into `csv` and
 * leaves the badge starting mid-sentence.
 *
 * The interesting test is the last one. A transformation cannot be missing an entry, but
 * it also cannot know which tokens are said rather than spelled — so this reads the enums
 * out of `schema.prisma` and renders all of them. Somebody adding `EU_VAT_ADJUSTMENT`
 * gets a failing expectation naming the label it would produce, rather than shipping
 * "Eu vat adjustment" to a badge.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { humanise } from "./label";

describe("rendering a stored value", () => {
  it("turns SCREAMING_SNAKE into a sentence", () => {
    expect(humanise("INSTALL_CAPTURE")).toBe("Install capture");
    expect(humanise("VERIFIED")).toBe("Verified");
  });

  it("says acronyms rather than spelling them wrong", () => {
    // The failure the hand-rolled `toLowerCase()` had at three call sites.
    expect(humanise("CSV_IMPORT")).toBe("CSV import");
    expect(humanise("B2B")).toBe("B2B");
  });

  it("capitalises a value that arrives already lowercase", () => {
    // The preview's statuses are lowercase strings rather than Prisma enums, and read as
    // sloppy next to a Polaris badge that says "Fulfilled".
    expect(humanise("clamped")).toBe("Clamped");
  });

  it("serves the dotted audit actions too, which differ only in their separator", () => {
    expect(humanise("market.notice-resolved")).toBe("Market notice resolved");
  });

  it("gives back anything it cannot make words of", () => {
    expect(humanise("")).toBe("");
    expect(humanise("...")).toBe("...");
  });
});

describe("every enum in the schema", () => {
  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");

  const values = [...schema.matchAll(/enum\s+\w+\s*\{([^}]*)\}/g)]
    .flatMap((block) => block[1].split("\n"))
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*$/.test(line));

  it("finds the enums, so the checks below are not vacuous", () => {
    expect(values.length).toBeGreaterThan(30);
    expect(values).toContain("CSV_IMPORT");
  });

  it("shows the words for every stored state, and names any new one", () => {
    // Written out rather than checked by a rule, because the one thing the
    // transformation cannot work out for itself is which tokens are said rather than
    // spelled — and every rule for guessing that is wrong somewhere. The first attempt
    // here was "a token with no vowels is an acronym", which flagged `SYNC`.
    //
    // So this is the table of every state the database can hold and the words a merchant
    // would read for it. Adding an enum value fails this test and shows the label it
    // would have shipped, which is the moment to notice `EU_VAT_ADJUSTMENT` renders as
    // "Eu vat adjustment" and add the acronym.
    const rendered = Object.fromEntries(values.map((value) => [value, humanise(value)]));

    expect(rendered).toEqual({
      FREE: "Free",
      GROWTH: "Growth",
      MARKETS: "Markets",
      WHOLESALE: "Wholesale",
      ACTIVE: "Active",
      ARCHIVED: "Archived",
      DRAFT: "Draft",
      BASE: "Base",
      MARKET: "Market",
      B2B: "B2B",
      INSTALL_CAPTURE: "Install capture",
      RECAPTURE: "Recapture",
      CSV_IMPORT: "CSV import",
      DRIFT_ADOPTION: "Drift adoption",
      AUTO_ENROLL: "Auto enroll",
      DYNAMIC: "Dynamic",
      FROZEN: "Frozen",
      SCHEDULED: "Scheduled",
      APPLYING: "Applying",
      HELD: "Held",
      REVERTING: "Reverting",
      COMPLETED: "Completed",
      PARTIAL: "Partial",
      CANCELLED: "Cancelled",
      APPLY: "Apply",
      REVERT: "Revert",
      REASSERT: "Reassert",
      ENROLL: "Enroll",
      PLANNING: "Planning",
      QUEUED: "Queued",
      EXECUTING: "Executing",
      VERIFYING: "Verifying",
      FAILED: "Failed",
      SYNC: "Sync",
      BULK: "Bulk",
      PENDING: "Pending",
      WRITING: "Writing",
      APPLIED: "Applied",
      VERIFIED: "Verified",
      SKIPPED: "Skipped",
      CLAMPED: "Clamped",
      REVERTED: "Reverted",
      ADOPTED: "Adopted",
      REASSERTED: "Reasserted",
      IGNORED: "Ignored",
      CHARM: "Charm",
      STEP: "Step",
      RECEIVED: "Received",
      PROCESSING: "Processing",
      PROCESSED: "Processed",
      QUERY: "Query",
      MUTATION: "Mutation",
      CREATED: "Created",
      RUNNING: "Running",
      CANCELED: "Canceled",
      EXPIRED: "Expired",
    });
  });
});
