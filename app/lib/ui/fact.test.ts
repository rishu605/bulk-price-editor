/**
 * "A value and what it is called" is rendered one way.
 *
 * It was three. Home's store card wrote a subdued `s-text` above a plain one and repeated
 * the shape for each fact; `CountsRow` drew the same pair inside a bordered tile; and the
 * campaign page arranged it a third way. Three parts of the app answering the same
 * question differently is how a page stops looking like one app.
 *
 * The caption goes above the value rather than beside it. Beside, the two compete for one
 * line and the eye has to work out which is which — which is exactly what two loose
 * paragraphs did on Home before anything named this shape.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const APP = join(process.cwd(), "app");

function sources(dir: string): Array<{ path: string; source: string }> {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".tsx") || entry.name.includes(".test.")) return [];
    return [{ path: path.replace(`${APP}/`, ""), source: sourceOf(path) }];
  });
}

describe("the labelled fact", () => {
  const fact = sourceOf(join(APP, "components", "Fact.tsx"));

  it("puts the caption above the value", () => {
    const body = fact.slice(fact.indexOf("<s-stack"));

    expect(body.indexOf("<Caption>{label}")).toBeLessThan(body.indexOf("{children}"));
  });

  it("uses the shared caption rank rather than its own grey", () => {
    expect(fact).toContain('from "./Type"');
    expect(fact).not.toContain('color="subdued"');
  });

  it("keeps the qualifying line tied to the fact rather than floating after it", () => {
    expect(fact).toContain("{detail ?");
  });
});

describe("nobody writes it out by hand", () => {
  /**
   * The shape being refused: a stack whose first child is a subdued `s-text` and whose
   * second is a plain one. That is `Fact`, and writing it out is how the third rendering
   * of it appears.
   */
  const HAND_ROLLED =
    /<s-stack gap=\{SPACE\.tight\}>\s*<s-text color="subdued">[^<]*<\/s-text>\s*<s-text[ >]/;

  it("finds the files, so this cannot pass by checking nothing", () => {
    expect(sources(APP).length).toBeGreaterThanOrEqual(40);
  });

  it("holds across the app", () => {
    const offenders = sources(APP)
      .filter(({ path }) => path !== "components/Fact.tsx")
      .filter(({ source }) => HAND_ROLLED.test(source.replace(/\n\s*/g, "\n")))
      .map(({ path }) => path);

    expect(
      offenders,
      "a subdued label above a value is a `Fact` — writing it out is how the third rendering appears",
    ).toEqual([]);
  });
});
