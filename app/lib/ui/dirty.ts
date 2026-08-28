/**
 * Whether a form still holds what the merchant typed.
 *
 * Read from the form's own fields rather than mirrored into React state, the same way
 * `SettingsSaveBar` reads it: mirroring means two sources of truth for "has this
 * changed", and the one that goes stale is the one deciding whether somebody is warned
 * before losing their work.
 *
 * Split into a DOM read and a comparison, because the comparison is the part that can be
 * wrong in the dangerous direction — reporting a changed form as clean lets the work go
 * silently — and it can only be tested on its own if it does not need a document to run.
 */

/**
 * The form, serialised the way a submit would send it.
 *
 * Through `FormData` rather than by walking the fields, so it sees exactly what would be
 * posted: fields added after mount, checkboxes in their submitted form, and nothing that
 * is disabled.
 */
export function snapshotOf(form: HTMLFormElement): string {
  return new URLSearchParams(new FormData(form) as unknown as string[][]).toString();
}

/**
 * Whether the form differs from how it started.
 *
 * Either value being null means there is nothing to compare — the form had not mounted
 * when the snapshot was taken — and the honest answer there is "nothing to lose" rather
 * than blocking every navigation off a page that never rendered a field.
 */
export function hasChanged(current: string | null, pristine: string | null): boolean {
  if (current === null || pristine === null) return false;
  return current !== pristine;
}
