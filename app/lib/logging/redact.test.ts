import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { redact, redactText } from "./redact";

describe("redact", () => {
  it("removes anything under a secret-looking key", () => {
    const result = redact({
      shop: "store.myshopify.com",
      accessToken: "shpat_abc123",
      apiKey: "k",
      Authorization: "Bearer x",
      password: "hunter2",
      campaignId: "c1",
    }) as Record<string, unknown>;

    expect(result.accessToken).toBe("[redacted]");
    expect(result.apiKey).toBe("[redacted]");
    expect(result.Authorization).toBe("[redacted]");
    expect(result.password).toBe("[redacted]");
    // Non-secrets must survive, or the log stops being useful.
    expect(result.shop).toBe("store.myshopify.com");
    expect(result.campaignId).toBe("c1");
  });

  it("removes a token pasted into an ordinary string", () => {
    // The dangerous case: a token inside an error message, under a harmless key.
    const result = redact({
      message: "POST failed with token shpat_0123456789abcdef",
    }) as Record<string, string>;

    expect(result.message).not.toContain("shpat_0123456789abcdef");
    expect(result.message).toContain("shpat_[redacted]");
  });

  it("scrubs tokens out of a stack trace", () => {
    const error = new Error("auth failed for shpca_deadbeef");
    const result = redact(error) as { message: string };
    expect(result.message).not.toContain("shpca_deadbeef");
  });

  it("survives a cycle instead of hanging", () => {
    const node: Record<string, unknown> = { name: "a" };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect((redact(node) as Record<string, unknown>).self).toBe("[circular]");
  });

  it("truncates rather than walking forever", () => {
    let deep: Record<string, unknown> = { value: "bottom" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(JSON.stringify(redact(deep))).toContain("[truncated]");
  });

  it("summarises long arrays", () => {
    const result = redact(Array.from({ length: 100 }, (_, i) => i)) as unknown[];
    expect(result.length).toBe(21);
    expect(result[20]).toBe("[+80 more]");
  });

  it("handles bigints, which JSON.stringify refuses to", () => {
    // Prices are bigints throughout this app, so they turn up in error context
    // constantly. An unhandled bigint makes the logger itself throw.
    expect(redact({ price: 1999n })).toEqual({ price: "1999n" });
  });

  it("scrubs a bare string, for the columns that are not structured context", () => {
    // The regression this guards: error_events stores `message` and `stack` as plain
    // columns. They used to bypass redaction entirely, so the log line came out clean
    // while the stored row still held the token -- and the Diagnostics page then
    // displayed it.
    expect(redactText("POST failed: token shpat_LEAKEDVALUE rejected")).toBe(
      "POST failed: token shpat_[redacted] rejected",
    );
    expect(
      redactText("Error: boom\n    at auth (/app/x.ts:1) shpca_INSTALLSECRET"),
    ).not.toContain("INSTALLSECRET");
  });

  it("never throws, whatever it is handed", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        expect(() => redact(value)).not.toThrow();
      }),
    );
  });

  it("leaves no shpat_ token anywhere in the output", () => {
    fc.assert(
      fc.property(
        fc.record({
          note: fc.constant("prefix shpat_SECRETVALUE suffix"),
          nested: fc.record({ deeper: fc.constant("shpat_ANOTHERONE") }),
        }),
        (input) => {
          const serialised = JSON.stringify(redact(input));
          expect(serialised).not.toContain("SECRETVALUE");
          expect(serialised).not.toContain("ANOTHERONE");
        },
      ),
    );
  });
});
