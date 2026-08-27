/**
 * Every prop passed to a Polaris element is one Polaris actually has.
 *
 * TypeScript does not check this. The `s-*` elements are custom elements whose React
 * props are declared loosely, so an attribute Polaris has never heard of typechecks,
 * builds, serialises, and then makes the element render **nothing** in the browser —
 * taking its children with it.
 *
 * Two real instances of that in this codebase, both found only by loading the page:
 * wrapping `s-page`'s children in an `s-stack` blanked every sidebar-less route, and
 * `s-button-group` laid a row out correctly while rendering none of its buttons. Both
 * passed typecheck, the unit suite and lint.
 *
 * A third suspected instance was a misdiagnosis worth recording, because it cost more
 * than the bug. The calendar rendered blank right after an edit, `paddingInline` on
 * `s-box` looked like the culprit, and it is not — Polaris declares it, and the page
 * renders with it restored. It was a transient, most likely stale hot-reload state. The
 * lesson is that "I changed X and the page went blank" is not evidence about X, and the
 * cheap way to find out is to put X back and reload.
 *
 * So this checks the thing that is actually checkable: the compiler will not tell you
 * whether a prop name exists, and the types will.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const POLARIS_TYPES = join(
  process.cwd(),
  "node_modules",
  "@shopify",
  "polaris-types",
  "dist",
  "polaris.d.ts",
);

/** Every property name Polaris declares anywhere in its type surface. */
function polarisProps(): Set<string> {
  const source = readFileSync(POLARIS_TYPES, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9]*)\??:/gm)) names.add(match[1]);
  return names;
}

/** Props React itself handles, plus ours. None of these reach Polaris as attributes. */
const NOT_POLARIS = new Set([
  "key",
  "ref",
  "className",
  "style",
  "children",
  "slot",
  "dangerouslySetInnerHTML",
]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

/** `<s-thing propA={…} propB="…">` → every propA/propB, with where it was used. */
function propsUsed(): Array<{ file: string; element: string; prop: string }> {
  const found: Array<{ file: string; element: string; prop: string }> = [];
  const app = join(process.cwd(), "app");

  for (const path of tsxFiles(app)) {
    const source = readFileSync(path, "utf8");
    for (const tag of source.matchAll(/<(s-[a-z-]+)((?:\s+[^<>]*?)?)\/?>/g)) {
      const [, element, attrs] = tag;
      if (!attrs) continue;
      // `=(?!=)` so a comparison inside a JSX expression is not read as an attribute.
      // `kind === "set-exact"` in a `label={…}` looked exactly like `kind=` otherwise,
      // and the first version of this check reported it as an unknown prop.
      for (const attr of attrs.matchAll(/(?:^|\s)([a-zA-Z][a-zA-Z0-9]*)\s*=(?!=)/g)) {
        const prop = attr[1];
        if (NOT_POLARIS.has(prop) || prop.startsWith("on") || prop.startsWith("data")) continue;
        found.push({ file: path.replace(`${app}/`, ""), element, prop });
      }
    }
  }
  return found;
}

describe("props passed to Polaris elements", () => {
  const declared = polarisProps();
  const used = propsUsed();

  it("finds elements to check, so this cannot pass by matching nothing", () => {
    expect(declared.size).toBeGreaterThan(100);
    expect(used.length).toBeGreaterThan(80);
  });

  it("are all props Polaris declares", () => {
    const unknown = used
      .filter(({ prop }) => !declared.has(prop))
      .map(({ file, element, prop }) => `${file}: <${element} ${prop}=…>`);

    expect(
      [...new Set(unknown)],
      "Polaris does not declare these anywhere. TypeScript will not complain and the " +
        "build will succeed, because these are custom elements whose React props are " +
        "declared loosely — so the first sign is an element rendering nothing in the " +
        "browser, taking its children with it",
    ).toEqual([]);
  });
});
