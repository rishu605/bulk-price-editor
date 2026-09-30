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
    expect(HOME).toContain("const problems = [...sync.errors, ...markets.errors];");
    expect(HOME).toContain("ok: problems.length === 0,");
    expect(HOME).toContain("errors: problems.slice(0, 5),");
  });
});
