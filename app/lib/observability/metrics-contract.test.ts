/**
 * Metrics that are declared, metrics that are emitted, and metrics a runbook promises.
 *
 * Three lists that have to agree and had no reason to. `budget.saturation` and
 * `webhook.lag_ms` were both declared in the registry and named in runbook pages, and
 * neither was ever emitted — so an operator following a page at 3am went looking for a
 * graph that did not exist. One of the two was named by a runbook page written earlier
 * the same day, which is how quickly this drifts.
 *
 * A dead declaration is the quieter half: it costs nothing at runtime and makes the
 * dashboard look complete when it is not.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

const ROOT = process.cwd();

/** Every `metric("name", …)` call in the app. */
function emitted(): Set<string> {
  const names = new Set<string>();

  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;

      const source = sourceOf(path);
      for (const [, name] of source.matchAll(/\bmetric\(\s*"([a-z0-9_.]+)"/g)) names.add(name);
    }
  };

  walk("app");
  return names;
}

/** The registry in `otel.server.ts`, which decides each metric's instrument type. */
function declared(): Set<string> {
  const source = sourceOf("app/lib/observability/otel.server.ts");
  const table = source.slice(source.indexOf("{"), source.indexOf("};") + 1);
  return new Set([...table.matchAll(/"([a-z0-9_]+\.[a-z0-9_]+)":\s*"(counter|gauge|histogram)"/g)].map(
    ([, name]) => name,
  ));
}

/** Metric names a runbook page tells somebody to go and look at. */
function promised(): Set<string> {
  const runbook = readFileSync(join(ROOT, "docs/runbooks.md"), "utf8");
  return new Set(
    [...runbook.matchAll(/`([a-z0-9_]+\.[a-z0-9_]+)`/g)]
      .map(([, name]) => name)
      // Table and column names also arrive in backticks and are not metrics.
      .filter((name) => !/^(scheduler_heartbeat|variant_changes|error_events|webhook_events)\./.test(name))
      // Neither are filenames. A runbook that names the module deciding a severity is
      // being helpful, and `alerts.ts` matching "word.word" would otherwise be read as a
      // metric nothing emits. A source-file suffix cannot be a metric name here: metrics
      // are `domain.measure`, and no domain is called "ts".
      .filter((name) => !/\.(ts|tsx|md|json|sql|yml|yaml|toml)$/.test(name)),
  );
}

describe("the three lists of metric names agree", () => {
  const isEmitted = emitted();
  const isDeclared = declared();
  const isPromised = promised();

  it("found all three, so the checks below are not vacuous", () => {
    expect(isEmitted.size).toBeGreaterThan(5);
    expect(isDeclared.size).toBeGreaterThan(5);
    expect(isPromised.size).toBeGreaterThan(2);
  });

  it.each([...isDeclared])("%s is emitted somewhere", (name) => {
    expect(
      isEmitted.has(name),
      `${name} is declared in the otel registry and never emitted, so the dashboard has ` +
        `a panel that will always be empty`,
    ).toBe(true);
  });

  it.each([...isPromised])("%s is emitted, because a runbook sends somebody to it", (name) => {
    expect(
      isEmitted.has(name),
      `a runbook page names ${name}, but nothing emits it — whoever follows that page ` +
        `during an incident will go looking for a graph that does not exist`,
    ).toBe(true);
  });

  it("declares every metric it emits, so the instrument type is never guessed", () => {
    for (const name of isEmitted) {
      expect(isDeclared, `${name} is emitted but not in the registry`).toContain(name);
    }
  });
});
