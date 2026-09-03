/**
 * A card is not named after one of the things inside it.
 *
 * The support form was headed "What happened" and its third field was labelled "What
 * happened" — the same three words twice on one card, with an email address and a
 * subject line between them. A merchant reading down the card met the heading, two
 * unrelated fields, and then the heading again as a label, which reads as a form that
 * has lost its place rather than as a form.
 *
 * Checked rather than remembered because it is the kind of collision that comes back:
 * both strings are the natural name for their own job, and nothing but reading the two
 * together shows the problem.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const support = sourceOf(process.cwd(), "app", "routes", "app.support.tsx");

/** Every `heading="…"` on a section, and every `label="…"` on a field. */
function strings(source: string, attribute: string): string[] {
  return [...source.matchAll(new RegExp(`${attribute}="([^"]+)"`, "g"))].map((match) => match[1]);
}

describe("the support form", () => {
  const headings = strings(support, "heading");
  const labels = strings(support, "label");

  it("finds both, so this cannot pass by checking nothing", () => {
    expect(headings.length).toBeGreaterThanOrEqual(2);
    expect(labels.length).toBeGreaterThanOrEqual(3);
  });

  it("does not label a field with the name of the card it is in", () => {
    const collisions = headings.filter((heading) => labels.includes(heading));

    expect(
      collisions,
      "the card and one of its fields are saying the same words to the same reader",
    ).toEqual([]);
  });

  it("still asks for an account of the problem", () => {
    // The fix must not be to rename the field: what happened is the question, and the
    // heading is what moved.
    expect(labels).toContain("What happened");
  });
});
