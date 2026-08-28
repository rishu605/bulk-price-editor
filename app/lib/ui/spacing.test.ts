/**
 * The scale, and the primitives that are supposed to be using it.
 *
 * The bug this guards is not a crash. It is the state the app was in before: `gap="base"`
 * fifty-four times, `gap` with any other value thirteen times, `padding` twice in the
 * whole codebase. Nothing was broken, everything compiled, and the app looked unstyled —
 * because every relationship on the screen was drawn at the same distance, and spacing is
 * the only thing telling a reader what belongs to what.
 *
 * That regresses one component at a time, silently, and no reviewer catches it by reading
 * a diff that says `gap="base"`. So it is checked here instead:
 *
 * - the rhythms stay far enough apart on the scale to be *seen* as different, and
 * - the shared primitives keep asking the scale rather than writing a literal.
 *
 * Routes are deliberately out of scope. They are a separate pass, and a test that failed
 * on every unrevisited route would be turned off within the week.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PAD, SPACE, type Space } from "./spacing";

const ROOT = process.cwd();

/**
 * Polaris' scale in ascending order, so "is this gap bigger than that one" is an index
 * comparison. The ordering is the part worth writing down: `small` is larger than
 * `small-100`, and `large-100` is larger than `large`, because the numbered steps move
 * away from the middle rather than towards it.
 */
const SCALE: Space[] = [
  "small-500",
  "small-400",
  "small-300",
  "small-200",
  "small-100",
  "small",
  "base",
  "large",
  "large-100",
  "large-200",
  "large-300",
  "large-400",
  "large-500",
];

const step = (value: Space) => SCALE.indexOf(value);

describe("the rhythms are ordered", () => {
  it("gets bigger as the things it separates get further apart in meaning", () => {
    expect(step(SPACE.tight)).toBeLessThan(step(SPACE.item));
    expect(step(SPACE.item)).toBeLessThan(step(SPACE.section));
    expect(step(SPACE.section)).toBeLessThan(step(SPACE.page));
  });

  it("keeps every rhythm on the scale Polaris actually accepts", () => {
    for (const value of Object.values(SPACE)) {
      expect(SCALE, `"${value}" is not a Polaris size keyword`).toContain(value);
    }
  });
});

describe("the rhythms are far enough apart to be visible", () => {
  /**
   * Two adjacent steps on this scale are not reliably distinguishable side by side, and a
   * distinction a merchant cannot see is not a distinction. Two steps apart is the floor;
   * the values chosen are further than that, which leaves room to tune one without the
   * hierarchy collapsing.
   */
  it.each([
    ["item over tight", SPACE.tight, SPACE.item],
    ["section over item", SPACE.item, SPACE.section],
    ["page over section", SPACE.section, SPACE.page],
  ])("%s", (_name, smaller, larger) => {
    expect(
      step(larger) - step(smaller),
      "these two rhythms are neighbours on the scale, so they will read as the same gap",
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("section padding stays inside what s-section allows", () => {
  it("is base or none, because Polaris offers nothing else there", () => {
    // `s-section`'s padding is typed `'base' | 'none'` only. A finer value compiles
    // nowhere, and reaching for one is the signal that the thing wants to be an s-box.
    expect(["base", "none"]).toContain(PAD.card);
    expect(PAD.flush).toBe("none");
  });
});

/**
 * Nothing in the app sets a distance by hand.
 *
 * This checked seven shared primitives when it landed, on the argument that a literal
 * creeping back into those is the flat rhythm returning everywhere at once. True, and it
 * left thirty-nine literals across twenty-two other files — every page in the Prices,
 * Imports and Settings sections, and both halves of the campaign page.
 *
 * `gap="base"` is not *wrong*: it is `SPACE.section`. That is what made it survive four
 * design passes. It says "whatever base happens to be" where `gap={SPACE.section}` says
 * which relationship is being drawn — and the places that meant **item** rhythm (a row of
 * buttons, a field and the button that acts on it) were written `base` too, so they
 * rendered at section rhythm and a row of controls read as a list of unrelated blocks.
 * A rule that only applies to seven files cannot catch that; there is nothing to compare.
 *
 * The exceptions are named, and there are two kinds. Neither is "this one is fine".
 */

/** Rendered outside the embedded admin, with their own CSS and no Polaris scale. */
const OUTSIDE_THE_ADMIN = ["routes/help.$", "routes/_index"];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

const APP = join(ROOT, "app");

const CHECKED = tsxFiles(APP)
  .map((path) => path.replace(`${ROOT}/`, ""))
  .filter((file) => !OUTSIDE_THE_ADMIN.some((skip) => file.includes(skip)))
  .sort();

/**
 * Attribute values a component is allowed to spell out.
 *
 * `s-section` takes only `base` or `none` and there is no finer control, so `padding="none"`
 * on a full-bleed table is naming the only other option Polaris offers rather than
 * choosing a distance. Everything else has to come from the scale.
 */
const NOT_A_RHYTHM = ['padding="none"', 'gap="none"'];

describe("nothing in the app sets a distance by hand", () => {
  it("is looking at the whole app, so it cannot pass by checking nothing", () => {
    expect(CHECKED.length).toBeGreaterThan(40);
    expect(CHECKED).toContain("app/components/PageShell.tsx");
    expect(CHECKED).toContain("app/routes/app.campaigns.new.tsx");
  });

  it.each(CHECKED)("%s", (file) => {
    // Comments stripped first. The repo has been caught by this twice — the compliance
    // check that rejects a native form element greps for `<form`, so the word in a
    // comment trips it — and half the files here explain in prose which literal they
    // replaced and why.
    const source = readFileSync(join(ROOT, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    const literals = [
      ...source.matchAll(
        /\s(gap|padding|paddingBlock|paddingBlockEnd|paddingInline)="([^"]*)"/g,
      ),
    ]
      .map((match) => `${match[1]}="${match[2]}"`)
      .filter((literal) => !NOT_A_RHYTHM.some((allowed) => literal.endsWith(allowed)));

    expect(
      literals,
      `${file} hardcodes spacing — use SPACE, PAD or PAGE_INSET from app/lib/ui/spacing, ` +
        `so the rhythm is named rather than guessed`,
    ).toEqual([]);
  });
});

/**
 * Sections a route nests still get the page rhythm.
 *
 * `s-page` spaces its **direct** children and nothing deeper. The settings page put three
 * sections inside one `fetcher.Form` — correctly, because one Save button submits all
 * three — and `s-page` then saw one form rather than three sections. The cards rendered
 * flush against each other, which reads as one card with a rule through it rather than as
 * three things a merchant can change independently.
 *
 * Nothing caught it: the markup is valid, the sections are all there, and the spacing
 * lives in a layout Polaris only runs in the browser. So the check is structural — a form
 * holding more than one section has to hand them to `PageSections`.
 */
describe("sections nested inside a route's own wrapper keep the page rhythm", () => {
  const ROUTES = CHECKED.filter((file) => file.startsWith("app/routes/"));

  /** Each `<Form>`/`<fetcher.Form>` block in a file, with its contents. */
  function formBlocks(source: string): string[] {
    const blocks: string[] = [];

    for (const open of source.matchAll(/<((?:\w+\.)?Form)\b/g)) {
      const close = source.indexOf(`</${open[1]}>`, open.index);
      if (close !== -1) blocks.push(source.slice(open.index, close));
    }

    return blocks;
  }

  it("is looking at routes, so it cannot pass by checking nothing", () => {
    const withForms = ROUTES.filter((file) => formBlocks(readFileSync(join(ROOT, file), "utf8")).length > 0);

    expect(withForms.length).toBeGreaterThan(5);
  });

  it.each(ROUTES)("%s", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");

    for (const block of formBlocks(source)) {
      const sections = [...block.matchAll(/<s-section\b/g)].length;
      if (sections < 2) continue;

      expect(
        block.includes("<PageSections>"),
        `${file} puts ${sections} sections inside one form, so s-page cannot space them — ` +
          `wrap them in PageSections`,
      ).toBe(true);
    }
  });
});

describe("the page rhythm is set in exactly one place", () => {
  it("is PageShell's, and no route sets it", () => {
    // "Page rhythm has to be the largest gap on the screen to do its job. If a route can
    // set it, some route eventually sets it smaller than the gaps inside its own
    // sections, and the page stops having visible structure at all."
    const offenders = CHECKED.filter(
      (file) => !file.endsWith("PageShell.tsx") && readFileSync(join(ROOT, file), "utf8").includes("SPACE.page"),
    );

    expect(offenders).toEqual([]);
  });
});
