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
    // The sync runs in the worker since #801: it collects both sets, says them on Home when
    // it finishes, and returns them when it runs in the request.
    const job = sourceOf("app/services/sync-job.server.ts");
    expect(job).toContain("const errors = [...catalogue.errors, ...markets.errors];");
    expect(job).toContain("errors.length > 0");
    expect(job).toContain("ok: summary.errors.length === 0");
    expect(job).toContain("errors: summary.errors.slice(0, 5)");
    expect(HOME).toContain("return startSync(");
  });
});
