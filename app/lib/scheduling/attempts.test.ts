import { describe, expect, it } from "vitest";

import { MAX_ATTEMPTS, nextAttemptKey } from "./attempts";

const BASE = "REVERT@2026-10-08T09:00:00.000Z";
const run = (occurrenceKey: string, status: string) => ({ occurrenceKey, status });

describe("nextAttemptKey (#700)", () => {
  it("runs the first attempt under the occurrence's own key", () => {
    expect(nextAttemptKey(BASE, [])).toBe(BASE);
  });

  it("gives a retry its own key once the previous attempt has finished", () => {
    // The stable key collided with its own finished run and stranded the campaign.
    expect(nextAttemptKey(BASE, [run(BASE, "PARTIAL")])).toBe(`${BASE}#2`);
    expect(nextAttemptKey(BASE, [run(BASE, "FAILED"), run(`${BASE}#2`, "PARTIAL")])).toBe(
      `${BASE}#3`,
    );
  });

  it("leaves the occurrence alone while an attempt is still running", () => {
    expect(nextAttemptKey(BASE, [run(BASE, "EXECUTING")])).toBeNull();
    expect(nextAttemptKey(BASE, [run(BASE, "PARTIAL"), run(`${BASE}#2`, "VERIFYING")])).toBeNull();
  });

  it(`stops after ${MAX_ATTEMPTS} attempts`, () => {
    const three = [run(BASE, "PARTIAL"), run(`${BASE}#2`, "PARTIAL"), run(`${BASE}#3`, "FAILED")];
    expect(nextAttemptKey(BASE, three)).toBeNull();
  });

  it("does not count another occurrence whose key merely starts the same way", () => {
    // A later window's key is a different instant, but a prefix match alone would read
    // "REVERT@…0Z1" as an attempt at "REVERT@…0Z".
    expect(nextAttemptKey(BASE, [run(`${BASE}1`, "PARTIAL")])).toBe(BASE);
  });
});
