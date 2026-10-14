/**
 * A segment can be deleted once nothing pricing with it needs it (#776).
 */

import { describe, expect, it } from "vitest";

import { campaignsBlockingDelete, deleteBlockedReason, stepBeforeDeleting } from "./delete-rule";

const user = (name: string, status: string) => ({ id: `id-${name}`, name, status });

describe("deleting a segment campaigns have used", () => {
  it("is not blocked by drafts, finished or cancelled campaigns", () => {
    for (const status of ["DRAFT", "COMPLETED", "CANCELLED"]) {
      expect(stepBeforeDeleting(status), status).toBeNull();
    }
    expect(deleteBlockedReason([user("Sale · 25 Sep 2026", "DRAFT"), user("Summer", "COMPLETED")])).toBeNull();
  });

  it("is blocked by a campaign pricing with it, or about to, with a step that exists", () => {
    expect(stepBeforeDeleting("SCHEDULED")).toBe("unschedule it");
    for (const status of ["ACTIVE", "HELD", "PARTIAL"]) expect(stepBeforeDeleting(status), status).toBe("revert it");
    for (const status of ["APPLYING", "REVERTING"]) expect(stepBeforeDeleting(status), status).toBe("wait for its run to finish");
  });

  it("names the campaign and what to do to it, never 'remove from campaigns'", () => {
    const reason = deleteBlockedReason([user("Black Friday", "SCHEDULED"), user("Old sale", "COMPLETED")]);
    expect(reason).toBe('In use by "Black Friday": unschedule it first, from its page, then delete.');
    expect(reason).not.toMatch(/remove from/i);
  });

  it("names every live campaign when there are several, and only those", () => {
    const users = [user("A", "ACTIVE"), user("B", "SCHEDULED"), user("C", "DRAFT")];
    expect(campaignsBlockingDelete(users).map((u) => u.name)).toEqual(["A", "B"]);
    expect(deleteBlockedReason(users)).toBe(
      'In use by live campaigns: "A" (revert it), "B" (unschedule it). Do that from each campaign\'s page, then delete.',
    );
  });
});
