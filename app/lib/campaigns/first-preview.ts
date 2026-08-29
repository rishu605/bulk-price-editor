import { draftDefaultParams } from "./draft-defaults";

/**
 * The request that populates the preview before the merchant has touched anything.
 *
 * Built rather than read off the form, because at mount the form does not yet describe
 * what is on screen: the fields are Polaris custom elements, and serialising them at
 * that instant produced a scope that matched nothing where an empty filter should match
 * everything (#470). Every request after this one reads the form, by which time it is
 * trustworthy.
 *
 * Rounding comes from the shop. `readRoundingPolicy` falls back to `"none"` when the
 * field is absent while the select renders the store's setting, so leaving it out is a
 * preview that rounds differently from the form beside it.
 *
 * The URL wins last: a merchant who arrived from a segment, a collection or the calendar
 * has already made those choices, and the fields render them.
 */
export function firstPreviewParams(
  rounding: { default: string; byCurrency: Record<string, string> },
  from: URLSearchParams,
): URLSearchParams {
  const params = draftDefaultParams();

  params.set("rounding.default", rounding.default);
  for (const [code, profile] of Object.entries(rounding.byCurrency)) {
    params.set(`rounding.${code}`, profile);
  }
  for (const [key, value] of from) if (value) params.set(key, value);

  return params;
}
