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

/**
 * A fourth trap, from React Router rather than Polaris, and the same shape as the three
 * above: it compiles, it typechecks, every test passes, and it fails at `npm run build`.
 *
 * React Router strips `loader`, `action`, `middleware` and `headers` from the client
 * bundle, so a route may import a `*.server` module for those. Anything *else* in the
 * file that references one drags it into the browser build, which the bundler refuses
 * with "Server-only module referenced by client".
 *
 * `docs/polaris-notes.md` records this having been hit three times — "rollback CSV,
 * activity CSV, `describeActor`". It has now been hit a fourth: a component reading a
 * `PAGE_SIZE` constant out of `reconciliation.server` so its pager could not disagree
 * with the query. Reasonable, and unbuildable. The constant lives in the UI scale now,
 * which both sides read.
 *
 * Components are the checkable half: they have no loader, so a value imported from a
 * `*.server` module in one is always this bug. A type is fine — types are erased.
 */
describe("no component pulls a server module into the browser bundle", () => {
  function componentFiles(dir: string): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return componentFiles(path);
      return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  const files = componentFiles("app/components").map((path) => ({
    path,
    source: readFileSync(join(ROOT, path), "utf8"),
  }));

  it("finds the components, so it cannot pass by checking nothing", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  /**
   * Whether an import clause survives compilation.
   *
   * `import type { X }` and `import { type X }` are both erased; `import { X }` is not.
   * The first version of this checked for an optional `type` group in one pattern, and a
   * lazy `[\s\S]*?` beside an optional group simply skips it — every type-only import in
   * the app was reported as a bundle error. A clause is easier to reason about than a
   * regex with a hole in it.
   */
  const erased = (clause: string) => {
    const trimmed = clause.trim();
    if (trimmed.startsWith("type ")) return true;

    const named = /^\{([\s\S]*)\}$/.exec(trimmed);
    if (!named) return false;

    return named[1]
      .split(",")
      .map((binding) => binding.trim())
      .filter(Boolean)
      .every((binding) => binding.startsWith("type "));
  };

  /**
   * The import statements in a file, reassembled from its lines.
   *
   * Not a regex over the whole source. A lazy `[\s\S]*?` between `import` and `from`
   * happily spans *earlier* import statements, so the first version read three imports as
   * one and attributed the wrong clause to the server module at the end of them — which
   * reported every type-only import in the app as a bundle error. Walking back from the
   * `from` line to the `import` that opened it cannot do that.
   */
  const importStatements = (source: string): string[] => {
    const lines = source.split("\n");
    const statements: string[] = [];

    lines.forEach((line, index) => {
      if (!/\bfrom\s+"/.test(line)) return;

      let start = index;
      while (start > 0 && !lines[start].trimStart().startsWith("import")) start -= 1;
      if (!lines[start].trimStart().startsWith("import")) return;

      statements.push(lines.slice(start, index + 1).join("\n"));
    });

    return statements;
  };

  it("imports server modules for their types only", () => {
    const offenders = files.flatMap(({ path, source }) =>
      importStatements(source)
        .map((statement) => /^import\s+([\s\S]*?)\s+from\s+"([^"]*\.server)"/.exec(statement))
        .filter((match): match is RegExpExecArray => match !== null && !erased(match[1]))
        .map((match) => `${path} -> ${match[2]}`),
    );

    expect(
      offenders,
      "these import a value from a *.server module; `npm run build` refuses it, and " +
        "nothing before the build will tell you",
    ).toEqual([]);
  });
});
