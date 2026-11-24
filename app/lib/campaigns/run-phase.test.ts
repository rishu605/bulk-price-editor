/**
 * The page says where a queued run has got, from its row (#808): Queued, Planning, Writing N
 * of M, Verifying. A page that said "Applying" for minutes read as a run that was stuck (#790).
 */

import { describe, expect, it } from "vitest";

import { runPhase } from "./run-phase";

describe("where a run in flight has got", () => {
  it("names the steps before a price is written", () => {
    expect(runPhase({ status: "QUEUED" })).toBe("Queued");
    expect(runPhase({ status: "PLANNING" })).toBe("Planning");
  });

  it("counts the prices written, from the heartbeat's count", () => {
    expect(runPhase({ status: "EXECUTING", writePath: "SYNC", writtenRows: 1_200, writableRows: 4_000 })).toBe(
      "Writing 1,200 of 4,000 prices",
    );
    expect(runPhase({ status: "EXECUTING", writePath: "SYNC", writtenRows: 0, writableRows: 60 })).toBe("Writing 0 of 60 prices");
  });

  it("never says 0 of 0 before the run has reported a count", () => {
    expect(runPhase({ status: "EXECUTING" })).toBe("Writing prices");
    expect(runPhase({ status: "EXECUTING", writtenRows: null, writableRows: null })).toBe("Writing prices");
  });

  it("says what a bulk operation is waiting on, rather than none written for an hour", () => {
    expect(runPhase({ status: "EXECUTING", writePath: "BULK", writtenRows: 0, writableRows: 62_535 })).toBe(
      "Writing 62,535 prices as one Shopify bulk operation",
    );
  });

  it("says Verifying once every price is sent, before the run moves its own status", () => {
    expect(runPhase({ status: "EXECUTING", writePath: "SYNC", writtenRows: 60, writableRows: 60 })).toBe("Verifying");
    expect(runPhase({ status: "VERIFYING", writtenRows: 60, writableRows: 60 })).toBe("Verifying");
  });

  it("says nothing of a run that has finished", () => {
    for (const status of ["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]) expect(runPhase({ status }), status).toBeNull();
  });
});
