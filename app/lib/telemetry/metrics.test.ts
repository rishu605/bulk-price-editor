/**
 * The SLO numbers, and the empty case that decides whether they mean anything.
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import { metric, rate } from "./metrics";

afterEach(() => vi.restoreAllMocks());

describe("rate", () => {
  it("expresses a fraction", () => {
    expect(rate(3, 4)).toBe(0.75);
    expect(rate(0, 4)).toBe(0);
  });

  it("returns null for no data rather than zero", () => {
    // Zero out of zero is not a zero rate. Reporting it as 0 makes an idle shop
    // indistinguishable from a completely broken one on the same panel, and the alert
    // built on that panel fires on the wrong one.
    expect(rate(0, 0)).toBeNull();
    expect(rate(5, -1)).toBeNull();
  });
});

describe("metric", () => {
  it("emits a named measurement with its labels", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    metric("run.duration_ms", 8_042, { shopId: "s1", runId: "r1" });

    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).toContain("run.duration_ms");
    expect(String(log.mock.calls[0][0])).toContain("8042");
  });

  it("never throws, whatever it is handed", () => {
    // A metric describes work that already happened. An exporter failing must not be
    // able to change the work.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => metric("queue.depth", 1, cyclic as never)).not.toThrow();
  });

  it("carries no price into a label", () => {
    // A metric label is worse than a log line for this: high-cardinality, long
    // retention, indexed.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    metric("run.rows", 3, { price: "19.99" } as never);
    expect(String(log.mock.calls[0][0])).not.toContain("19.99");
  });
});
