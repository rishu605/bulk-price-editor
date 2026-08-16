/**
 * The bulk write path: staged JSONL upload -> `bulkOperationRunMutation` -> result
 * reconciliation.
 *
 * Bulk operations carry **zero** rate-limit cost, which is the only reason a
 * 150K-variant campaign is viable at all against a bucket that restores 50
 * points/second. The trade is latency: submissions are queued FIFO per shop, so a
 * busy queue can add minutes before the first row is touched.
 *
 * Completion arrives one of two ways, and the second is not optional:
 *
 *   the `bulk_operations/finish` webhook, or
 *   a poll of `currentBulkOperation` once the expected duration has elapsed.
 *
 * Community reports document missed `finish` deliveries. Without the fallback a
 * missed webhook means a run that never completes and a merchant watching a progress
 * bar that never moves (edge case E13).
 */

import type { PlannedRow } from "../planning/types";
import { isThrottledError, withRetry } from "../shopify/budget";
import type { AdminClient } from "./sync-executor";
import { buildMutationLines, parseResults, serializeJsonl, streamLines } from "./jsonl";
import type { VariantOutcome } from "./jsonl";

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED";

export interface BulkOperationState {
  id: string;
  status: BulkOperationStatus;
  url?: string | null;
  partialDataUrl?: string | null;
  objectCount?: string | number | null;
  errorCode?: string | null;
}

export interface StagedTarget {
  url: string;
  resourceUrl?: string | null;
  parameters: Array<{ name: string; value: string }>;
}

/** Uploads the JSONL body to the staged target. Injected so tests need no network. */
export type Uploader = (target: StagedTarget, body: string) => Promise<void>;

/** Fetches a result file as a stream of text chunks. Injected likewise. */
export type ResultFetcher = (url: string) => AsyncIterable<string>;

export const STAGED_UPLOADS_CREATE = `#graphql
  mutation AnchorStagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets { url resourceUrl parameters { name value } }
      userErrors { field message }
    }
  }
`;

export const BULK_OPERATION_RUN_MUTATION = `#graphql
  mutation AnchorBulkOperationRunMutation($mutation: String!, $stagedUploadPath: String!) {
    bulkOperationRunMutation(mutation: $mutation, stagedUploadPath: $stagedUploadPath) {
      bulkOperation { id status url partialDataUrl objectCount }
      userErrors { field message }
    }
  }
`;

export const CURRENT_BULK_OPERATION = `#graphql
  query AnchorCurrentBulkOperation {
    currentBulkOperation(type: MUTATION) {
      id status url partialDataUrl objectCount errorCode
    }
  }
`;

export class BulkSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkSubmissionError";
  }
}

export interface SubmitOptions {
  client: AdminClient;
  upload: Uploader;
  productOf: (variantGid: string) => string;
  /** The mutation the JSONL lines are arguments for. */
  mutation?: string;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/** Builds the payload, stages it, uploads it and submits the operation. */
export async function submitBulkMutation(
  rows: Iterable<PlannedRow>,
  options: SubmitOptions,
): Promise<BulkOperationState> {
  const { client, upload, productOf, sleep, maxAttempts = 5 } = options;

  const body = [...serializeJsonl(buildMutationLines(rows, productOf))].join("");
  if (body.length === 0) {
    throw new BulkSubmissionError("Nothing to submit: no writable rows.");
  }

  const staged = await withRetry(
    () =>
      client.request<{
        stagedUploadsCreate?: {
          stagedTargets?: StagedTarget[];
          userErrors?: Array<{ message: string }>;
        };
      }>(STAGED_UPLOADS_CREATE, {
        input: [
          {
            resource: "BULK_MUTATION_VARIABLES",
            filename: "anchor-bulk.jsonl",
            mimeType: "text/jsonl",
            httpMethod: "POST",
          },
        ],
      }),
    isThrottledError,
    { maxAttempts, sleep },
  );

  const stagedErrors = staged.data?.stagedUploadsCreate?.userErrors ?? [];
  if (stagedErrors.length > 0) {
    throw new BulkSubmissionError(
      `stagedUploadsCreate failed: ${stagedErrors.map((e) => e.message).join("; ")}`,
    );
  }

  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) throw new BulkSubmissionError("stagedUploadsCreate returned no target.");

  await upload(target, body);

  // The staged path is carried in the `key` parameter of the upload target.
  const key = target.parameters.find((p) => p.name === "key")?.value;
  if (!key) throw new BulkSubmissionError("Staged target has no `key` parameter.");

  const submitted = await withRetry(
    () =>
      client.request<{
        bulkOperationRunMutation?: {
          bulkOperation?: BulkOperationState;
          userErrors?: Array<{ message: string }>;
        };
      }>(BULK_OPERATION_RUN_MUTATION, {
        mutation: options.mutation ?? DEFAULT_BULK_MUTATION,
        stagedUploadPath: key,
      }),
    isThrottledError,
    { maxAttempts, sleep },
  );

  const submitErrors = submitted.data?.bulkOperationRunMutation?.userErrors ?? [];
  if (submitErrors.length > 0) {
    throw new BulkSubmissionError(
      `bulkOperationRunMutation failed: ${submitErrors.map((e) => e.message).join("; ")}`,
    );
  }

  const operation = submitted.data?.bulkOperationRunMutation?.bulkOperation;
  if (!operation) throw new BulkSubmissionError("Submission returned no bulkOperation.");

  return operation;
}

export const DEFAULT_BULK_MUTATION = `
  mutation call($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants { id price compareAtPrice }
      userErrors { field message code }
    }
  }
`;

/** Terminal states: no further polling will change the outcome. */
export function isTerminal(status: BulkOperationStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELED" || status === "EXPIRED";
}

export interface PollOptions {
  client: AdminClient;
  /** Time between polls. */
  intervalMs?: number;
  /** Give up after this long and report, rather than polling forever. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/**
 * Polls until the operation reaches a terminal state.
 *
 * This is the fallback for a missed `finish` webhook, not a replacement for it —
 * the webhook is faster and cheaper when it arrives. A timeout returns the last
 * observed state rather than throwing, so the caller can surface "still running"
 * honestly instead of failing a run that may yet succeed.
 */
export async function pollUntilTerminal(
  options: PollOptions,
): Promise<BulkOperationState | undefined> {
  const {
    client,
    intervalMs = 5_000,
    timeoutMs = 30 * 60_000,
    now = () => Date.now(),
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    maxAttempts = 5,
  } = options;

  const deadline = now() + timeoutMs;
  let last: BulkOperationState | undefined;

  for (;;) {
    const response = await withRetry(
      () => client.request<{ currentBulkOperation?: BulkOperationState | null }>(
        CURRENT_BULK_OPERATION,
        {},
      ),
      isThrottledError,
      { maxAttempts, sleep },
    );

    last = response.data?.currentBulkOperation ?? last;
    if (last && isTerminal(last.status)) return last;
    if (now() >= deadline) return last;

    await sleep(intervalMs);
  }
}

export interface ReconcileResult {
  /** Variant gid -> outcome, for every variant Shopify reported on. */
  outcomes: Map<string, VariantOutcome>;
  /** Rows we sent but never heard about. Left unverified, never assumed successful. */
  unreported: string[];
  malformedLines: Array<{ malformed: string; reason: string }>;
}

/**
 * Reconciles a finished operation's result file against the rows we sent.
 *
 * The important asymmetry: absence is never success. A row we submitted but that
 * appears nowhere in the results stays unverified and gets retried. Assuming
 * otherwise is exactly how a half-applied campaign gets reported as complete.
 *
 * `partialDataUrl` is used when the operation failed or was cancelled part-way,
 * so whatever did complete is still reconciled rather than discarded.
 */
export async function reconcileResults(
  operation: BulkOperationState,
  submittedVariantGids: Iterable<string>,
  fetchResults: ResultFetcher,
): Promise<ReconcileResult> {
  const outcomes = new Map<string, VariantOutcome>();
  const malformedLines: Array<{ malformed: string; reason: string }> = [];

  const url = operation.url ?? operation.partialDataUrl ?? undefined;

  if (url) {
    for await (const item of parseResults(streamLines(fetchResults(url)))) {
      if ("malformed" in item) malformedLines.push(item);
      else outcomes.set(item.variantGid, item);
    }
  }

  const unreported: string[] = [];
  for (const gid of submittedVariantGids) {
    if (!outcomes.has(gid)) unreported.push(gid);
  }

  return { outcomes, unreported, malformedLines };
}
