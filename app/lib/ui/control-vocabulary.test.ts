/**
 * A control says what pressing it does, in the merchant's words.
 *
 * #379 took the app's actions out of blue links and gave them a vocabulary of button
 * variants; #381 took SCREAMING_SNAKE out of the badges. Neither looked at the *labels*,
 * and the drift page was still rendering its enum straight into three buttons — `adopt`
 * `reassert` `ignore`, lower case, on the page whose whole job is a considered decision
 * about somebody's storefront.
 *
 * Two things are checked here, and the second is the one that will catch the next
 * instance:
 *
 * - the drift page offers the three decisions in the wording the help centre uses, and
 *   marks exactly the one the aside says is consequential;
 * - no button anywhere renders a bare identifier as its label.
 *
 * The second is a source scan rather than a render, because the failure is a `{value}`
 * interpolation and the value only exists at runtime. What it looks for is a button whose
 * entire label is a lone lower-case interpolated expression — which is what
 * `{resolution}` was, and what a label written on purpose never is.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { rawSource, sourceOf } from "../testing/source";

const APP = join(process.cwd(), "app");
const DRIFT = sourceOf(APP, "routes/app.prices.drift.tsx");
const HELP = rawSource("docs/help/concepts/drift.md");

/** The three labels, extracted from the table the page renders them from. */
function resolutions(): { value: string; label: string; tone: string }[] {
  const block = /const RESOLUTIONS = \[([\s\S]*?)\] as const/.exec(DRIFT);
  if (!block) throw new Error("the drift page no longer declares its resolutions in one place");

  return [
    ...block[1].matchAll(
      /\{\s*value:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*tone:\s*"([^"]+)"\s*\}/g,
    ),
  ].map((match) => ({ value: match[1], label: match[2], tone: match[3] }));
}

describe("the drift page asks a question a merchant can answer", () => {
  const all = resolutions();

  it("offers all three resolutions the service accepts", () => {
    expect(all.map((r) => r.value)).toEqual(["adopt", "reassert", "ignore"]);
  });

  it("labels none of them with its own enum value", () => {
    for (const resolution of all) {
      expect(resolution.label.toLowerCase()).not.toContain(resolution.value);
    }
  });

  it("uses the wording the help centre already documents", () => {
    // The help page had "Keep the change" and "Put it back" before this page existed.
    // Two vocabularies for one decision is how a merchant following the documentation
    // ends up looking for a button that is not there.
    const documented = all.filter((r) => HELP.includes(`**${r.label}**`));

    expect(documented.map((r) => r.value)).toEqual(["adopt", "reassert", "ignore"]);
  });

  it("marks exactly the one that changes what future campaigns compute from", () => {
    expect(all.filter((r) => r.tone === "critical").map((r) => r.value)).toEqual(["adopt"]);
  });

  it("defaults the hidden field to the choice that changes nothing", () => {
    expect(DRIFT).toMatch(/name="resolution"[^>]*value="ignore"/);
  });

  it("shows the drifted price as a value, not inside a badge", () => {
    expect(DRIFT).not.toMatch(/<s-badge[^>]*>\{event\.observed/);
  });
});

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

describe("no button is labelled with a raw value", () => {
  /**
   * A button whose whole label is one interpolated lower-case identifier.
   *
   * `{resolution}` and `{kind}` match; `{choice.label}`, `{formatCount(n)}` and any
   * label with words around it do not — a property access or a call is somebody having
   * decided what the words are, even when the decision lives elsewhere.
   *
   * The attribute part is a tempered `[\s\S]` rather than `[^>]`, and that is the whole
   * difference between this check working and not: half the buttons in the app carry an
   * `onClick={() => …}`, whose arrow contains a `>`, so `[^>]*` stopped inside the
   * attribute list and matched nothing. Mutating a real button to `{row}` is what
   * surfaced it — the first version of this test passed on a file it should have failed.
   * `(?!<\/s-button>)` keeps the match from running past one button into the next.
   */
  const RAW_LABEL =
    /<s-button\b(?:(?!<\/s-button>)[\s\S])*?>\s*\{([a-z][A-Za-z0-9]*)\}\s*<\/s-button>/g;

  /**
   * A name that says "label" is somebody having decided the words.
   *
   * `ImportForm` takes a `checkLabel` prop and renders `{checkLabel}`, which the pattern
   * above cannot tell from `{resolution}`. The difference is real and is in the name: a
   * variable called a label holds a phrase a caller wrote, and the failure this check
   * exists for is a *domain value* reaching the screen — a status, a kind, an action, a
   * resolution. Naming the exemption by suffix rather than listing the file keeps the
   * check meaningful in a component that grows another button.
   */
  const isLabel = (name: string) => /label$/i.test(name);

  const offenders = tsxFiles(APP).flatMap((path) => {
    const source = sourceOf(path);
    return [...source.matchAll(RAW_LABEL)]
      .filter((match) => !isLabel(match[1]))
      .map((match) => `${path.replace(`${APP}/`, "")}: {${match[1]}}`);
  });

  it("finds none", () => {
    expect(
      offenders,
      "a button labelled with a bare value shows the merchant whatever the database calls it",
    ).toEqual([]);
  });
});
