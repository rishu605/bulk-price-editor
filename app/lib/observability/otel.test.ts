/**
 * Choosing the right instrument, and not exporting a price as an attribute.
 *
 * The instrument choice does not fail loudly when it is wrong — it produces a panel that
 * is quietly meaningless, which is worse than an empty one, because somebody builds an
 * alert on it.
 */

import { describe, expect, it } from "vitest";

import { attributesFrom, INSTRUMENTS } from "./otel.server";

describe("instrument choice", () => {
  it("counts the things that are counts", () => {
    // Rows written and jobs enqueued are totals. As histograms the total disappears,
    // which is the only thing anybody wants from them.
    expect(INSTRUMENTS["run.rows"]).toBe("counter");
    expect(INSTRUMENTS["queue.enqueued"]).toBe("counter");
    expect(INSTRUMENTS["queue.failed"]).toBe("counter");
    expect(INSTRUMENTS["scheduler.tick"]).toBe("counter");
  });

  it("distributes the things that are durations", () => {
    // As a counter, `run.duration_ms` would report total milliseconds ever spent, which
    // is a number nobody wants. p95 is the question.
    expect(INSTRUMENTS["run.duration_ms"]).toBe("histogram");
    expect(INSTRUMENTS["webhook.lag_ms"]).toBe("histogram");
  });

  it("gauges the things that are levels", () => {
    // Queue depth summed over a day is meaningless; queue depth right now is the alert.
    expect(INSTRUMENTS["queue.depth"]).toBe("gauge");
    expect(INSTRUMENTS["budget.saturation"]).toBe("gauge");
    expect(INSTRUMENTS["mirror.divergence_rate"]).toBe("gauge");
  });

  it("has an instrument for every metric the app emits", () => {
    // The map is keyed by the same union the rest of the app uses, so a new metric will
    // not compile until somebody has decided what kind of thing it is.
    expect(Object.keys(INSTRUMENTS).length).toBeGreaterThan(0);
    for (const kind of Object.values(INSTRUMENTS)) {
      expect(["counter", "histogram", "gauge"]).toContain(kind);
    }
  });
});

describe("attributes", () => {
  it("keeps the labels that make a metric actionable", () => {
    expect(attributesFrom({ shopId: "s1", queue: "execution", outcome: "verified" })).toEqual({
      shopId: "s1",
      queue: "execution",
      outcome: "verified",
    });
  });

  it("redacts a price out of a label", () => {
    // An attribute is exported verbatim to whoever is collecting. The rule does not
    // change because the destination is a metrics backend rather than an error tracker.
    const attributes = attributesFrom({ shopId: "s1", price: 1999 } as never);

    expect(attributes.price).not.toBe(1999);
  });

  it("drops undefined rather than exporting the string 'undefined'", () => {
    // Which is what a naive String() would produce, and it makes a dashboard filter on
    // an attribute that looks present and is not.
    const attributes = attributesFrom({ shopId: "s1", runId: undefined });

    expect("runId" in attributes).toBe(false);
  });

  it("stringifies anything that is not a primitive", () => {
    const attributes = attributesFrom({ shopId: "s1", detail: { a: 1 } as never });

    expect(typeof attributes.detail).toBe("string");
  });
});
