/**
 * The rule that telemetry never carries a price.
 *
 * It is in CLAUDE.md and it is absolute: shop id, plan, counts, durations, statuses.
 * A merchant's pricing is commercially sensitive and a third-party error tracker is
 * somewhere they never agreed to put it — with its own retention and its own access
 * list.
 *
 * Enforced here rather than by everyone remembering, because a rule kept by memory lasts
 * until somebody adds a field in a hurry. Which is exactly the case these tests are
 * built around.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { redactPrices, REDACTED } from "./redact";

describe("redactPrices", () => {
  it("redacts a field because of its name", () => {
    expect(redactPrices({ price: 1999, shopId: "s1" })).toEqual({
      price: REDACTED,
      shopId: "s1",
    });
  });

  it("catches the aliases prices actually travel under here", () => {
    const out = redactPrices({
      basePrice: 1n,
      intendedPrice: 2n,
      liveCompareAt: 3n,
      observedPrice: 4n,
    }) as Record<string, unknown>;
    for (const value of Object.values(out)) expect(value).toBe(REDACTED);
  });

  it("redacts a money-shaped value whatever the field is called", () => {
    // The failure mode that matters. A field named `price` is caught by name; a field
    // named `value` holding "19.99" is the one somebody adds in a hurry.
    expect(redactPrices({ value: "19.99" })).toEqual({ value: REDACTED });
    expect(redactPrices({ note: "reverted to $42.00" })).toEqual({ note: REDACTED });
    expect(redactPrices({ currency: "1200 JPY" })).toEqual({ currency: REDACTED });
  });

  it("redacts every bigint on sight", () => {
    // BigInt is how every price in this codebase is stored, and nothing else uses it.
    expect(redactPrices({ anything: 8_000n })).toEqual({ anything: REDACTED });
  });

  it("leaves the things telemetry is actually for", () => {
    const context = {
      shopId: "cmsw41td7",
      runId: "cmt8u36qw",
      verified: 1_615,
      failed: 0,
      durationMs: 8_042,
      status: "COMPLETED",
      plan: "advanced",
    };
    expect(redactPrices(context)).toEqual(context);
  });

  it("does not mistake an id or a count for money", () => {
    // Over-redacting costs a count now and then, but redacting a run id would make the
    // telemetry useless for the thing it exists to do.
    expect(redactPrices({ runId: "cmt8u36qw000px9ii" })).toEqual({ runId: "cmt8u36qw000px9ii" });
    expect(redactPrices({ variants: 1616, ms: 509 })).toEqual({ variants: 1616, ms: 509 });
  });

  it("reaches into nested objects and arrays", () => {
    expect(
      redactPrices({ rows: [{ sku: "A", price: 1n }, { sku: "B", note: "was £5.00" }] }),
    ).toEqual({ rows: [{ sku: "A", price: REDACTED }, { sku: "B", note: REDACTED }] });
  });

  it("gives up rather than recursing forever", () => {
    // Telemetry context is occasionally handed something with a cycle or a Prisma model
    // hanging off it. A reporter that stack-overflows while reporting an error is worse
    // than no reporter.
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 30; i++) node = node.next = {} as Record<string, unknown>;
    expect(() => redactPrices(deep)).not.toThrow();
    expect(JSON.stringify(redactPrices(deep))).toContain("[truncated]");
  });

  it("lets no money-shaped value through, whatever the payload", () => {
    const MONEY = /[$£€¥]\s?\d|(?:^|\s)\d+\.\d{2}(?:\s|$)|\b(USD|EUR|GBP|JPY)\b/;

    /** Every leaf value, ignoring keys — the rule is about values, not field names. */
    const values = (node: unknown): unknown[] =>
      node && typeof node === "object"
        ? Object.values(node as Record<string, unknown>).flatMap(values)
        : [node];

    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.oneof(
            fc.string({ maxLength: 40 }),
            fc.integer(),
            fc.bigInt({ min: 0n, max: 10_000_000n }),
            fc.constantFrom("19.99", "$5", "1200 JPY", "£1.00"),
          ),
          { maxKeys: 8 },
        ),
        (payload) => {
          for (const leaf of values(redactPrices(payload))) {
            if (typeof leaf !== "string" || leaf === REDACTED) continue;
            expect(leaf).not.toMatch(MONEY);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
