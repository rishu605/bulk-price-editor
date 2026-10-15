import { describe, expect, it } from "vitest";

import { importCheckKey, uncheckedCommit } from "./check-key.server";

const FILE = "Variant SKU,Price\nCH-1,129.00";
const WORDS = { outcome: "no baselines were written", next: "import what the check shows" };

describe("a commit is the rows that were checked (#989, #1059)", () => {
  it("lets through the rows its key was made from", () => {
    expect(uncheckedCommit(importCheckKey(FILE), FILE, WORDS)).toBeNull();
  });

  it("does not count line endings or a trailing newline as different rows", () => {
    // A textarea may hand back CRLF, or a newline after the last row, without anyone
    // editing a row.
    expect(uncheckedCommit(importCheckKey(FILE), `${FILE.replace("\n", "\r\n")}\r\n`, WORDS)).toBeNull();
    expect(uncheckedCommit(importCheckKey(`${FILE}\n`), FILE, WORDS)).toBeNull();
  });

  it("refuses a commit with no key, an empty one, or a file", () => {
    for (const checked of [null, "", new File([FILE], "rows.csv")]) {
      expect(uncheckedCommit(checked, FILE, WORDS), String(checked)).not.toBeNull();
    }
  });

  it("refuses rows other than the ones checked", () => {
    const key = importCheckKey(FILE);
    expect(uncheckedCommit(key, `${FILE}\nCH-2,1.00`, WORDS)).not.toBeNull();
    expect(uncheckedCommit(key, FILE.replace("129.00", "12.90"), WORDS)).not.toBeNull();
    expect(uncheckedCommit(key, "", WORDS)).not.toBeNull();
  });

  it("names what was not done, why, and what to do next, in the importer's words", () => {
    expect(uncheckedCommit(null, FILE, WORDS)).toEqual({
      ok: false,
      message:
        "These rows are not the ones that were checked, so no baselines were written. Check the file again, then import what the check shows.",
    });
  });
});
