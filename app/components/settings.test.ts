/**
 * The settings section: one nav item, five destinations, nothing lost.
 *
 * Segments, plan, feedback and diagnostics were four separate top-level nav items
 * between them, all rarely visited, occupying a quarter of the nav.
 *
 * Diagnostics is the one that matters operationally: runbooks link to it, and a person
 * follows those links *while something is going wrong*. Its URL must keep working from
 * a cold link, which is why `/app/debug` still redirects and why this checks the page it
 * redirects to actually exists.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LEGACY_ROUTES } from "../lib/routing/legacy-routes";

const ROUTES = join(process.cwd(), "app", "routes");
const routeFiles = new Set(readdirSync(ROUTES).filter((f) => f.endsWith(".tsx")));
const layout = readFileSync(join(ROUTES, "app.settings.tsx"), "utf8");
const index = readFileSync(join(ROUTES, "app.settings._index.tsx"), "utf8");

describe("everything that moved into settings is still reachable", () => {
  it.each([
    ["segments", "/app/segments"],
    ["plan", "/app/plan"],
    ["feedback", "/app/feedback"],
    ["diagnostics", "/app/debug"],
  ])("%s has a page and its old URL still points at it", (name, oldUrl) => {
    expect(routeFiles.has(`app.settings.${name}.tsx`), `app.settings.${name}.tsx is missing`).toBe(
      true,
    );
    expect(LEGACY_ROUTES[oldUrl]).toBe(`/app/settings/${name}`);
  });

  it("offers all five from the tab bar", () => {
    for (const href of [
      "/app/settings",
      "/app/settings/segments",
      "/app/settings/plan",
      "/app/settings/feedback",
      "/app/settings/diagnostics",
    ]) {
      expect(layout).toContain(`href: "${href}"`);
    }
  });

  it("names the alerts the page actually contains", () => {
    // The tab said "Guardrails & rounding" while the page also held Notifications —
    // a label that undersells a page is a setting nobody finds.
    expect(index).toContain('heading="Notifications"');
    expect(layout).toMatch(/label: "Guardrails, rounding & alerts"/);
  });
});

describe("the long settings page can be navigated without scrolling it", () => {
  // The page names its targets and `JumpTo` turns each into an anchor, so checking the
  // route for `href="#guardrails"` stopped meaning anything. Both halves are checked
  // instead: the section exists and the page asks to jump to it, and the component that
  // renders the ask still renders a real link.
  it.each(["guardrails", "rounding", "notifications"])("has a section for %s", (id) => {
    expect(index).toContain(`id="${id}"`);
    expect(index).toMatch(new RegExp(`\\{ id: "${id}", label: "[^"]+" \\}`));
  });

  it("renders those as real links, not click handlers on a span", () => {
    const jumpTo = readFileSync(
      join(process.cwd(), "app", "components", "JumpTo.tsx"),
      "utf8",
    );

    // Middle-click, open-in-new-tab and copy-link-address all depend on the href being
    // there. The scroll handler is an enhancement over a thing that already means
    // something.
    expect(jumpTo).toContain("href={`#${target.id}`}");
  });
});
