/**
 * The manifest and the code that reads it, held together.
 *
 * The bug this exists to stop: all three action routes read `properties["campaign id"]`
 * while their manifests declared `campaign-id`. Every Flow action received an empty id,
 * found no campaign, and returned 200 — so Flow reported success and no price ever moved.
 * Nothing failed. That is why it survived: there is no error to notice.
 *
 * The strong assertion is the set equality below. Checking only that each declared key is
 * read would have passed the broken code the moment somebody added a correct lookup
 * alongside the wrong one; requiring the two sets to be equal catches a stale spelling.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseFlowManifest } from "./manifest";

const EXTENSIONS = join(process.cwd(), "extensions");
const ROUTES = join(process.cwd(), "app", "routes");

function manifests() {
  return readdirSync(EXTENSIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(EXTENSIONS, entry.name, "shopify.extension.toml"))
    .map((path) => parseFlowManifest(readFileSync(path, "utf8")));
}

describe("parsing a manifest", () => {
  const toml = `
# A comment that mentions handle = "not-this"

[[extensions]]
name = "End a price campaign"
handle = "end-campaign"
type = "flow_action"
runtime_url = "https://example.test/flow/actions/end-campaign"

[settings]

  [[settings.fields]]
  type = "single_line_text_field"
  key = "campaign-id"
  name = "Campaign ID"

  [[settings.fields]]
  type = "single_line_text_field"
  key = "reason"
`;

  it("reads the handle, type and every field key", () => {
    expect(parseFlowManifest(toml)).toEqual({
      handle: "end-campaign",
      type: "flow_action",
      fieldKeys: ["campaign-id", "reason"],
    });
  });

  it("does not mistake a field's own type for the extension's", () => {
    // `type = "single_line_text_field"` appears twice above and must not win.
    expect(parseFlowManifest(toml).type).toBe("flow_action");
  });

  it("ignores commented-out lines", () => {
    expect(parseFlowManifest(toml).handle).toBe("end-campaign");
  });
});

describe("every action route reads the keys its manifest declares", () => {
  const actions = manifests().filter((manifest) => manifest.type === "flow_action");

  // A glob that quietly matched nothing would make every assertion below vacuous.
  it("found the action manifests", () => {
    expect(actions.map((action) => action.handle).sort()).toEqual([
      "capture-baselines",
      "end-campaign",
      "start-campaign",
    ]);
  });

  it.each(actions)("$handle", (manifest) => {
    expect(manifest.fieldKeys.length).toBeGreaterThan(0);

    const source = readFileSync(join(ROUTES, `flow.actions.${manifest.handle}.tsx`), "utf8");
    const read = [...source.matchAll(/properties\?\.\["([^"]+)"\]/g)].map((match) => match[1]);

    expect(read.length).toBeGreaterThan(0);
    expect(new Set(read)).toEqual(new Set(manifest.fieldKeys));
  });
});

describe("every trigger key exists on TriggerPayload", () => {
  const triggers = manifests().filter((manifest) => manifest.type === "flow_trigger");
  const server = readFileSync(join(process.cwd(), "app", "services", "flow.server.ts"), "utf8");
  const payload = server.slice(
    server.indexOf("export interface TriggerPayload"),
    server.indexOf("export function containsPrice"),
  );

  it("found the trigger manifests", () => {
    expect(triggers.map((trigger) => trigger.handle).sort()).toEqual([
      "campaign-ended",
      "campaign-held",
      "campaign-started",
    ]);
  });

  it.each(triggers)("$handle", (manifest) => {
    for (const key of manifest.fieldKeys) {
      // Spaced keys are quoted in the interface; a bare identifier like `outcome` is not.
      expect(payload).toMatch(new RegExp(`(^|\\s)"?${key}"?\\??:`, "m"));
    }
  });
});
