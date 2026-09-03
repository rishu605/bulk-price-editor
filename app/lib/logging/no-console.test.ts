/**
 * Nothing in `app/` writes to the console except the logger's own sink.
 *
 * `logger.emit` is the enforcement point for two rules that the codebase deliberately
 * moved off call sites: prices are stripped by `telemetry/redact`, secrets by
 * `logging/redact`, and since #535 the shop, run and job ids are attached from the
 * ambient context. A direct `console.log` gets none of the three, and stdout in the
 * deployed web process ships to the aggregator — the destination `telemetry/redact.ts`
 * names in its own header.
 *
 * Ten call sites had drifted past it, and the two that mattered were both in
 * price-adjacent paths: the render `onError` handing a whole Error to `console.error`,
 * and the products webhook logging a failure out of `enrollNewVariants`, which is the
 * path that captures baselines. This is the guard that stops the eleventh.
 *
 * **`scripts/` is exempt on purpose.** Those are operator tools a human runs at a
 * terminal, and several print live prices because reading the price *is* the check —
 * `test-pricing-rules.ts` exists to do exactly that. The telemetry rule is about
 * third-party pipelines with their own retention and access lists, not about a
 * developer's own screen, and enforcing it there would break the live-script half of
 * this repo's testing convention.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";

/**
 * The one file allowed to call it: the logger writes the line somewhere in the end, and
 * `console` is that somewhere.
 */
const SINK = "app/lib/logging/logger.ts";

/**
 * Any reference to a console method, not only a call of one.
 *
 * Requiring a trailing `(` was the first version and it was wrong in both directions.
 * It missed the sink — `logger.ts` picks its output with
 * `const sink = level === "error" ? console.error : …` and never writes `console.error(`
 * at all — and by the same token it would have missed anyone else taking the method as a
 * value and calling it a line later.
 */
const CONSOLE_USE = /\bconsole\s*\.\s*(log|info|warn|error|debug|trace|dir|table)\b/g;

describe("the console is the logger's, not everyone's", () => {
  // `sourceFiles` leaves out test files, which assert *about* these strings and are the
  // other half of the trap the comment stripping exists for.
  const files = sourceFiles("app").filter((file) => file !== SINK);

  it("found the tree, so this is not passing over an empty list", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain("app/entry.server.tsx");
    expect(files).toContain("app/routes/webhooks.products.tsx");
  });

  it.each(files)("%s goes through the logger", (file) => {
    // Comments stripped, so the note beside a converted call site — which necessarily
    // says the words `console.error` to explain what it replaced — cannot trip this.
    // That trap has caught this repo seven times.
    const offenders = [...sourceOf(file).matchAll(CONSOLE_USE)].map(([, method]) => method);

    expect(
      offenders,
      `${file} reaches console.${offenders[0]} directly, so that line reaches the ` +
        `aggregator without the price and secret passes and without the shop or run id`,
    ).toEqual([]);
  });

  it("still lets the logger write the line", () => {
    // The rule is "one sink", not "no output". A guard that also forbade the sink would
    // be satisfied by an app that logs nothing at all.
    expect(sourceOf(SINK)).toMatch(/console\s*\.\s*(log|warn|error)/);
  });
});
