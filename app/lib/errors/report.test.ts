/**
 * The reference a merchant reads out to support.
 *
 * `error-id.ts` goes to real trouble over the id — an alphabet with no `O`/`0`, no
 * `I`/`1`/`L`, no `U` — because a person transcribes it by hand. It has its own test. The
 * call site that gives each error a *distinct* one did not, and making `reportErrorSync`
 * return a constant passed all 2,991 tests.
 *
 * That failure is quiet and complete: every merchant quotes the same reference, and the
 * diagnostics page's lookup returns the wrong incident or all of them. Nothing about the
 * error screen would look different.
 */

import { describe, expect, it } from "vitest";

import { AppError } from "./app-error";
import { isErrorId } from "./error-id";
import { reportErrorSync } from "./report";

describe("the reference on the error screen", () => {
  it("is a well-formed error id", () => {
    expect(isErrorId(reportErrorSync(new Error("boom")).errorId)).toBe(true);
  });

  it("is different for every error", () => {
    // The whole point. One id shared by every incident makes the diagnostics lookup
    // answer with somebody else's error, which is worse than answering with none.
    const ids = new Set(
      Array.from({ length: 50 }, () => reportErrorSync(new Error("boom")).errorId),
    );

    expect(ids.size).toBe(50);
  });

  it("is different even for two throws of the same error object", () => {
    const error = new Error("the same object twice");

    expect(reportErrorSync(error).errorId).not.toBe(reportErrorSync(error).errorId);
  });
});

describe("what the boundary is given to render", () => {
  it("carries an AppError's own merchant-facing message", () => {
    const reported = reportErrorSync(
      new AppError({
        code: "GUARDRAIL_BLOCKED",
        userMessage: "A guardrail stopped this run before anything was written.",
      }),
    );

    expect(reported.userMessage).toBe(
      "A guardrail stopped this run before anything was written.",
    );
    expect(reported.code).toBe("GUARDRAIL_BLOCKED");
  });

  it("never puts a raw thrown message in front of the merchant", () => {
    // The assertion that actually distinguishes something. `AppError` sets `message`
    // *from* `userMessage`, so for an AppError the two can never differ and a test using
    // one proves nothing — a mutation swapping the fields survived until this case
    // existed. What can differ is a raw error from Prisma or `fetch`, whose message is
    // the thing that must not reach a screen.
    const raw = "PrismaClientKnownRequestError: P2025 An operation failed because it " +
      "depends on one or more records that were required but not found";
    const reported = reportErrorSync(Object.assign(new Error(raw), { code: "P2025" }));

    expect(reported.code).toBe("NOT_FOUND");
    expect(reported.userMessage).not.toContain("Prisma");
    expect(reported.userMessage).not.toBe(raw);
    expect(reported.userMessage).toContain("no longer exists");
  });

  it("carries retryable and status from the classification", () => {
    // The worker reads `retryable` to decide whether to try again, so dropping it here
    // turns a transient failure into a permanent one.
    const reported = reportErrorSync(
      Object.assign(new Error("pool timeout"), { code: "P2024" }),
    );

    expect(reported.code).toBe("DB_UNAVAILABLE");
    expect(reported.retryable).toBe(true);
    expect(reported.status).toBe(503);
  });

  it("normalises something that is not an Error at all", () => {
    // Anything can be thrown. A report that crashed on a thrown string would replace a
    // handled error with an unhandled one, at the moment the app is already failing.
    const reported = reportErrorSync("just a string");

    expect(reported.code).toBe("UNKNOWN");
    expect(reported.userMessage.length).toBeGreaterThan(0);
    expect(isErrorId(reported.errorId)).toBe(true);
  });

  it("keeps an AppError's own code rather than reclassifying it", () => {
    const reported = reportErrorSync(
      new AppError({ code: "NOT_FOUND", userMessage: "That campaign no longer exists." }),
    );

    expect(reported.code).toBe("NOT_FOUND");
    expect(reported.status).toBe(404);
  });
});
