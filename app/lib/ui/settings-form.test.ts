/**
 * Settings is one form, and saving one section cannot switch off another.
 *
 * It was three forms with three intents, each writing `{ ...existing, its own fields }`
 * so the other two survived. That worked, and it is also how a bug once switched
 * notification preferences off while saving a guardrail: every write had to remember
 * what it was not touching, and one of them forgot.
 *
 * With one form every field is present on every save, so nothing depends on being
 * remembered. The failure this guards is the regression back to per-section intents,
 * which would look tidy and reintroduce the same class of bug.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const route = readFileSync(
  join(process.cwd(), "app", "routes", "app.settings._index.tsx"),
  "utf8",
);
const saveBar = readFileSync(
  join(process.cwd(), "app", "components", "SettingsSaveBar.tsx"),
  "utf8",
);

describe("one form", () => {
  it("has exactly one form element, opened and closed", () => {
    expect(route.match(/<fetcher\.Form/g) ?? []).toHaveLength(1);
    expect(route.match(/<\/fetcher\.Form>/g) ?? []).toHaveLength(1);
  });

  it("has no per-section intents left to branch on", () => {
    expect(route).not.toContain('name="intent"');
    expect(route).not.toContain('=== "rounding"');
    expect(route).not.toContain('=== "notifications"');
  });

  it("writes guardrails, rounding and preferences on the same submit", () => {
    // Scoped to the action body. Slicing to the end of the file also swept in the form
    // fields, so deleting the whole `writePreferences` call still passed — the field
    // names were matching the inputs that render them.
    const start = route.indexOf("export const action");
    const action = route.slice(start, route.indexOf("\n});", start));

    for (const field of ["minPrice", "violationPolicy", "rounding:", "writePreferences"]) {
      expect(action, `${field} is not written by the single save`).toContain(field);
    }
  });

  it("still reads existing settings, for fields no control here owns", () => {
    expect(route).toContain("...existing");
  });
});

describe("the save bar", () => {
  it("re-reads the form after a save, so it does not linger", () => {
    // A bar left showing over a form that already matches what is stored trains people
    // to ignore it.
    expect(saveBar).toContain("[saving, form, id]");
  });

  it("discards by resetting the whole form, not one section", () => {
    expect(saveBar).toContain("form.current?.reset()");
  });

  it("does nothing outside the admin frame rather than throwing", () => {
    // `shopify` is App Bridge's global. A direct page load or a test has no admin.
    expect(saveBar).toContain("if (!control) return");
  });
});

describe("a save that registers (#1119, #1120)", () => {
  const start = route.indexOf("export const action");
  const action = route.slice(start, route.indexOf("\n});", start));

  it("refuses a malformed address before anything is written", () => {
    // "ops" used to be saved as no address under "Settings saved."
    const checked = action.indexOf("notificationInputProblems(");
    expect(checked, "the address is not checked").toBeGreaterThan(-1);
    expect(checked).toBeLessThan(action.indexOf("writeSettings("));
    expect(checked).toBeLessThan(action.indexOf("writePreferences("));
  });

  it("says the result in a toast, where the merchant is looking", () => {
    // The banner is at the top of a long page; Notifications is the last card on it.
    expect(route).toContain("showToast(");
    expect(route).toContain('"Settings saved"');
  });

  it("reads the stored address back, and asks the sender whether it can send", () => {
    expect(route).toContain("savedAddressLine(notifications.email)");
    expect(route).toContain("mailConfigured()");
    expect(route).not.toContain("process.env.RESEND_API_KEY");
  });

  it("no longer tells the merchant their deployment is not configured", () => {
    // App Review read this, above the field they had just filled in, as their save failing.
    expect(route).not.toContain("not configured on this deployment");
  });

  it("names who changed the notification preferences", () => {
    expect(action).toMatch(/writePreferences\([\s\S]*actor,\s*\)/);
  });
});
