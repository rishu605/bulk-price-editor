/**
 * Home's Re-sync reports the market sync's problems as well as the catalogue's (#733).
 *
 * A market sync refused because a stranded bulk record said a catalogue import was still
 * running was silent: the banner reported only the catalogue sync's errors, and said the
 * sync had worked. Checked against the source, because the action cannot run here without
 * Shopify.
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const HOME = sourceOf("app/routes/app._index.tsx");

describe("the Re-sync banner", () => {
  it("counts a market sync that refused as a problem, and names it", () => {
    // The sync runs in the worker since #801, and only there since D29 (#808): it collects
    // both sets, and says them on Home when it finishes, in the sentence the shop row keeps.
    const job = sourceOf("app/services/sync-job.server.ts");
    expect(job).toContain("const errors = [...catalogue.errors, ...markets.errors];");
    expect(job).toMatch(/await releaseSync\(\s*shopId,\s*errors\.length > 0/);
    expect(job).toContain("errors.slice(0, 3)");
    expect(HOME).toContain("return startSync(");
  });

  it("never runs the sync in Home's request, so its problems are always the worker's to say (#808)", () => {
    const job = sourceOf("app/services/sync-job.server.ts");
    const startSync = job.slice(job.indexOf("export async function startSync("), job.indexOf("export async function ringQueuedSyncs("));
    expect(startSync.length).toBeGreaterThan(100);
    expect(startSync).not.toContain("runFullSync(");
  });
});
