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

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { LEGACY_ROUTES } from "../lib/routing/legacy-routes";

const ROUTES = join(process.cwd(), "app", "routes");
const routeFiles = new Set(readdirSync(ROUTES).filter((f) => f.endsWith(".tsx")));
const layout = sourceOf(ROUTES, "app.settings.tsx");
const index = sourceOf(ROUTES, "app.settings._index.tsx");

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

describe("the long settings page keeps its three sections", () => {
  // It carried a row of jump links to these for a while. The links were removed — a row
  // of chips under the tab bar read as more chrome, not as help — but the reason the
  // page has three named blocks in the first place has not changed: guardrails, rounding
  // and alerts are read together, and splitting them across routes is what made the nav
  // sixteen items long.
  it.each(["Guardrails", "Rounding", "Notifications"])("still has a %s section", (heading) => {
    expect(index).toContain(`heading="${heading}"`);
  });
});
