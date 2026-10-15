/**
 * Leaving an untouched form discards nothing, however late its fields register (#761).
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { LeaveGuard } from "./leave-guard";

// What `new FormData(form)` reads from the editor: at mount, before the Polaris fields have
// registered; and a moment later, with their loader values in place.
const AT_MOUNT = "practice=";
const RENDERED = "practice=&name=Sale+%C2%B7+15+Oct+2026&ruleKind=percent-change&ruleValue=20";

describe("the leave guard", () => {
  it("lets an untouched editor go, though its fields registered after mount", () => {
    const guard = new LeaveGuard();
    expect(guard.wouldDiscard(RENDERED), "an untouched New campaign asked to discard").toBe(false);
  });

  it("asks once the merchant changed something", () => {
    const guard = new LeaveGuard();
    guard.touch(RENDERED);
    expect(guard.wouldDiscard(RENDERED.replace("ruleValue=20", "ruleValue=25"))).toBe(true);
  });

  it("does not ask when a touch changed nothing, such as Tab or See all rows", () => {
    const guard = new LeaveGuard();
    guard.touch(RENDERED);
    expect(guard.wouldDiscard(RENDERED)).toBe(false);
  });

  it("keeps the first touch's state, and takes what was accepted as the new one", () => {
    const guard = new LeaveGuard();
    guard.touch(RENDERED);
    guard.touch(RENDERED.replace("ruleValue=20", "ruleValue=25"));
    expect(guard.wouldDiscard(RENDERED.replace("ruleValue=20", "ruleValue=25"))).toBe(true);
    guard.accept(RENDERED.replace("ruleValue=20", "ruleValue=25"));
    expect(guard.wouldDiscard(RENDERED.replace("ruleValue=20", "ruleValue=25"))).toBe(false);
  });

  it("would have asked under the old rule, which read the clean state at mount", () => {
    // The bug, pinned: a clean state read before the fields registered differs from the form.
    const old = new LeaveGuard();
    old.accept(AT_MOUNT);
    expect(old.wouldDiscard(RENDERED)).toBe(true);
  });
});

describe("the editor's leave guard component (#761)", () => {
  const source = sourceOf("app/components/UnsavedChanges.tsx");

  it("reads the clean state at the first touch, never at mount", () => {
    expect(source).toContain("guard.current.touch(snapshotOf(element))");
    expect(source).toMatch(/for \(const type of TOUCH_EVENTS\) element\.addEventListener\(type, touched, true\)/);
    expect(source, "a clean state read at mount is back").not.toMatch(/if \(form\.current\) [a-z.]+ = snapshotOf\(form\.current\);\s*\}, \[form\]\)/);
  });

  it("warns in a dialog shown in view, not a banner scrolled inside the iframe", () => {
    expect(source).toContain("modal.current?.showOverlay?.()");
    expect(source).not.toContain("scrollIntoView");
  });
});
