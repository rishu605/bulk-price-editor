/**
 * No form listens for its fields' changes through React (#863).
 *
 * Every field in this app is a Polaris web component. Their events reach a form as
 * native `input` and `change` events whose target is the custom element, and React does
 * not turn those into an `onChange` on an ancestor. The campaign editor's
 * `<Form onChange={requestPreview}>` never fired: its preview was priced once, at load,
 * and never again, and the guided create button that shared the handler never enabled
 * (#715). Measured in the admin: one edit gave native change=1, input=2, React
 * onChange=0.
 *
 * A form that needs to hear its fields listens natively, as `SettingsSaveBar` and the
 * campaign editor do. `onChange` on a single `s-select` is fine: React 19 binds that one
 * directly to the element.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../lib/testing/source";

describe("forms and their fields' events", () => {
  it("never puts a React onChange or onInput on a form", () => {
    const offenders = sourceFiles("app/routes", "app/components").filter((file) =>
      /<(Form|form|fetcher\.Form)\b[^>]*\bon(Change|Input)=/.test(sourceOf(file)),
    );

    expect(offenders, "listen natively on the form instead; see the note above").toEqual([]);
  });
});
