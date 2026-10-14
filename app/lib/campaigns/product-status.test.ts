/**
 * Which products a campaign covers by status, read from the record and from the form
 * (#751).
 *
 * The record half is the one that can quietly widen a sale: everything stored before #751
 * has no statuses at all, and the blob is JSON, so a value from a rolled-back release or a
 * hand edit could be anything. Each of those has to come out as a list the query can use
 * and never as "every status" by accident or "no status" by omission.
 */

import { describe, expect, it } from "vitest";

import { productStatusesFrom, readerFor } from "./draft-form";
import { ACTIVE_ONLY, describeProductStatuses, EVERY_STATUS, productStatusesOf } from "./product-status";

describe("a stored list of statuses", () => {
  it("is active products only when nothing was recorded -- every campaign made before #751", () => {
    expect(productStatusesOf(undefined)).toEqual(["ACTIVE"]);
    expect(productStatusesOf(null)).toEqual(["ACTIVE"]);
  });

  it("is active products only rather than nothing when the list is empty", () => {
    // An empty IN () prices nothing, which is a sale the merchant pressed Apply on doing
    // nothing and saying so nowhere.
    expect(productStatusesOf([])).toEqual(["ACTIVE"]);
  });

  it("drops values it does not know, and falls back when none are left", () => {
    expect(productStatusesOf(["ACTIVE", "UNLISTED", 7])).toEqual(["ACTIVE"]);
    expect(productStatusesOf(["active"])).toEqual(["ACTIVE"]);
    expect(productStatusesOf("DRAFT")).toEqual(["ACTIVE"]);
  });

  it("keeps a recorded opt-in, in one order whatever order it was written in", () => {
    expect(productStatusesOf(["ARCHIVED", "ACTIVE", "DRAFT"])).toEqual(["ACTIVE", "DRAFT", "ARCHIVED"]);
    expect(productStatusesOf(["DRAFT", "ACTIVE", "DRAFT"])).toEqual(["ACTIVE", "DRAFT"]);
  });

  it("hands out copies, so nobody can widen the default by pushing onto it", () => {
    const first = productStatusesOf(undefined);
    first.push("DRAFT");
    expect(productStatusesOf(undefined)).toEqual(["ACTIVE"]);
    expect(ACTIVE_ONLY).toEqual(["ACTIVE"]);
  });
});

describe("the editor's two boxes", () => {
  const statuses = (fields: Record<string, string>) => productStatusesFrom(readerFor(new URLSearchParams(fields)));

  it("covers active products when neither is ticked", () => {
    expect(statuses({})).toEqual(["ACTIVE"]);
  });

  it("adds each status whose box is ticked, however the box posts", () => {
    expect(statuses({ includeDraft: "on" })).toEqual(["ACTIVE", "DRAFT"]);
    expect(statuses({ includeArchived: "1" })).toEqual(["ACTIVE", "ARCHIVED"]);
    expect(statuses({ includeDraft: "1", includeArchived: "1" })).toEqual([...EVERY_STATUS]);
  });

  it("does not read an empty value as ticked", () => {
    // How a link that carried the field with no value would arrive.
    expect(statuses({ includeDraft: "", includeArchived: "  " })).toEqual(["ACTIVE"]);
  });
});

describe("the statuses in words", () => {
  it("says nothing for the default", () => {
    expect(describeProductStatuses(undefined)).toBeNull();
    expect(describeProductStatuses(["ACTIVE"])).toBeNull();
  });

  it("names what was opted into", () => {
    expect(describeProductStatuses(["ACTIVE", "DRAFT"])).toBe("including draft products");
    expect(describeProductStatuses(["ACTIVE", "ARCHIVED"])).toBe("including archived products");
    expect(describeProductStatuses(EVERY_STATUS)).toBe("including draft and archived products");
  });

  it("does not claim active products are covered when they are not", () => {
    expect(describeProductStatuses(["DRAFT"])).toBe("draft products only");
  });
});
