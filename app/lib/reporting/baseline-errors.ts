/**
 * The baseline import error file.
 *
 * Client-safe, like the other exports: the download is built in the browser from data
 * the page already holds, because a resource route cannot authenticate inside an
 * embedded app's iframe.
 *
 * It exists because the point is to fix the rows and re-upload. A list a merchant has
 * to retype off a screen is a list they will not fix.
 */

import { toCsv } from "./csv";

export interface ImportProblem {
  line: number;
  identifier: string;
  reason: string;
}

export interface ProblemReport {
  invalid: ImportProblem[];
  unmatched: ImportProblem[];
  ambiguous: ImportProblem[];
}

export function importErrorCsv(report: ProblemReport): string {
  const rows: string[][] = [];

  for (const [kind, list] of [
    ["invalid", report.invalid],
    ["unmatched", report.unmatched],
    ["ambiguous", report.ambiguous],
  ] as const) {
    for (const problem of list) {
      rows.push([String(problem.line), problem.identifier, kind, problem.reason]);
    }
  }

  rows.sort((a, b) => Number(a[0]) - Number(b[0]));
  return toCsv(["line", "identifier", "problem", "what_to_do"], rows);
}
