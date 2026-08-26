/**
 * The verdict a perf run prints.
 *
 * The numbers themselves need a store; what they *mean* does not, and the meaning is
 * where a perf harness usually goes wrong — by reporting a pass for something it never
 * observed. A baseline that says PASS on memory it never sampled is worse than no
 * baseline, because it is the one somebody quotes later.
 */

import { describe, expect, it } from "vitest";

import { verdict, type ImportBaseline } from "./measure-import";

const baseline = (over: Partial<ImportBaseline> = {}): ImportBaseline => ({
  label: "test",
  startedAt: "2026-08-27T00:00:00.000Z",
  elapsedSeconds: 600,
  memory: { peakRssMb: 220, samples: 30 },
  variantsAfter: 100_000,
  productsAfter: 2_000,
  variantsAdded: 100_000,
  maxVariantProduct: { handle: "gid://shopify/Product/1", variants: 2_048 },
  exitCode: 0,
  ...over,
});

describe("the time budget", () => {
  it("passes an import inside thirty minutes", () => {
    expect(verdict(baseline()).join(" ")).toContain("PASS  import finished in 10.0 min");
  });

  it("fails one that runs over", () => {
    const lines = verdict(baseline({ elapsedSeconds: 31 * 60 })).join(" ");

    expect(lines).toContain("FAIL");
    expect(lines).toContain("31.0 min");
  });

  it("treats exactly thirty minutes as within budget", () => {
    expect(verdict(baseline({ elapsedSeconds: 30 * 60 }))[0]).toMatch(/^PASS/);
  });
});

describe("the memory ceiling", () => {
  it("passes under 512MB and says how many samples that is from", () => {
    expect(verdict(baseline())[1]).toMatch(/PASS.*220MB across 30 samples/);
  });

  it("fails over the ceiling", () => {
    expect(verdict(baseline({ memory: { peakRssMb: 700, samples: 12 } }))[1]).toMatch(/^FAIL/);
  });

  it("says UNKNOWN rather than PASS when it never sampled", () => {
    // The failure this exists to prevent: a fast import reports a memory pass it has no
    // evidence for, and that number gets quoted as a baseline.
    const line = verdict(baseline({ memory: { peakRssMb: 0, samples: 0 } }))[1]!;

    expect(line).toMatch(/^UNKNOWN/);
    expect(line).not.toContain("PASS");
  });
});

describe("the 2,048-variant product", () => {
  it("passes when the mirror actually holds one", () => {
    expect(verdict(baseline())[2]).toMatch(/PASS.*2048 variants/);
  });

  it("does not claim a pass for a smaller product", () => {
    // A bulk import that rejected it reports the same "completed" as one that took it.
    const line = verdict(baseline({ maxVariantProduct: { handle: "x", variants: 50 } }))[2]!;

    expect(line).toMatch(/^NOT YET/);
    expect(line).toContain("--max-variant-product");
  });

  it("says UNKNOWN with an empty mirror rather than failing it", () => {
    expect(verdict(baseline({ maxVariantProduct: null }))[2]).toMatch(/^UNKNOWN/);
  });
});

describe("what it always reports", () => {
  it("says how many variants were added and how many exist", () => {
    // The counts are observed from the mirror, not the ones the seeder was asked for —
    // which is how a "100K store" turns out to be 40K.
    expect(verdict(baseline({ variantsAdded: 40_000, variantsAfter: 43_670 })).join(" ")).toContain(
      "40000 variants added, 43670 now in the mirror",
    );
  });
});
