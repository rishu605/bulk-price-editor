/**
 * What is worth waking somebody for.
 *
 * The tests that matter are the ones asserting an alert does *not* fire. An alert that
 * goes off on something nobody acts on teaches people to ignore the channel, and the
 * channel is then useless for the one that matters.
 */

import { describe, expect, it } from "vitest";

import {
  evaluate,
  DIVERGENCE_RATE,
  NOT_ALERTS,
  TICK_SILENCE_SECONDS,
  WEBHOOK_LAG_MS,
  type SignalWindow,
} from "./alerts";

const quiet: SignalWindow = {
  secondsSinceTick: 30,
  webhookLagMs: 1_000,
  errors: 0,
  requests: 500,
  divergenceRate: 0,
  executionQueueDepth: 0,
};

const ids = (window: Partial<SignalWindow>) =>
  evaluate({ ...quiet, ...window }).map((alert) => alert.id);

describe("a healthy window", () => {
  it("fires nothing", () => {
    expect(evaluate(quiet)).toEqual([]);
  });
});

describe("the conditions that page", () => {
  it("fires when the scheduler has gone quiet", () => {
    expect(ids({ secondsSinceTick: TICK_SILENCE_SECONDS + 1 })).toContain("scheduler-stopped");
  });

  it("does not fire at exactly the threshold", () => {
    // A tick landing right on the boundary is alive. Firing there means firing on a
    // slightly slow but working scheduler, every time.
    expect(ids({ secondsSinceTick: TICK_SILENCE_SECONDS })).not.toContain("scheduler-stopped");
  });

  it("fires on webhook lag past five minutes", () => {
    expect(ids({ webhookLagMs: WEBHOOK_LAG_MS + 1 })).toContain("webhook-lag");
  });

  it("fires on systematic mirror divergence", () => {
    expect(ids({ divergenceRate: DIVERGENCE_RATE + 0.001 })).toContain("mirror-divergence");
  });

  it("fires on an error spike", () => {
    expect(ids({ errors: 30, requests: 100 })).toContain("error-spike");
  });
});

describe("what a missing signal means", () => {
  it("does not alert when a signal is absent", () => {
    // Null is not zero. A missing signal means we do not know, and alerting on "we do
    // not know" turns a monitoring outage into an application incident at 3am.
    expect(
      evaluate({
        secondsSinceTick: null,
        webhookLagMs: null,
        errors: 0,
        requests: 0,
        divergenceRate: null,
        executionQueueDepth: null,
      }),
    ).toEqual([]);
  });
});

describe("not alerting on noise", () => {
  it("ignores an error rate computed from almost no requests", () => {
    // One error in three during a quiet night is 33% and means nothing. An alert that
    // fires on it every night is one nobody reads by the end of the week.
    expect(ids({ errors: 1, requests: 3 })).not.toContain("error-spike");
  });

  it("fires once the sample is big enough to mean something", () => {
    expect(ids({ errors: 5, requests: 40 })).toContain("error-spike");
  });

  it("treats a queue backlog as a notice rather than a page", () => {
    const alerts = evaluate({ ...quiet, executionQueueDepth: 500 });

    expect(alerts.map((alert) => alert.severity)).toEqual(["notice"]);
  });
});

describe("several things wrong at once", () => {
  it("reports every condition rather than the first", () => {
    // A stopped tick and an execution backlog together is a different incident from
    // either alone, and an alert that stopped at the first would hide that.
    const firing = ids({ secondsSinceTick: 600, executionQueueDepth: 500 });

    expect(firing).toContain("scheduler-stopped");
    expect(firing).toContain("execution-backlog");
  });
});

describe("every alert is actionable", () => {
  it("has a runbook and says why it matters", () => {
    // An alert without a runbook is a notification, and a notification at 3am is worse
    // than nothing because somebody is now awake and none the wiser.
    const all = evaluate({
      secondsSinceTick: 10_000,
      webhookLagMs: 10 * 60_000,
      errors: 100,
      requests: 100,
      divergenceRate: 0.5,
      executionQueueDepth: 5_000,
    });

    expect(all.length).toBeGreaterThan(0);
    for (const alert of all) {
      expect(alert.runbook).toMatch(/^docs\/runbooks\.md#/);
      expect(alert.because.length).toBeGreaterThan(40);
    }
  });

  it("records what is deliberately not an alert, and why", () => {
    // Written down rather than merely absent, because the next person looking at a graph
    // will want to add them and the reason not to is not visible from the graph.
    expect(NOT_ALERTS.length).toBeGreaterThan(0);
    for (const entry of NOT_ALERTS) {
      expect(entry.because.length).toBeGreaterThan(20);
    }
  });
});
