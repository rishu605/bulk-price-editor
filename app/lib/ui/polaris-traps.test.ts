/**
 * Three Polaris traps that have already cost this app, kept out mechanically.
 *
 * All three are written up in `docs/polaris-notes.md`, and all three share a shape: the
 * code compiles, the types are satisfied, nothing throws, and the feature is silently
 * broken for the merchant. A document cannot stop the next one — nobody reads it before
 * adding a field — so the traps that can be checked from the source are checked here.
 *
 * None of these is hypothetical. `defaultValue` shipped: the Settings page could not show
 * a merchant their own saved guardrails, app-wide, because React intercepts the prop on
 * form elements and never forwards it to the custom element.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function tsxFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(join(ROOT, current), { withFileTypes: true })) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) found.push(path);
    }
  };
  walk(dir);
  return found;
}

const FILES = [...tsxFiles("app/routes"), ...tsxFiles("app/components")];

/**
 * The tag an attribute belongs to.
 *
 * Walks back to the nearest `<`, which is enough here: JSX attribute values in this app
 * do not contain a bare `<`, and a false positive would name the wrong tag rather than
 * miss one.
 */
function owningTag(source: string, at: number): string {
  const open = source.lastIndexOf("<", at);
  if (open === -1) return "";
  return /^<\s*([A-Za-z][\w.-]*)/.exec(source.slice(open, at))?.[1] ?? "";
}

describe("defaultValue and defaultChecked never reach a Polaris element", () => {
  // React intercepts both on form elements and never forwards them to the custom element,
  // so the field renders empty. It compiles, and it is in the TypeScript types.
  it.each(FILES)("%s", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");

    for (const match of source.matchAll(/\b(defaultValue|defaultChecked)\b/g)) {
      const tag = owningTag(source, match.index!);
      expect(
        tag.startsWith("s-"),
        `${file} passes ${match[1]} to <${tag}>, which renders empty — use ` +
          `${match[1] === "defaultValue" ? "value" : "checked"} instead`,
      ).toBe(false);
    }
  });
});

describe("s-button is never given name or value", () => {
  // It has neither, so a form with two submit buttons cannot tell them apart. The app's
  // pattern is a hidden input the buttons set before submitting.
  it.each(FILES)("%s", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");

    for (const match of source.matchAll(/<s-button\b([^>]*)>/g)) {
      const attributes = match[1];
      expect(
        /\s(name|value)=/.test(attributes),
        `${file} gives <s-button> a name or value, which it does not have — set a hidden ` +
          `input before submitting instead`,
      ).toBe(false);
    }
  });
});

describe("no native form on an embedded surface", () => {
  /**
   * A plain `<form>`, GET or POST, does a full navigation that wipes App Bridge's `host`,
   * `id_token` and `shop`. The server then logs `shop: null` and the merchant sees a
   * blank page.
   *
   * `FilterForm` is the sanctioned wrapper and necessarily contains the one native form;
   * `/help` is deliberately outside the embedded app so it still works when the rest of
   * the app is misbehaving, and says so in a comment.
   */
  const embedded = FILES.filter(
    (file) => !file.endsWith("/FilterForm.tsx") && !file.includes("/help."),
  );

  it("found the embedded surfaces", () => {
    expect(embedded.length).toBeGreaterThan(10);
  });

  it.each(embedded)("%s", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    // Lowercase only: React Router's <Form> is the correct thing and is capitalised.
    expect(
      /<form[\s>]/.test(source),
      `${file} uses a native <form>, which wipes the App Bridge session and leaves the ` +
        `merchant on a blank page — use FilterForm for GET or React Router's <Form> for POST`,
    ).toBe(false);
  });
});
