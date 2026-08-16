/**
 * The resume-equivalence test the ticket asks for (E2), driven through the real
 * executor rather than a model of it.
 *
 * A planner-level simulation can only prove the planner converges. This kills an
 * actual `executeSync` partway through -- the client starts throwing after N writes,
 * exactly as a deploy or a dropped connection would -- then resumes from the ledger
 * that first pass produced and compares the final state, row by row and price by
 * price, against a run that was never interrupted.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { money } from "../money/money";
import type { PlannedRow, SurfaceRef } from "../planning/types";
import { RateLimitBudget } from "../shopify/budget";
import { executeSync, type AdminClient, type ExecutedRow } from "./sync-executor";
import { planResume, stateChecksum, type LedgerState, type PriorRow } from "./resume";

const noSleep = async () => {};
const budget = () => new RateLimitBudget({ now: () => 0, sleep: noSleep });

const ref = (variantGid: string): SurfaceRef => ({
  variantGid,
  surfaceKind: "base",
  priceListGid: "",
  currency: "USD",
});

/** Ten variants per product, so a cut lands mid-product as it would in reality. */
const productOf = (gid: string) => {
  const index = Number(gid.split("/").pop());
  return `gid://shopify/Product/${Math.floor(index / 10)}`;
};

function plannedRows(count: number): PlannedRow[] {
  return Array.from({ length: count }, (_, i) => ({
    ref: ref(`gid://shopify/ProductVariant/${i}`),
    beforePrice: money(10_000, "USD"),
    // A distinct price per row, so a checksum mismatch localises to a variant.
    intendedPrice: money(9_000 - i, "USD"),
    intendedCompareAtSet: false,
    status: "pending" as const,
  })) as unknown as PlannedRow[];
}

/**
 * A client that serves `writesBeforeFailure` variant writes and then refuses.
 *
 * `written` persists across instances when shared, which is what lets the second pass
 * read back prices the first pass actually wrote -- the whole point of the test.
 */
function interruptibleClient(
  written: Map<string, string>,
  writesBeforeFailure = Infinity,
): AdminClient {
  let writes = 0;

  return {
    async request<T>(query: string, variables: Record<string, unknown>) {
      if (query.includes("productVariantsBulkUpdate")) {
        const variants = variables.variants as Array<{ id: string; price?: string }>;

        if (writes + variants.length > writesBeforeFailure) {
          throw new Error("fetch failed");
        }
        writes += variants.length;

        for (const v of variants) if (v.price) written.set(v.id, v.price);

        return {
          data: {
            productVariantsBulkUpdate: {
              productVariants: variants.map((v) => ({
                id: v.id,
                price: v.price ?? "0",
                compareAtPrice: null,
              })),
              userErrors: [],
            },
          } as T,
          extensions: {
            cost: {
              actualQueryCost: 100,
              throttleStatus: {
                maximumAvailable: 1_000,
                currentlyAvailable: 900,
                restoreRate: 50,
              },
            },
          },
        };
      }

      // Read-back reflects what was genuinely written, including nothing.
      const ids = variables.ids as string[];
      return {
        data: {
          nodes: ids.map((id) => ({
            id,
            price: written.get(id) ?? "0",
            compareAtPrice: null,
          })),
        } as T,
      };
    },
  };
}

function toPrior(rows: ExecutedRow[]): PriorRow[] {
  return rows.map((executed) => ({
    variantGid: executed.row.ref.variantGid,
    status: (executed.status === "verified"
      ? "VERIFIED"
      : executed.status === "failed"
        ? "FAILED"
        : "APPLIED") as LedgerState,
    attempt: 1,
  }));
}

/** Fingerprints the live store, not the ledger: what a shopper would actually see. */
function storeChecksum(written: Map<string, string>): string {
  return stateChecksum(
    [...written.entries()].map(([variantGid, price]) => ({
      variantGid,
      status: "VERIFIED" as LedgerState,
      price: Number(price.replace(".", "")),
    })),
  );
}

async function run(rows: PlannedRow[], client: AdminClient) {
  return executeSync(rows, {
    client,
    budget: budget(),
    productOf,
    // Verify everything: the test is about convergence, and sampling would make the
    // comparison depend on which rows happened to be read back.
    verifySampleRate: 1,
    sleep: noSleep,
    random: () => 0,
  });
}

describe("a run killed partway resumes to the same state", () => {
  it("reaches an identical store after being cut at 40%", async () => {
    const planned = plannedRows(50);

    const cleanStore = new Map<string, string>();
    const clean = await run(planned, interruptibleClient(cleanStore));
    expect(clean.verified).toBe(50);

    // Interrupted at 40%, then resumed against the same store.
    const resumedStore = new Map<string, string>();
    const firstPass = await run(planned, interruptibleClient(resumedStore, 20));
    expect(firstPass.verified).toBeGreaterThan(0);
    expect(firstPass.verified).toBeLessThan(50);

    const plan = planResume(planned, toPrior(firstPass.rows));
    const secondPass = await run(plan.todo, interruptibleClient(resumedStore));

    expect(secondPass.failed).toBe(0);
    expect(storeChecksum(resumedStore)).toBe(storeChecksum(cleanStore));
  });

  it("converges from any cut point, including none and all", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 30 }), async (cut) => {
        const planned = plannedRows(30);

        const cleanStore = new Map<string, string>();
        await run(planned, interruptibleClient(cleanStore));

        const store = new Map<string, string>();
        const first = await run(planned, interruptibleClient(store, cut));
        const plan = planResume(planned, toPrior(first.rows));
        await run(plan.todo, interruptibleClient(store));

        expect(storeChecksum(store)).toBe(storeChecksum(cleanStore));
      }),
      { numRuns: 12 },
    );
  });

  it("does not rewrite a row the first pass already verified", async () => {
    const planned = plannedRows(20);
    const store = new Map<string, string>();

    const first = await run(planned, interruptibleClient(store, 10));
    const verified = first.rows
      .filter((r) => r.status === "verified")
      .map((r) => r.row.ref.variantGid);

    const plan = planResume(planned, toPrior(first.rows));
    const retried = new Set(plan.todo.map((r) => r.ref.variantGid));

    for (const gid of verified) {
      expect(retried.has(gid), `${gid} was verified and must not be rewritten`).toBe(false);
    }
  });

  it("is a no-op when re-delivered after finishing", async () => {
    // BullMQ redelivery: the same job arriving twice must not write anything a second
    // time. Nothing guards this at the queue level -- the row state machine is the
    // guard, and this is what proves it.
    const planned = plannedRows(15);
    const store = new Map<string, string>();

    const complete = await run(planned, interruptibleClient(store));
    expect(complete.verified).toBe(15);

    const redelivered = planResume(planned, toPrior(complete.rows));
    expect(redelivered.todo).toHaveLength(0);
    expect(redelivered.alreadyVerified).toBe(15);
  });
});
