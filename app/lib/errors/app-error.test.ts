import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { AppError, toAppError, type ErrorCode } from "./app-error";
import { isErrorId, newErrorId } from "./error-id";

describe("toAppError", () => {
  it("passes an AppError through untouched", () => {
    const original = new AppError({ code: "VALIDATION", userMessage: "Fix the form." });
    expect(toAppError(original)).toBe(original);
  });

  it("recognises a Shopify throttle as retryable", () => {
    const result = toAppError(new Error("Throttled: too many requests"));
    expect(result.code).toBe("SHOPIFY_THROTTLED");
    expect(result.retryable).toBe(true);
  });

  it("recognises the network failures that actually happen", () => {
    // `fetch failed` is what Node throws when the connection drops mid-request, and
    // it is the single most common transient failure in this app.
    for (const message of [
      "fetch failed",
      "connect ECONNREFUSED 127.0.0.1:443",
      "getaddrinfo ENOTFOUND admin.shopify.com",
      "socket hang up",
    ]) {
      const result = toAppError(new Error(message));
      expect(result.code, message).toBe("SHOPIFY_UNAVAILABLE");
      expect(result.retryable, message).toBe(true);
    }
  });

  it("never marks a guardrail block retryable", () => {
    // Retrying a blocked run just blocks again. Getting this wrong would make the
    // worker spin on a campaign that can never succeed.
    const result = toAppError(
      new Error("Campaign blocked by a guardrail on gid://x: below cost"),
    );
    expect(result.code).toBe("GUARDRAIL_BLOCKED");
    expect(result.retryable).toBe(false);
  });

  it("trusts Prisma's codes over its prose", () => {
    const notFound = Object.assign(new Error("No Campaign found"), { code: "P2025" });
    expect(toAppError(notFound).code).toBe("NOT_FOUND");

    const down = Object.assign(new Error("Can't reach database server"), { code: "P1001" });
    expect(toAppError(down).code).toBe("DB_UNAVAILABLE");
    expect(toAppError(down).retryable).toBe(true);
  });

  it("treats a lost session as needing reinstall, not retry", () => {
    const result = toAppError(new Error("No usable session for shop.myshopify.com"));
    expect(result.code).toBe("NO_SESSION");
    expect(result.retryable).toBe(false);
  });

  it("falls back to UNKNOWN rather than guessing", () => {
    const result = toAppError(new Error("something entirely novel"));
    expect(result.code).toBe("UNKNOWN");
    expect(result.status).toBe(500);
  });

  it("survives anything thrown, not just Errors", () => {
    // People throw strings, objects and undefined. The error handler is the last
    // place that should itself crash.
    fc.assert(
      fc.property(fc.anything(), (thrown) => {
        const result = toAppError(thrown);
        expect(result).toBeInstanceOf(AppError);
        expect(typeof result.userMessage).toBe("string");
        expect(result.userMessage.length).toBeGreaterThan(0);
      }),
    );
  });

  it("always produces a user message free of stack traces", () => {
    const withStack = new Error("boom");
    withStack.stack = "Error: boom\n    at /app/lib/secret-path.ts:42";
    const result = toAppError(withStack);
    expect(result.userMessage).not.toContain("at /app");
    expect(result.userMessage).not.toContain("boom");
  });

  it("gives every code a status and a message", () => {
    const codes: ErrorCode[] = [
      "UNAUTHENTICATED",
      "NO_SESSION",
      "SHOPIFY_THROTTLED",
      "SHOPIFY_UNAVAILABLE",
      "SHOPIFY_REJECTED",
      "GUARDRAIL_BLOCKED",
      "NOT_FOUND",
      "VALIDATION",
      "DB_UNAVAILABLE",
      "UNKNOWN",
    ];
    for (const code of codes) {
      const error = new AppError({ code, userMessage: "x" });
      expect(error.status, code).toBeGreaterThanOrEqual(400);
    }
  });
});

describe("error ids", () => {
  it("produces ids that survive being read aloud", () => {
    // No O/0, I/1/L or U: the whole point is a person transcribing it correctly.
    for (let i = 0; i < 200; i++) {
      const id = newErrorId();
      expect(id).toMatch(/^ANC-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/);
      expect(id).not.toMatch(/[OIL01U]/);
    }
  });

  it("round-trips through the validator, case-insensitively", () => {
    const id = newErrorId();
    expect(isErrorId(id)).toBe(true);
    expect(isErrorId(id.toLowerCase())).toBe(true);
    expect(isErrorId(`  ${id}  `)).toBe(true);
  });

  it("rejects things that are not ids", () => {
    for (const value of ["", "ANC-", "hello", "ANC-OOOO-1111", "12345678"]) {
      expect(isErrorId(value), value).toBe(false);
    }
  });

  it("does not collide in practice", () => {
    const ids = new Set(Array.from({ length: 5_000 }, newErrorId));
    expect(ids.size).toBeGreaterThan(4_990);
  });
});
