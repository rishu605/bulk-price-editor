/**
 * Colour is never the only thing carrying a meaning.
 *
 * WCAG 1.4.1. The failure it prevents is a merchant who cannot distinguish the red banner
 * from the green one being told a run succeeded when it did not — which in this app is
 * the difference between prices being live and prices being wrong.
 *
 * A static test cannot see a rendered page, and it cannot judge whether the words next to
 * a colour actually explain it. What it can do is refuse the case that has no words at
 * all — a badge that is a coloured dot, a cell tinted by state with nothing in it. Those
 * pass a visual review and fail a merchant on a monochrome display or a screen reader.
 *
 * Only *status* tones are checked. `neutral` is de-emphasis rather than a signal: it says
 * "this matters less", which is not information a reader loses without colour.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

/** Every component and route the merchant sees. */
function sources(): string[] {
  const out: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(full);
    }
  };

  walk(join(ROOT, "app/components"));
  walk(join(ROOT, "app/routes"));
  return out;
}

const files = sources();

/**
 * The element a `tone` sits on, plus enough of what follows to see whether it says
 * anything. Tone is set on banners, badges and text; the question is the same for all of
 * them — is there a word here, or only a colour?
 */
/** Tones that communicate state, and therefore must not communicate it by colour alone. */
const STATUS_TONES = new Set(["critical", "success", "warning", "caution", "info"]);

function tonedElements(source: string): Array<{ tag: string; tone: string; body: string }> {
  const found: Array<{ tag: string; tone: string; body: string }> = [];

  for (const match of source.matchAll(/<(s-[a-z-]+)([^>]*\btone="([a-z]+)"[^>]*)>/g)) {
    if (!STATUS_TONES.has(match[3]!)) continue;
    const [opening, tag, , tone] = match;
    const from = match.index! + opening.length;
    // Up to the closing tag, or a generous window when it is self-contained.
    const close = source.indexOf(`</${tag}>`, from);
    found.push({
      tag: tag!,
      tone: tone!,
      body: source.slice(from, close === -1 ? from + 400 : close),
    });
  }

  return found;
}

describe("every tone is accompanied by words", () => {
  it("finds tones to check", () => {
    const total = files.reduce((sum, file) => sum + tonedElements(readFileSync(file, "utf8")).length, 0);

    // Without this the assertion below passes on an empty set and proves nothing.
    expect(total).toBeGreaterThan(20);
  });

  it.each(files.filter((file) => tonedElements(readFileSync(file, "utf8")).length > 0))(
    "%s",
    (file) => {
      for (const element of tonedElements(readFileSync(file, "utf8"))) {
        // Literal words, or an interpolation — which is content, even though this cannot
        // read it. What fails here is an element with neither: colour and nothing else.
        const hasContent = /[A-Za-z]{3,}/.test(element.body) || /\{[^}]+\}/.test(element.body);

        expect(
          hasContent,
          `a <${element.tag} tone="${element.tone}"> in ${file.replace(ROOT + "/", "")} ` +
            `carries nothing, so its meaning is only its colour`,
        ).toBe(true);
      }
    },
  );
});

describe("the result banner says which outcome it is, not just which colour", () => {
  it("names the outcome in words for every tone it can take", () => {
    // The specific banner this rule exists for: a partial run is `critical`, a clean one
    // `success`, and a merchant who cannot tell those apart by colour has to be able to
    // read the difference.
    const source = readFileSync(join(ROOT, "app/components/RunResultSection.tsx"), "utf8");

    expect(source).toContain("result.summary");
    // And the summary itself is built from words — `describeRun` is tested separately for
    // leading with failures.
    expect(source).toMatch(/tone=\{[^}]*success[^}]*critical[^}]*warning[^}]*\}/s);
  });
});
