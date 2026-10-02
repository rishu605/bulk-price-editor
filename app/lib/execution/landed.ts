/**
 * The ledger states that mean "this price is on the storefront, written and read back".
 *
 * VERIFIED is the ordinary case. CLAMPED is the same write at a price the rule did not
 * ask for -- raised to a guardrail floor, or to the smallest price because the rule would
 * have reached zero (#792). It was in the enum, treated as settled by resume and counted
 * by the run summary, and never written: clamped rows were recorded as VERIFIED, so the
 * ledger claimed the rule's own price for them.
 *
 * Writing it means every reader asking "what did we put on the storefront" must count
 * both. One that filtered on VERIFIED alone would miss every clamped row: drift detection
 * would take our own write for an edit made elsewhere, reconciliation would call the
 * variant uncontrolled, the rollback report would not see it. `landed.test.ts` reads the
 * source for any ledger query that does.
 */

export const LANDED = ["VERIFIED", "CLAMPED"] as const;

/** Whether a ledger row's price is on the storefront. */
export function isLanded(status: string): boolean {
  return (LANDED as readonly string[]).includes(status);
}
