/**
 * The rows a cost import could not use, as a file to fix and re-upload.
 *
 * The line number is the point. "37 rows failed" sends a merchant scrolling through a
 * spreadsheet; "line 412, SKU-9931, cost is not a plain number" is something they can
 * act on in seconds.
 */

import type { CostImportResult } from "../../services/cost-import.server";
import { toCsv } from "./csv";

export function costErrorCsv(result: CostImportResult): string {
  const rows = [
    ...result.invalid.map((problem) => ["invalid", problem] as const),
    ...result.unmatched.map((problem) => ["unmatched", problem] as const),
    ...result.ambiguous.map((problem) => ["ambiguous", problem] as const),
  ];

  return toCsv(
    ["Line", "Identifier", "Problem", "What to do"],
    rows
      .sort((a, b) => a[1].line - b[1].line)
      .map(([kind, problem]) => [
        String(problem.line),
        problem.identifier,
        kind,
        problem.reason,
      ]),
  );
}
