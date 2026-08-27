/**
 * Reading the field keys back out of a Flow extension manifest.
 *
 * Flow keys an action's `properties` by the field `key` in the extension TOML, and a
 * trigger's payload by its field keys — and the two use different alphabets. Trigger keys
 * are alphabetic characters and spaces ("campaign id"); action keys are identifiers
 * ("campaign-id"). Nothing connects the manifest to the code that reads it, so a route
 * looking up the wrong spelling gets `undefined` and carries on: the action returns 200,
 * Flow shows a green tick, and nothing happened.
 *
 * This exists so a test can hold the two together. It is deliberately a few lines of
 * line-oriented parsing rather than a TOML dependency — it only ever reads manifests this
 * repo writes, and it tracks the current table so a field's own `type = ` is not mistaken
 * for the extension's.
 */

export interface FlowManifest {
  /** `handle` — also the route filename and the last segment of `runtime_url`. */
  handle: string;
  /** `flow_action` or `flow_trigger`. */
  type: string;
  /** Every `key` under `[[settings.fields]]`, in declaration order. */
  fieldKeys: string[];
}

const HEADER = /^\[\[?([^\]]+?)\]?\]$/;
const PAIR = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"(.*)"$/;

export function parseFlowManifest(toml: string): FlowManifest {
  let section = "";
  let handle = "";
  let type = "";
  const fieldKeys: string[] = [];

  for (const raw of toml.split("\n")) {
    const line = raw.trim();
    // Whole-line comments only. Values here never carry a trailing `#`, and stripping one
    // blindly would corrupt any that later did.
    if (line === "" || line.startsWith("#")) continue;

    const header = line.match(HEADER);
    if (header) {
      section = header[1];
      continue;
    }

    const pair = line.match(PAIR);
    if (!pair) continue;
    const [, key, value] = pair;

    if (section === "extensions") {
      if (key === "handle") handle = value;
      if (key === "type") type = value;
    } else if (section === "settings.fields" && key === "key") {
      fieldKeys.push(value);
    }
  }

  return { handle, type, fieldKeys };
}
