/**
 * Whether a `@container` value has anything to measure against.
 *
 * A CSS container query resolves against the nearest ancestor **container**, and an
 * element only becomes one if something sets `container-type`. Polaris sets it in exactly
 * one place — `s-query-container` — so a responsive value with no such ancestor silently
 * takes its unmatched branch at every width, on every screen.
 *
 * Eight layouts in this app were in that state. Home's aside never fell below the content
 * however narrow the admin got: at a 900px window the main column was squeezed to about
 * 150px while the 22rem aside kept its full width, and the checklist drew its own title
 * on top of its "Why?" button at 1200px.
 *
 * ## Why this guard is a source check
 *
 * Because the failure is invisible everywhere else. The unmatched branch is the correct
 * layout for the widest place each component is used, so the page you would open to check
 * looks right; the markup is identical either way, so a render test passes; and the only
 * thing that differs is which branch a browser picks, which no unit test can see. The
 * first attempt at this (#560) passed 3,433 tests, typecheck, lint, build and CI, and was
 * reverted within the hour for a layout nobody could have caught without looking.
 *
 * So the check is the one thing that is checkable: a component that asks for a container
 * query has to have asked for a container too.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../lib/testing/source";

/**
 * The ones still without a container, and why.
 *
 * `FieldGrid` is the landmine that caused #560 to be reverted: wrapped, the campaign
 * editor's fields came out as two columns of about 10px and 445px. Its symptom — three
 * truncated selects — was fixed another way in #562, so it is not urgent, and it wants
 * looking at on its own rather than riding along with Home's. The other two are on pages
 * this ticket did not open. Tracked as a follow-up.
 */
const OUTSTANDING = [
  "app/components/FieldGrid.tsx",
  "app/components/prices/VariantSearch.tsx",
  "app/routes/app.help.tsx",
];

/** A responsive value, not a comment mentioning one. */
const ASKS_FOR_A_CONTAINER = /gridTemplateColumns=[^\n]*@container/;

const files = sourceFiles("app").filter((file) => ASKS_FOR_A_CONTAINER.test(sourceOf(file)));

describe("every container query", () => {
  it("is asked for by a file this check can see", () => {
    // A guard that silently matches nothing is the failure mode this repo has hit before.
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((file) => [file.replace(`${process.cwd()}/`, "")]))(
    "has something to measure against in %s",
    (file) => {
      if (OUTSTANDING.includes(file)) return;

      expect(
        sourceOf(file),
        `${file} chooses its columns with a container query and renders no QueryContainer, so the query resolves against nothing and the value never matches`,
      ).toMatch(/<QueryContainer>/);
    },
  );

  it("keeps the outstanding list honest", () => {
    // A file that gains a container should leave this list, and a list naming a file that
    // no longer has a query is a note about nothing.
    for (const file of OUTSTANDING) {
      const source = sourceOf(file);
      expect(source, `${file} no longer has a container query — take it off the list`).toMatch(
        ASKS_FOR_A_CONTAINER,
      );
      expect(
        source,
        `${file} has a container now — take it off the list`,
      ).not.toMatch(/<QueryContainer>/);
    }
  });
});
