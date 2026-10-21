/**
 * What a copy keeps of its source's schedule blob, and what a real copy leaves behind (#1077).
 *
 * A practice campaign's page told the merchant to create a real campaign with the same scope
 * and rule, and Duplicate -- the only copier -- keeps the practice flag on purpose (#762), so
 * the merchant had to rebuild the campaign by hand. A real copy is the same copy without it.
 */

import { describe, expect, it } from "vitest";

import { QUEUED_REFUSED_KEY } from "./queued-refusal";
import { copiedSchedule } from "./schedule-blob";
import { START_CONFIRMED_KEY } from "./start-confirmation";

/** A practice campaign's blob, with everything a copy has to tell apart. */
const PRACTICE = {
  kind: "manual",
  ast: { groups: [{ conditions: [{ field: "tag", value: "alpine" }] }] },
  segmentId: "seg-1",
  rounding: { default: "charm-99", byCurrency: {} },
  productStatuses: ["ACTIVE"],
  practice: true,
  [START_CONFIRMED_KEY]: { by: "staff:1", at: "2026-10-01T09:00:00Z" },
  [QUEUED_REFUSED_KEY]: { verb: "apply", reason: "x", at: "2026-10-01T09:00:00Z" },
};

/** What decides a price: the same in either copy. */
const DEFINITION = {
  kind: "manual",
  ast: PRACTICE.ast,
  segmentId: "seg-1",
  rounding: PRACTICE.rounding,
  productStatuses: ["ACTIVE"],
};

describe("a copy's schedule", () => {
  it("keeps a practice campaign's copy practice (#762)", () => {
    expect(copiedSchedule(PRACTICE)).toEqual({ ...DEFINITION, practice: true });
  });

  it("is real when asked for, and otherwise the same copy (#1077)", () => {
    expect(copiedSchedule(PRACTICE, { real: true })).toEqual(DEFINITION);
  });

  it("leaves the source's own record behind either way", () => {
    for (const copy of [copiedSchedule(PRACTICE), copiedSchedule(PRACTICE, { real: true })]) {
      expect(copy).not.toHaveProperty(START_CONFIRMED_KEY);
      expect(copy).not.toHaveProperty(QUEUED_REFUSED_KEY);
    }
  });

  it("does not touch the source's blob", () => {
    const source = structuredClone(PRACTICE);
    copiedSchedule(source, { real: true });
    expect(source).toEqual(PRACTICE);
  });
});
