/**
 * Choosing and driving a write path.
 *
 * The planner decides sync or bulk; this module actually runs the chosen one and
 * normalises both into the same per-row result shape, so the caller records
 * outcomes identically either way.
 *
 * Without this, a 1,615-row campaign would preview as "bulk" and then execute
 * synchronously -- roughly one variant every two seconds against a standard shop's
 * rate limit, which is not merely slow but infeasible.
 */

import {
  reconcileResults,
  submitBulkMutation,
  pollUntilTerminal,
  type StagedTarget,
} from "../../lib/execution/bulk-executor";
import { executeSync, type AdminClient, type ExecutedRow } from "../../lib/execution/sync-executor";
import type { PlannedRow } from "../../lib/planning/types";
import { selectWritePath } from "../../lib/planning/write-path";
import { RateLimitBudget } from "../../lib/shopify/budget";

export interface ExecuteOutcome {
  rows: ExecutedRow[];
  verified: number;
  failed: number;
  unverified: number;
  clean: boolean;
  path: "sync" | "bulk";
}

export interface ExecuteContext {
  client: AdminClient;
  productOf: (variantGid: string) => string;
  verifySampleRate?: number;
  /** Overrides the automatic choice. Only used by tests and diagnostics. */
  forcePath?: "sync" | "bulk";
  /**
   * Liveness signal, called as work settles on either path.
   *
   * Both paths report it, and they have to: a bulk run spends almost all its time
   * waiting on a poll, so a heartbeat that only fired on sync writes would let the
   * reaper declare every long bulk run dead.
   */
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

/** Uploads a JSONL body to a staged target using multipart form data. */
async function uploadToStagedTarget(target: StagedTarget, body: string): Promise<void> {
  const form = new FormData();
  // Parameter order matters to the storage backend, and the file field must be last.
  for (const { name, value } of target.parameters) form.append(name, value);
  form.append("file", new Blob([body], { type: "text/jsonl" }), "anchor-bulk.jsonl");

  const response = await fetch(target.url, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`Staged upload failed: ${response.status} ${await response.text()}`);
  }
}

export async function executeRows(
  rows: PlannedRow[],
  context: ExecuteContext,
): Promise<ExecuteOutcome> {
  const writable = rows.filter((row) => row.status !== "skipped" && row.intendedPrice);
  const decision = selectWritePath(writable.length);
  const path = context.forcePath ?? decision.path;

  if (path === "sync") {
    const result = await executeSync(rows, {
      client: context.client,
      budget: new RateLimitBudget(),
      productOf: context.productOf,
      verifySampleRate: context.verifySampleRate ?? 1,
      onProgress: context.onProgress,
    });
    return { ...result, path: "sync" };
  }

  return executeBulk(rows, writable, context);
}

/**
 * The bulk path.
 *
 * Absence is never treated as success: any row we submitted that the result file
 * does not mention stays unverified and is reported as such, rather than being
 * assumed to have worked. That asymmetry is what stops a half-applied campaign
 * being reported complete.
 */
async function executeBulk(
  allRows: PlannedRow[],
  writable: PlannedRow[],
  context: ExecuteContext,
): Promise<ExecuteOutcome> {
  const skipped: ExecutedRow[] = allRows
    .filter((row) => row.status === "skipped" || !row.intendedPrice)
    .map((row) => ({ row, status: "verified" as const }));

  const operation = await submitBulkMutation(writable, {
    client: context.client,
    upload: uploadToStagedTarget,
    productOf: context.productOf,
  });

  // The finish webhook is faster when it arrives, but it is documented to go
  // missing; polling is the fallback that stops a run hanging forever (E13).
  //
  // The heartbeat rides on the poll interval. A bulk operation is almost entirely
  // waiting, so this is the only place a long one can prove it is still alive --
  // without it the reaper would mistake every large run for a dead process.
  const finished = await pollUntilTerminal({
    client: context.client,
    sleep: async (ms) => {
      await context.onProgress?.(0, writable.length);
      await new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  });
  const finalState = finished ?? operation;

  const submittedGids = writable.map((row) => row.ref.variantGid);
  const { outcomes, unreported } = await reconcileResults(
    finalState,
    submittedGids,
    fetchResultFile,
  );

  const unreportedSet = new Set(unreported);
  const executed: ExecutedRow[] = writable.map((row) => {
    const gid = row.ref.variantGid;

    if (unreportedSet.has(gid)) {
      return {
        row,
        status: "applied-unverified",
        failureReason:
          `Not present in the bulk result file (operation ${finalState.status}). ` +
          `Left unverified rather than assumed successful.`,
      };
    }

    const outcome = outcomes.get(gid);
    if (!outcome || !outcome.ok) {
      return { row, status: "failed", failureReason: outcome?.failureReason ?? "Unknown failure" };
    }
    return { row, status: "verified" };
  });

  const rows = [...executed, ...skipped];
  const verified = rows.filter((r) => r.status === "verified").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const unverified = rows.filter((r) => r.status === "applied-unverified").length;

  return { rows, verified, failed, unverified, clean: failed === 0 && unverified === 0, path: "bulk" };
}

/** Streams a result file as text chunks so a large file is never fully buffered. */
async function* fetchResultFile(url: string): AsyncGenerator<string> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not fetch bulk results: ${response.status}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
  yield decoder.decode();
}
