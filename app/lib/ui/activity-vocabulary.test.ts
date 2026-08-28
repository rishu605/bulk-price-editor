/**
 * The activity log says the same thing twice, in the same words.
 *
 * #388 fixed `ActivityTable` to render `describeAction(entry.action)`, so the Action
 * column reads "Campaign transition" the way the dashboard feed does. The **What** filter
 * directly above that column, in the same card, went on rendering the raw string — so the
 * page offered `campaign.transition` in a dropdown that filtered a column saying
 * `Campaign transition`. Two vocabularies for one thing, one element apart, introduced by
 * the sweep that fixed the first of them.
 *
 * A rendered test cannot reach this: the filter and the table are both in a route, behind
 * a loader. What can be checked is the property that was broken — that the two sides read
 * their labels through the same function — and that the raw value is still what gets
 * submitted, because a filter that posts a pretty string matches nothing.
 *
 * It lives under `lib/ui/` and not beside the route it is about, which is not a filing
 * preference. React Router's flat-routes reads *every* file in `app/routes/`, so a test
 * there becomes a route module and gets bundled for the browser — where `node:fs` does not
 * exist, and the build fails with "readFileSync is not exported by
 * __vite-browser-external". Vitest is happy either way; only `npm run build` says so.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeAction } from "../audit/action";

const ROOT = process.cwd();
const ROUTE = readFileSync(join(ROOT, "app/routes/app.activity.tsx"), "utf8");
const TABLE = readFileSync(join(ROOT, "app/components/ActivityTable.tsx"), "utf8");

describe("the filter and the column it filters use one vocabulary", () => {
  it("renders both through describeAction", () => {
    expect(TABLE).toContain("describeAction(entry.action)");
    expect(ROUTE).toContain("describeAction(action)");
  });

  it("still submits the raw action, so the filter matches", () => {
    // The label is what changed; the value is the key the loader queries by. Prettifying
    // that too would leave a dropdown where every option selects nothing.
    expect(ROUTE).toMatch(/<s-option key=\{action\} value=\{action\}/);
  });

  it("has something to translate, so the check is not vacuous", () => {
    expect(describeAction("campaign.transition")).toBe("Campaign transition");
    expect(describeAction("campaign.transition")).not.toBe("campaign.transition");
  });
});

describe("the app has one pagination", () => {
  it("activity uses the shared one", () => {
    expect(ROUTE).toContain("<Pagination");
  });

  it("keeps none of the arithmetic it used to duplicate", () => {
    // "Page 2 of 69" answers a different question from "26–50 of 1,712", and a merchant
    // scanning for one entry is asking the second. Both the sentence and the ceil() that
    // produced it are gone.
    expect(ROUTE).not.toContain("Math.ceil(total");
    expect(ROUTE).not.toMatch(/Page \{page\} of/);
  });

  it("is not filed under the one section that no longer owns it", () => {
    expect(ROUTE).not.toContain("prices/Pagination");
  });
});

describe("the count and the export share a line", () => {
  it("puts a run of text on the row, not a block element", () => {
    // `s-paragraph` brings its own leading, so an inline stack laid the button out
    // against a box a line and a half tall and the two never shared a baseline.
    expect(ROUTE).not.toMatch(/<s-stack direction="inline"[^>]*>\s*<s-paragraph/);
    expect(ROUTE).toContain("<ActionRow>");
  });
});
