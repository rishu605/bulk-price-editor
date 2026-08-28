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

import { readFileSync } from "node:fs";
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
 * The shared primitives. Every page in the app is assembled from these, so a literal that
 * creeps back in here is not one component drifting — it is the flat rhythm returning
 * everywhere at once.
 */
const PRIMITIVES = [
  "app/components/PageShell.tsx",
  "app/components/SectionTabs.tsx",
  "app/components/AsyncState.tsx",
  "app/components/CountsRow.tsx",
  "app/components/OnboardingCard.tsx",
  "app/components/Pagination.tsx",
  "app/components/prices/VariantSearch.tsx",
];

describe("the shared primitives take their spacing from the scale", () => {
  it("is looking at files that exist, so it cannot pass by checking nothing", () => {
    for (const file of PRIMITIVES) {
      expect(readFileSync(join(ROOT, file), "utf8").length).toBeGreaterThan(0);
    }
  });

  it.each(PRIMITIVES)("%s", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");

    // A literal is how the flat rhythm got in: `gap="base"` is invisible in review and
    // means "whatever base happens to be" rather than "this is the section rhythm".
    // `gap={SPACE.section}` says which relationship is being drawn, and moves when the
    // scale moves.
    const literals = [
      ...source.matchAll(/\s(gap|padding|paddingBlock|paddingBlockEnd)="([^"]*)"/g),
    ].map((match) => `${match[1]}="${match[2]}"`);

    expect(
      literals,
      `${file} hardcodes spacing — use SPACE or PAD from app/lib/ui/spacing, so the ` +
        `rhythm is named rather than guessed`,
    ).toEqual([]);
  });
});
