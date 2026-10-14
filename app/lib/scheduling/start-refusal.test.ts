import { describe, expect, it } from "vitest";

import { AppError } from "../errors/app-error";
import { definitionOf, manualSchedule } from "../campaigns/schedule-blob";
import { refusedForGood, startRefusal, startRefusedEntry, withStartRefused } from "./start-refusal";

const segmentGone = new AppError({
  code: "VALIDATION",
  userMessage:
    "This campaign's segment was deleted, so it has no products to price. Duplicate it and choose a segment for the copy, or archive it.",
});

describe("a scheduled start refused for good (#975)", () => {
  it("is a refusal the campaign itself raised: VALIDATION on purpose, or a blocking guardrail", () => {
    expect(refusedForGood(segmentGone)?.userMessage).toMatch(/segment was deleted/);
    // `planRun` returning blocked throws a plain Error; the classifier knows its words.
    const blocked = refusedForGood(
      new Error("Campaign blocked by a guardrail on gid://shopify/ProductVariant/1: below-floor. No prices were changed."),
    );
    expect(blocked?.code).toBe("GUARDRAIL_BLOCKED");
    // The merchant's sentence, not the gid-laden one for the log.
    expect(blocked?.userMessage).not.toMatch(/gid:\/\//);
    expect(blocked?.userMessage).toMatch(/Lower the floor in Settings/);
  });

  it("is never a blip: throttled, unreachable, a busy database, a lost session, or anything unclassified", () => {
    const transient: unknown[] = [
      new Error("Throttled"),
      new TypeError("fetch failed"),
      Object.assign(new Error("Can't reach database server"), { code: "P1001" }),
      Object.assign(new Error("Timed out fetching a new connection from the connection pool"), { code: "P2024" }),
      new Error("No usable session for shop.myshopify.com"),
      new Error("something nobody classified"),
      new AppError({ code: "SHOPIFY_UNAVAILABLE", userMessage: "Could not reach Shopify." }),
    ];
    for (const error of transient) expect(refusedForGood(error), String(error)).toBeNull();
  });

  it("is not VALIDATION made out of a raw database error, which is ours to fix and not the merchant's", () => {
    expect(refusedForGood(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }))).toBeNull();
  });

  it("honours an AppError marked retryable whatever its code", () => {
    expect(refusedForGood(new AppError({ code: "VALIDATION", userMessage: "Try again.", retryable: true }))).toBeNull();
  });

  it("is not a run that wrote and stopped part-way, which is Partial with a Resume", () => {
    const partWay = new AppError({
      code: "VALIDATION",
      userMessage: "This apply stopped part-way.",
      context: { stoppedPartWay: true },
    });
    expect(refusedForGood(partWay)).toBeNull();
  });
});

describe("the refusal kept beside the start it refused", () => {
  const window = { kind: "window", startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-20T09:00:00.000Z", segmentId: "s1" };

  it("names the reason while the start is the one refused", () => {
    const marked = withStartRefused(window, segmentGone.userMessage, new Date("2026-10-15T09:00:30Z"));
    expect(startRefusal(marked)).toBe(segmentGone.userMessage);
    // The same instant written another way is the same start.
    expect(startRefusal({ ...marked, startAt: "2026-10-15T09:00:00Z" })).toBe(segmentGone.userMessage);
    // Everything else in the blob is kept.
    expect(marked.segmentId).toBe("s1");
    expect(marked.endAt).toBe(window.endAt);
  });

  it("is forgotten when the start moves: new dates are a new start, and the schedule tries it", () => {
    const marked = withStartRefused(window, "No.", new Date());
    expect(startRefusal({ ...marked, startAt: "2026-10-16T09:00:00.000Z" })).toBeNull();
    expect(startRefusal({ ...marked, kind: "manual" })).toBeNull();
  });

  it("goes with the dates: a copy, an unschedule or a reschedule leaves it behind", () => {
    const marked = withStartRefused(window, "No.", new Date());
    expect(startRefusal({ ...definitionOf(marked), ...window })).toBeNull();
    expect(startRefusal(manualSchedule(marked))).toBeNull();
  });

  it("is nothing on a schedule that never had one, or a malformed one", () => {
    expect(startRefusal(window)).toBeNull();
    expect(startRefusal(null)).toBeNull();
    expect(startRefusal({ ...window, startRefused: "yes" })).toBeNull();
  });

  it("reads in the history as the scheduler not trying again, with the merchant's reason", () => {
    expect(startRefusedEntry(segmentGone.userMessage)).toMatch(
      /^couldn't start on schedule, and the schedule won't try this start again: This campaign's segment was deleted/,
    );
  });
});
