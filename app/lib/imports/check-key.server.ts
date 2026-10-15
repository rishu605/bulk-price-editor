import { createHash } from "node:crypto";

/**
 * What a price file's check answers with, and its commit has to carry back (#989).
 *
 * The form disables Create after the rows are edited (#766), but the route took whatever
 * rows a commit posted: a stray submit, or a form somebody edited, made a campaign from
 * rows nobody had checked. The costs page refuses that (#754); this is the same rule for a
 * file. A digest of the rows as posted -- line endings and trailing space aside, which a
 * textarea may change without anyone editing a row.
 */
export function importCheckKey(csv: string): string {
  return createHash("sha256").update(csv.replace(/\r\n?/g, "\n").trimEnd()).digest("hex");
}
