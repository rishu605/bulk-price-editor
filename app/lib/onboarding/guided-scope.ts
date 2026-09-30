/**
 * Whether a guided first campaign has been narrowed yet (#624, #715).
 *
 * The guided page says "narrow the scope to a handful of products" and holds its create
 * button until the merchant has. The answer used to be worked out once, in the loader,
 * from the URL — true when the scope lived in a GET form. Since #442 the scope is part of
 * the one POST form and never reaches the URL, so the loader's answer never changed and
 * the button never enabled. One rule, read from wherever the scope is: the URL for the
 * first render, the form as the merchant changes it, the submitted form on the server.
 */

import { SCOPE_CONDITION_FIELDS, type FieldReader } from "../campaigns/draft-form";

/**
 * The fields that narrow a campaign to something smaller than the catalogue.
 *
 * Every condition field except `excludeTag`: taking one tag out of everything still
 * leaves nearly everything, which is not the handful the banner asks for. Derived rather
 * than listed, so a condition field added later narrows too without anyone remembering.
 * A saved segment replaces the inline filter, so it counts on its own.
 */
export const NARROWING_FIELDS = [
  ...SCOPE_CONDITION_FIELDS.filter((field) => field !== "excludeTag"),
  "segment",
] as const;

export function scopeChosen(read: FieldReader): boolean {
  return NARROWING_FIELDS.some((field) => (read(field) ?? "").trim() !== "");
}
