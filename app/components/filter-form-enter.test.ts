/**
 * Enter in a filter form's field searches, as it does in any form (#823).
 *
 * The fields are Polaris custom elements with their input in a shadow root, so the
 * browser's implicit submission never reached the form. Stand-in events, since the suite
 * has no DOM: the path's first entry is what a real keydown from inside the field carries.
 */

import { describe, expect, it, vi } from "vitest";

import { sourceOf } from "../lib/testing/source";

import { enterSubmits } from "./FilterForm";

const keydown = (key: string, origin: { tagName: string; type?: string }, extra: Partial<KeyboardEvent> = {}) => ({
  key,
  isComposing: false,
  defaultPrevented: false,
  composedPath: () => [origin] as unknown as EventTarget[],
  preventDefault: vi.fn(),
  ...extra,
});

describe("Enter in a filter form", () => {
  it("submits from the search field's own input", () => {
    const form = { requestSubmit: vi.fn() };
    const event = keydown("Enter", { tagName: "INPUT", type: "search" });
    expect(enterSubmits(event, form)).toBe(true);
    expect(form.requestSubmit).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("submits from a text field too, as on Baselines and What's live", () => {
    const form = { requestSubmit: vi.fn() };
    expect(enterSubmits(keydown("Enter", { tagName: "INPUT", type: "text" }), form)).toBe(true);
  });

  it("leaves other keys, a textarea, a checkbox and an input method's Enter alone", () => {
    const form = { requestSubmit: vi.fn() };
    expect(enterSubmits(keydown("a", { tagName: "INPUT", type: "search" }), form)).toBe(false);
    expect(enterSubmits(keydown("Enter", { tagName: "TEXTAREA" }), form)).toBe(false);
    expect(enterSubmits(keydown("Enter", { tagName: "INPUT", type: "checkbox" }), form)).toBe(false);
    expect(enterSubmits(keydown("Enter", { tagName: "INPUT", type: "search" }, { isComposing: true }), form)).toBe(false);
    expect(form.requestSubmit).not.toHaveBeenCalled();
  });

  it("is wired on the form every list page's filters use", () => {
    const source = sourceOf("app/components/FilterForm.tsx");
    expect(source).toContain('element.addEventListener("keydown", onKeyDown)');
    expect(source).toContain("ref={form}");
  });
});
