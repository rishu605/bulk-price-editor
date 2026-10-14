/**
 * Every table the alerts read is one the app writes (#712).
 *
 * Three paging alerts divided by `webhook_events`, which nothing in the app wrote -- only the
 * chaos scenario that tests them, by hand -- so in production they could never fire. The
 * reader and the writer of a table meet only at runtime, and a test that supplies the writer
 * itself cannot notice one is missing.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../lib/testing/source";

describe("the tables the alerts read", () => {
  it("are each written somewhere in the app's own code", () => {
    const alerting = sourceOf("app/services/alerting.server.ts");
    const read = [...new Set([...alerting.matchAll(/prisma\.(\w+)\.(?:findMany|findFirst|findUnique|count|groupBy|aggregate)\(/g)].map((m) => m[1]))];
    expect(read.length, "the guard found no reads to check").toBeGreaterThan(0);

    const code = sourceFiles("app")
      .filter((file) => file !== "app/services/alerting.server.ts")
      .map((file) => sourceOf(file))
      .join("\n");
    const unwritten = read.filter((model) => !new RegExp(`\\.${model}\\.(?:create|createMany|upsert)\\(`).test(code));

    expect(unwritten, "read by an alert and written nowhere in app/").toEqual([]);
  });
});
