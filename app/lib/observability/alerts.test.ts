/**
 * What is worth waking somebody for.
 *
 * The tests that matter are the ones asserting an alert does *not* fire. An alert that
 * goes off on something nobody acts on teaches people to ignore the channel, and the
 * channel is then useless for the one that matters.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  unpriceableVariants: 0,
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
        unpriceableVariants: null,
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
      unpriceableVariants: 400,
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

describe("every alert leads somewhere", () => {
  /**
   * The runbook link has to resolve, and nothing else checks that.
   *
   * An alert carries an anchor into `docs/runbooks.md`, and the two drift apart in the
   * quietest possible way: somebody renames a heading, every test still passes, and the
   * link only fails for the person following it at 3am — which is the one moment it exists
   * for. Broken then is worse than absent, because absent at least sets expectations.
   *
   * Anchors are derived the way GitHub derives them: lowercase, punctuation dropped,
   * spaces to hyphens.
   */
  const runbook = readFileSync(join(process.cwd(), "docs/runbooks.md"), "utf8");

  const anchorOf = (heading: string) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-");

  const anchors = new Set(
    [...runbook.matchAll(/^##\s+(.+)$/gm)].map(([, heading]) => anchorOf(heading)),
  );

  // Only the `## Alert:` pages. The runbook also carries `## Watch:` sections and
  // procedures like stuck-run recovery, and no alert should be pointing at those.
  const alertSections = new Set(
    [...runbook.matchAll(/^##\s+(Alert:.+)$/gm)].map(([, heading]) => anchorOf(heading)),
  );

  // Every condition at once, so a new alert is covered without anybody remembering to add
  // it here.
  const all = evaluate({
    secondsSinceTick: 10_000,
    webhookLagMs: 10 * 60_000,
    errors: 100,
    requests: 100,
    divergenceRate: 0.5,
    executionQueueDepth: 5_000,
    unpriceableVariants: 400,
  });

  it("fires every condition, so this file cannot silently stop covering one", () => {
    // If a condition is added and this number is not, the assertions below stop being
    // exhaustive without failing — which is the same rot they exist to prevent.
    expect(all.length).toBe(6);
  });

  for (const alert of all) {
    it(`${alert.id} points at a runbook section that exists`, () => {
      const [file, anchor] = alert.runbook.split("#");

      expect(file).toBe("docs/runbooks.md");
      expect(anchor, `${alert.id} has no anchor`).toBeTruthy();
      expect(
        anchors,
        `${alert.id} points at "#${anchor}", which is not a heading in the runbook`,
      ).toContain(anchor);
    });
  }

  /**
   * One page per alert, and no page without an alert.
   *
   * "The anchor resolves" is too weak, and the gap is not hypothetical: `webhook-lag`
   * pointed at the mirror-divergence runbook and `error-spike` at stuck-run recovery.
   * Both anchors existed, so every assertion above passed — and the operator woken at 3am
   * by an error spike read a page about a different incident. Worse than a broken link,
   * which at least announces itself.
   *
   * The runbook also carried an `## Alert:` page for budget saturation, which `NOT_ALERTS`
   * records as deliberately *not* an alert: a documented promise of a page that never
   * comes.
   *
   * A bijection catches all three, and nothing weaker catches any of them.
   */
  it("gives every alert its own page, and every page an alert", () => {
    const claimed = all.map((alert) => alert.runbook.split("#")[1]);

    expect(
      new Set(claimed).size,
      "two alerts share one runbook page, so one of them describes the wrong incident",
    ).toBe(claimed.length);

    expect(new Set(claimed)).toEqual(alertSections);
  });
});
