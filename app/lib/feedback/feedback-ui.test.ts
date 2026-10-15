/**
 * The feedback form's words and the screen it reports (#743).
 */

import { describe, expect, it } from "vitest";

import { sourceOf } from "../testing/source";

import { kindLabel, lastScreen, rememberScreen } from "./feedback-ui";

const memory = () => {
  const store = new Map<string, string>();
  return { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null };
};

describe("the screen a report came from", () => {
  it("is the last screen before Feedback, not Feedback itself", () => {
    const storage = memory();
    rememberScreen("/app/campaigns/abc", storage);
    rememberScreen("/app/settings/feedback", storage);
    expect(lastScreen(storage)).toBe("/app/campaigns/abc");
  });

  it("is nothing when storage is unavailable, rather than a guess", () => {
    expect(lastScreen(null)).toBeNull();
  });

  it("is sent by the form, which the layout feeds on every navigation", () => {
    expect(sourceOf("app/components/FeedbackForm.tsx")).toContain('<input type="hidden" name="route" value={route ?? ""} />');
    expect(sourceOf("app/routes/app.tsx")).toContain("<ScreenMemory />");
    expect(sourceOf("app/routes/app.settings.feedback.tsx")).not.toContain('route="/app/settings/feedback"');
  });
});

describe("the feedback form's words", () => {
  it("reads a kind back in the select's own words", () => {
    expect(kindLabel("problem")).toBe("Something is wrong");
    expect(kindLabel("idea")).toBe("An idea");
    expect(kindLabel("praise")).toBe("Something worked well");
  });

  it("clears after a message is sent", () => {
    const form = sourceOf("app/components/FeedbackForm.tsx");
    expect(form).toContain("form.current.reset();");
    expect(form).toContain('if (area) area.value = "";');
  });
});
