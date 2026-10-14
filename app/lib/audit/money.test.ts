/**
 * The two halves of a price in an audit entry (#757).
 *
 * `auditMoney` is what a writer stores and `asAuditMoney` is how the Activity log finds it
 * again. Nothing but this file checks that they agree: a writer whose shape the reader
 * stops recognising would put "70100" back on the page with no error anywhere, which is
 * the bug this pair exists to end.
 */

import { describe, expect, it } from "vitest";

import { asAuditMoney, auditMoney, describeAuditMoney } from "./money";

/** What Postgres hands back: JSON, so no bigint and no prototype. */
const stored = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("a price as an audit entry stores it", () => {
  it.each([
    [70100n, "USD", "$701.00"],
    [701n, "JPY", "¥701"],
    [70100n, "JPY", "¥70,100"],
    [1500n, "KWD", "KWD\u00a01.500"],
    [0n, "USD", "$0.00"],
    [-450n, "USD", "-$4.50"],
  ])("%s %s is read back, after the database, as %s", (minor, currency, shown) => {
    const read = asAuditMoney(stored(auditMoney(minor, currency)));
    expect(read, "the reader no longer recognises what the writer stores").not.toBeNull();
    expect(describeAuditMoney(read!)).toBe(shown);
  });

  it("keeps the exact minor units, as a string, since JSON has no bigint", () => {
    expect(stored(auditMoney(70100n, "USD"))).toEqual({ minor: "70100", currency: "USD" });
  });

  it("normalises the currency code, so the reader's strict check still matches", () => {
    expect(asAuditMoney(stored(auditMoney(701, " jpy ")))).toEqual({ minor: "701", currency: "JPY" });
  });

  it("stores no price as null, not as the string \"null\"", () => {
    // `String(null)` is what the old writer would have stored for an event with no price.
    expect(auditMoney(null, "USD")).toBeNull();
    expect(auditMoney(undefined, "USD")).toBeNull();
  });

  it("refuses a fractional amount rather than rounding it into the record", () => {
    expect(() => auditMoney(701.5, "USD")).toThrow(/whole minor units/);
  });
});

describe("what is not a price", () => {
  it.each([
    ["a bare number", 70100],
    ["a bare string", "70100"],
    ["an amount that is not whole", { minor: "701.00", currency: "USD" }],
    ["a lowercase code", { minor: "701", currency: "usd" }],
    ["a missing currency", { minor: "701" }],
    ["an object that also has other fields", { minor: "701", currency: "USD", name: "EU" }],
    ["a market snapshot", { currency: "EUR", name: "EU", adjustmentBps: 0 }],
    ["an array", ["701", "USD"]],
    ["null", null],
  ])("%s", (_label, value) => {
    expect(asAuditMoney(value)).toBeNull();
  });
});
