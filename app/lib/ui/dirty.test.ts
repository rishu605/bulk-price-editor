/**
 * Whether a form still holds what somebody typed.
 *
 * The answer decides whether they are warned before losing it, so the case that matters
 * is the one that is wrong in the dangerous direction: a form that has changed, reported
 * clean, lets the work go silently.
 */

import { describe, expect, it } from "vitest";

import { hasChanged } from "./dirty";

describe("comparing a form to how it started", () => {
  it("is clean when the fields still say what they said", () => {
    expect(hasChanged("name=&pct=", "name=&pct=")).toBe(false);
  });

  it("is dirty the moment one field differs", () => {
    expect(hasChanged("name=Summer+sale&pct=", "name=&pct=")).toBe(true);
  });

  it("notices a field being emptied, not only filled", () => {
    // Clearing a name is still work: it was typed, and it is gone if nobody warns.
    expect(hasChanged("name=&pct=-20", "name=Summer+sale&pct=-20")).toBe(true);
  });

  it("says there is nothing to lose when no snapshot was ever taken", () => {
    // Blocking every navigation off a page that never rendered a field is its own trap.
    expect(hasChanged(null, null)).toBe(false);
    expect(hasChanged("name=Summer", null)).toBe(false);
    expect(hasChanged(null, "name=Summer")).toBe(false);
  });
});
