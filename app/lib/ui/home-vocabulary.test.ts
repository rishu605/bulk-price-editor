/**
 * Home says nothing a merchant has to translate, and its figures lead somewhere.
 *
 * The dashboard's activity card read "Mirror audited / Mirror audit / Market added ×3",
 * all by "Scheduler", on the first screen after installing — two entries nobody can tell
 * apart, both naming an internal concept. And its figures were numbers with no next
 * click: "Need attention: 3" is only useful if the three are one press away.
 *
 * Checked against the source because both are properties of what the page *is*, not of
 * how it renders — and because the route cannot be rendered here without a data router.
 */


import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const HOME = sourceOf("app/routes/app._index.tsx");

const ACTIVITY = sourceOf(process.cwd(), "app/routes/app.activity.tsx");

describe("the dashboard leaves the app's own upkeep to the log", () => {
  it("filters the feed through the one place that decides", () => {
    expect(HOME).toContain("merchantFacing(recent, 5)");
  });

  it("reads more rows than it shows, because the filter comes after the query", () => {
    // A quiet shop's last five entries are all scheduler upkeep. Taking five and then
    // filtering empties the card.
    expect(HOME).toMatch(/take: (\d+),\s*select: \{ id: true, actor: true, action: true/);
    const take = Number(/take: (\d+),\s*select: \{ id: true, actor: true, action: true/.exec(HOME)?.[1]);
    expect(take).toBeGreaterThan(5);
  });

  it("does not filter the activity log itself, which stays complete", () => {
    // Hiding entries from the log would make it stop being the record. The dashboard
    // decides what *leads*; the log decides nothing.
    expect(ACTIVITY).not.toContain("merchantFacing");
    expect(ACTIVITY).not.toContain("isHousekeeping");
  });
});

describe("every figure on the dashboard is a front door", () => {
  it("gives each campaign count a filtered list to open", () => {
    for (const href of [
      "/app/campaigns?status=ACTIVE",
      "/app/campaigns?status=SCHEDULED",
      "/app/campaigns?status=attention",
      "/app/prices/drift",
    ]) {
      expect(HOME, `${href} is not reachable from its tile`).toContain(href);
    }
  });

  it("uses the campaigns index's own filter vocabulary, not a second one", () => {
    // `attention` spans PARTIAL and HELD in `list.server.ts`, which is exactly what the
    // "Need attention" tile counts. Two queries that merely agree today would drift.
    const LIST = sourceOf(process.cwd(), "app/services/campaigns/list.server.ts");

    expect(LIST).toContain('"attention"');
    expect(HOME).toContain("status=attention");
  });

  it("leaves the catalogue figures alone, because they are facts and not queues", () => {
    // "Variants: 3,669" has no page behind it, and giving it one invents a destination.
    const catalogue = HOME.slice(HOME.indexOf('heading="Catalogue"'));

    expect(catalogue.slice(0, catalogue.indexOf("</CountsRow>") + 1)).not.toContain("href:");
  });
});
