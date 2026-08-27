/**
 * Using the prop that means what we mean.
 *
 * Polaris separates two things the app had been conflating:
 *
 *   `tone`  — status. success, warning, critical, caution, info, and `neutral`, which
 *             asserts *"this has no status"*.
 *   `color` — emphasis. `base`, `strong`, and `subdued`.
 *
 * De-emphasised text was written as `tone="neutral"` in fifteen places. That renders
 * close enough to pass a glance, and it is a different statement: it says a timestamp,
 * a currency code and a "Jump to" label each have a *status*, and that the status is
 * none. On a badge that is exactly right — a `neutral` badge is how "Frozen" says it is
 * a state rather than a warning. On body text it is a category error.
 *
 * There is also no `tone="subdued"`: `subdued` is a colour, so the version of this
 * mistake that reaches for the right word silently does nothing at all.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const APP = join(process.cwd(), "app");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** Routes that deliberately render outside the embedded admin, with their own CSS. */
const OUTSIDE_THE_ADMIN = ["routes/_index", "routes/help.$"];

const files = tsxFiles(APP)
  .filter((path) => !OUTSIDE_THE_ADMIN.some((skip) => path.includes(skip)))
  .map((path) => ({ path: path.replace(`${APP}/`, ""), source: readFileSync(path, "utf8") }));

describe("emphasis is a colour, status is a tone", () => {
  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("never de-emphasises text with a status tone", () => {
    const offenders = files
      .filter(({ source }) => /<s-text\b[^>]*\stone="neutral"/.test(source))
      .map(({ path }) => path);

    expect(
      offenders,
      'these say body text has "no status" when they mean it is quieter — use color="subdued"',
    ).toEqual([]);
  });

  it("never passes subdued as a tone, which silently does nothing", () => {
    const offenders = files
      .filter(({ source }) => source.includes('tone="subdued"'))
      .map(({ path }) => path);

    expect(offenders).toEqual([]);
  });

  it("still allows a neutral badge, which is a real status", () => {
    // "Frozen" is a state, not a warning. Removing this would be the overcorrection.
    const badges = files.filter(({ source }) => /<s-badge\b[^>]*\stone="neutral"/.test(source));
    expect(badges.length, "the neutral badge should not have been swept up").toBeGreaterThan(0);
  });
});

describe("native HTML inside the embedded app", () => {
  /**
   * Three places use it and each is unavoidable, so they are listed rather than
   * forbidden — the list is what makes a *fourth* one visible in review.
   */
  const ALLOWED = new Map([
    // `ui-save-bar` is an App Bridge element whose own types augment
    // `ButtonHTMLAttributes`: native buttons are the documented children.
    ["components/SettingsSaveBar.tsx", "ui-save-bar requires native buttons"],
    // Polaris has no monospace or code text — `s-text`'s types are the only option and
    // offer address/redundant/strong/generic. A stack trace needs preserved whitespace.
    ["components/ErrorScreen.tsx", "no Polaris equivalent for a stack trace"],
    ["routes/app.settings.diagnostics.tsx", "no Polaris equivalent for a stack trace"],
    // No progress component exists; `s-spinner` is indeterminate and has no bar form.
    ["components/RouteProgress.tsx", "no Polaris progress bar"],
  ]);

  it("is confined to the cases that have no Polaris equivalent", () => {
    const offenders = files
      .filter(({ source }) => /<(pre|button|div|span|table|h[1-6])[\s>]/.test(source))
      .map(({ path }) => path)
      .filter((path) => !ALLOWED.has(path));

    expect(
      offenders,
      "these use native HTML where a Polaris component exists — and native elements " +
        "carry none of the admin's styling, so they render as unstyled browser defaults",
    ).toEqual([]);
  });

  it("keeps the allow-list honest by requiring each entry to still exist", () => {
    for (const [path] of ALLOWED) {
      expect(() => statSync(join(APP, path)), `${path} is allow-listed but gone`).not.toThrow();
    }
  });
});
