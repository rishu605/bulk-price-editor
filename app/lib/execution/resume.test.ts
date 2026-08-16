import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  planResume,
  runOutcome,
  stateChecksum,
  type LedgerState,
  type PriorRow,
} from "./resume";
import {
  classifyFailure,
  shouldQuarantine,
  stopsTheRun,
  MAX_ATTEMPTS,
} from "./classify";
import type { PlannedRow } from "../planning/types";

const row = (gid: string): PlannedRow =>
  ({
    ref: { variantGid: gid, surfaceKind: "BASE", priceListGid: "" },
    status: "planned",
    intendedPrice: { amount: 1000, currency: "USD" },
  }) as unknown as PlannedRow;

const prior = (gid: string, status: LedgerState, attempt = 0): PriorRow => ({
  variantGid: gid,
  status,
  attempt,
});

describe("planResume", () => {
  it("never touches a verified row", () => {
    // The rule the whole guarantee rests on.
    const plan = planResume([row("a"), row("b")], [prior("a", "VERIFIED")]);
    expect(plan.todo.map((r) => r.ref.variantGid)).toEqual(["b"]);
    expect(plan.alreadyVerified).toBe(1);
  });

  it("re-plans a row that was written but never read back", () => {
    // APPLIED is the ambiguous state: it may or may not have landed. Rewriting an
    // already-correct price is a no-op; skipping one that never landed leaves a wrong
    // price live.
    const plan = planResume([row("a")], [prior("a", "APPLIED")]);
    expect(plan.todo).toHaveLength(1);
  });

  it("re-plans rows interrupted mid-write", () => {
    for (const state of ["PENDING", "WRITING", "FAILED"] as LedgerState[]) {
      expect(planResume([row("a")], [prior("a", state)]).todo, state).toHaveLength(1);
    }
  });

  it("leaves settled decisions alone", () => {
    // Skipped and clamped were decisions, not failures. Re-deciding them would reach
    // the same answer and cost an API call to do it.
    for (const state of ["SKIPPED", "CLAMPED", "REVERTED"] as LedgerState[]) {
      expect(planResume([row("a")], [prior("a", state)]).todo, state).toHaveLength(0);
    }
  });

  it("stops retrying a poison row once its attempts are spent", () => {
    const plan = planResume([row("a"), row("b")], [prior("a", "FAILED", 5)]);
    expect(plan.quarantined).toBe(1);
    expect(plan.todo.map((r) => r.ref.variantGid)).toEqual(["b"]);
  });

  it("picks up rows that entered scope since the last attempt", () => {
    const plan = planResume([row("a"), row("new")], [prior("a", "VERIFIED")]);
    expect(plan.todo.map((r) => r.ref.variantGid)).toEqual(["new"]);
  });

  it("has nothing to do for a completed run — so re-delivery is harmless", () => {
    // A duplicate job delivery re-plans only non-verified rows; on a finished run that
    // set is empty, which is what makes double-apply structurally impossible.
    const rows = [row("a"), row("b"), row("c")];
    const allVerified = rows.map((r) => prior(r.ref.variantGid, "VERIFIED"));
    expect(planResume(rows, allVerified).todo).toHaveLength(0);
  });
});

describe("resume equivalence (E2)", () => {
  it("a run killed at 40% resumes to an identical final state", () => {
    // The acceptance criterion, as a simulation: execute a run to completion, then
    // execute the same work interrupted at 40% and resumed, and compare fingerprints.
    const gids = Array.from({ length: 50 }, (_, i) => `gid://v${i}`);
    const planned = gids.map(row);

    const clean = simulate(planned, planned.length);

    const firstPass = simulate(planned, Math.floor(planned.length * 0.4));
    const resumePlan = planResume(planned, firstPass);
    const secondPass = simulate(resumePlan.todo, resumePlan.todo.length);

    // The resumed run's state is the verified rows from pass one plus pass two.
    const merged = [
      ...firstPass.filter((r) => r.status === "VERIFIED"),
      ...secondPass,
    ];

    expect(checksum(merged)).toBe(checksum(clean));
    expect(runOutcome(merged).clean).toBe(true);
  });

  it("converges however many times it is interrupted", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 1, maxLength: 6 }),
        (cutPoints) => {
          const gids = Array.from({ length: 30 }, (_, i) => `gid://v${i}`);
          const planned = gids.map(row);

          let done: PriorRow[] = [];
          for (const cut of cutPoints) {
            const plan = planResume(planned, done);
            const pass = simulate(plan.todo, Math.min(cut, plan.todo.length));
            done = [...done.filter((r) => r.status === "VERIFIED"), ...pass];
          }

          // Finish whatever is left.
          const finalPlan = planResume(planned, done);
          const finalPass = simulate(finalPlan.todo, finalPlan.todo.length);
          const merged = [...done.filter((r) => r.status === "VERIFIED"), ...finalPass];

          expect(runOutcome(merged).verified).toBe(planned.length);
          expect(checksum(merged)).toBe(checksum(simulate(planned, planned.length)));
        },
      ),
    );
  });
});

describe("runOutcome", () => {
  it("reports partial when any row is outstanding", () => {
    const rows = [prior("a", "VERIFIED"), prior("b", "FAILED")];
    expect(runOutcome(rows)).toEqual({ clean: false, verified: 1, outstanding: 1 });
  });

  it("never calls a run clean with a written-but-unverified row", () => {
    // The exact behaviour that earns competitors their one-star reviews.
    expect(runOutcome([prior("a", "APPLIED")]).clean).toBe(false);
  });

  it("counts a skipped row as settled, not outstanding", () => {
    expect(runOutcome([prior("a", "VERIFIED"), prior("b", "SKIPPED")]).clean).toBe(true);
  });
});

describe("failure classification", () => {
  it("treats a variant deleted mid-run as terminal for that row, not the run (E4)", () => {
    const result = classifyFailure("Variant does not exist");
    expect(result.class).toBe("TERMINAL_ROW");
    expect(result.reason).toBe("variant-deleted");
    expect(stopsTheRun(result)).toBe(false);
  });

  it("stops the run when the token is revoked", () => {
    // Every remaining row would fail identically; retrying is a rate-limit-consuming
    // way of failing 150,000 times.
    const result = classifyFailure("Invalid API key or access token");
    expect(result.class).toBe("TERMINAL_RUN");
    expect(stopsTheRun(result)).toBe(true);
  });

  it("retries throttles and network failures", () => {
    for (const message of ["Throttled", "fetch failed", "ETIMEDOUT", "503 Service Unavailable"]) {
      expect(classifyFailure(message).class, message).toBe("RETRYABLE");
    }
  });

  it("does not retry something the merchant has to fix", () => {
    const result = classifyFailure("Compare at price must be greater than price");
    expect(result.class).toBe("USER_FIXABLE");
    expect(shouldQuarantine(result, 1)).toBe(true);
  });

  it("retries an unrecognised failure rather than dropping the row", () => {
    // Wasting a few attempts on something terminal is cheap. Quarantining something
    // transient silently drops a price change the merchant asked for.
    expect(classifyFailure("something new from Shopify").class).toBe("RETRYABLE");
  });

  it("quarantines a retryable row only after its attempts are spent", () => {
    const throttled = classifyFailure("Throttled");
    expect(shouldQuarantine(throttled, 1)).toBe(false);
    expect(shouldQuarantine(throttled, MAX_ATTEMPTS - 1)).toBe(false);
    expect(shouldQuarantine(throttled, MAX_ATTEMPTS)).toBe(true);
  });

  it("never quarantines on a run-terminal failure", () => {
    // Those rows are untouched, not poisoned: a resume after reinstalling should
    // retry them normally.
    const revoked = classifyFailure("access denied");
    expect(shouldQuarantine(revoked, 99)).toBe(false);
  });

  it("always returns a message naming the next action", () => {
    fc.assert(
      fc.property(fc.string(), (message) => {
        const result = classifyFailure(message);
        expect(result.message.length).toBeGreaterThan(10);
        expect(result.reason).toBeTruthy();
      }),
    );
  });
});

/** Executes `count` of `rows`, leaving the rest untouched. */
function simulate(rows: readonly PlannedRow[], count: number): PriorRow[] {
  return rows
    .slice(0, count)
    .map((r) => prior(r.ref.variantGid, "VERIFIED", 1));
}

function checksum(rows: readonly PriorRow[]): string {
  return stateChecksum(rows.map((r) => ({ ...r, price: 1000 })));
}
