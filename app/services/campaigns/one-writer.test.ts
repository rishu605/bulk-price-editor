/**
 * `CLAUDE.md` rule 2, pinned to what the code actually does.
 *
 * The rule used to read "The web process never writes prices. The worker is the only
 * writer." That was false, and had been for a long time: Apply, Revert, Resume and both
 * Flow actions call `runCampaign` inline from the web dyno. The design never assumed one
 * writer *process* — it coordinates several, by making them race for a row.
 *
 * A stated invariant that is false is worse than none, because the next person reasons
 * from it. That happened: #177 was told an undeployed worker meant "there is no writer",
 * which was wrong.
 *
 * So the rule was rewritten to the invariant the code enforces, and this holds it there.
 * Both halves are checked — the sentence in `CLAUDE.md` and the mechanism in the source —
 * because the failure to guard against is not one of them changing. It is them drifting
 * apart again, quietly, in either direction.
 */

import { describe, expect, it } from "vitest";

import { rawSource, sourceFiles, sourceOf } from "../../lib/testing/source";

const RUN = sourceOf("app/services/campaigns/run.server.ts");

describe("the claim is what grants the right to write", () => {
  it("takes the occurrence row before executing anything", () => {
    // `campaignRun.create` is the claim: `(campaignId, occurrenceKey, kind)` is unique, so
    // exactly one caller can hold it. Executing before taking it would let two processes
    // write the same campaign's prices at once.
    const claim = RUN.indexOf("prisma.campaignRun.create");
    const execute = RUN.indexOf("await executeRows(");

    expect(claim, "the run must claim its occurrence").toBeGreaterThan(-1);
    expect(execute, "the run must execute rows").toBeGreaterThan(-1);
    expect(claim, "writing before claiming is two processes on one campaign").toBeLessThan(
      execute,
    );
  });

  it("stands down instead of failing when it loses the race", () => {
    // Losing must not look like a failure. It is what happens in the window after a Redis
    // restart drops the leader lock, and a scheduler that reports a crash where it should
    // report "already running" is a scheduler nobody can read.
    expect(RUN).toContain("isOccurrenceTaken(error)");
    expect(RUN).toContain("deferredTo");
  });

  it("keeps the uniqueness in the database, not in a check", () => {
    // A read-then-create would have a window between the two. The schema is the guard.
    expect(rawSource("prisma/schema.prisma")).toContain(
      "@@unique([campaignId, occurrenceKey, kind])",
    );
  });
});

describe("nothing writes prices outside a claimed run", () => {
  it("is the only caller of the executor", () => {
    // `executeRows` is the function that talks to the Admin API about prices. Anything
    // else calling it would be writing without a claim — and without the ledger rows and
    // the read-back verification that `runCampaign` wraps it in.
    const callers = sourceFiles("app", "chaos", "scripts").filter(
      (file) =>
        file !== "app/services/campaigns/execute.server.ts" &&
        /\bexecuteRows\s*\(/.test(sourceOf(file)),
    );

    expect(callers, "only runCampaign may execute rows").toEqual([
      "app/services/campaigns/run.server.ts",
    ]);
  });
});

describe("the rule in CLAUDE.md says this and not the old thing", () => {
  const rules = rawSource("CLAUDE.md");

  it("no longer claims the worker is the only writer", () => {
    // The specific false sentence, so reinstating it fails here rather than misleading
    // the next person to read the file.
    expect(rules).not.toContain("The worker is the only writer");
    expect(rules).not.toContain("The web process never writes prices");
  });

  it("states the invariant that is actually enforced", () => {
    expect(rules).toContain("One writer per occurrence");
    expect(rules).toContain("MAX_INLINE_ROWS");
  });

  it("names a bound that exists", () => {
    // The rule points at the thing that makes web writing safe. If that constant is
    // renamed or deleted, the rule is describing a guard the app no longer has.
    expect(sourceOf("app/lib/execution/inline-budget.ts")).toContain(
      "export const MAX_INLINE_ROWS",
    );
  });
});
