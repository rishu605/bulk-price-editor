import { createHash } from "node:crypto";

/**
 * What a file's check answers with, and its commit has to carry back (#989, #1059).
 *
 * The form disables the commit after the rows are edited (#766), but a route took
 * whatever rows a commit posted: a stray submit, or a form somebody edited, wrote rows
 * nobody had checked. The costs page refuses that for its bulk editor (#754); this is the
 * same rule for a file. A digest of the rows as posted -- line endings and trailing space
 * aside, which a textarea may change without anyone editing a row.
 */
export function importCheckKey(csv: string): string {
  return createHash("sha256").update(csv.replace(/\r\n?/g, "\n").trimEnd()).digest("hex");
}

/** What a refused commit did not do, and what to do instead, in the importer's words. */
export interface UncheckedCommitWords {
  /** "no campaign was created", "no baselines were written". */
  outcome: string;
  /** "create the campaign from what the check shows". */
  next: string;
}

/**
 * The refusal for a commit whose rows are not the ones its check answered for, or `null`
 * when they are.
 *
 * Every importer's commit calls this before it reads a row, with the `checked` field its
 * form posts back. A missing key and a different file are the same refusal: either way the
 * rows were not checked, and checking them again is the fix. Here rather than in each
 * route so the three importers cannot drift apart again: two of them had no check at all
 * (#1059) while the third had refused for a release.
 */
export function uncheckedCommit(
  checked: FormDataEntryValue | null,
  csv: string,
  words: UncheckedCommitWords,
): { ok: false; message: string } | null {
  if (typeof checked === "string" && checked === importCheckKey(csv)) return null;
  return {
    ok: false,
    message: `These rows are not the ones that were checked, so ${words.outcome}. Check the file again, then ${words.next}.`,
  };
}
