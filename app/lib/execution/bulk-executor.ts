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

import { AppError } from "../errors/app-error";
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

/**
 * Shopify would not accept the submission, so nothing was written.
 *
 * An `AppError` rather than a bare `Error`, and that is the whole fix for #649. It used
 * to extend `Error`, nothing caught it, and `classify()` has no branch matching any of
 * the messages thrown below — it looks for the literal `usererrors`, which
 * `bulkOperationRunMutation failed: …` does not contain. So every rejection on this path
 * reached the merchant as `UNKNOWN`: *"Something went wrong on our side."* The truth was
 * in hand and specific, and it was thrown away one layer later.
 *
 * It matters more here than anywhere else because `selectWritePath` sends a campaign
 * down this path once it is large enough. This is the failure mode of exactly the
 * merchants the app is pitched at, and of the runs too big to eyeball afterwards.
 *
 * Carrying its own `userMessage` rather than borrowing `SHOPIFY_REJECTED`'s is
 * deliberate: the shared one says *"the ledger below shows exactly which variants were
 * affected"*, and on a refused submission there is no ledger, because nothing was
 * submitted. Each site below writes the object, the cause and the next action, per the
 * error taxonomy in RFC §11.
 */
export class BulkSubmissionError extends AppError {
  constructor(userMessage: string, detail: string) {
    super({
      code: "SHOPIFY_REJECTED",
      userMessage,
      // Not retryable by the worker. Shopify refused the request as posed; sending it
      // again unchanged gets the same answer, and a merchant re-running deliberately is
      // a different thing from a worker looping on it.
      retryable: false,
      context: { stage: "bulk-submission", detail: detail.slice(0, 500) },
    });
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
    // Not a `BulkSubmissionError`, and not a sentence any merchant should ever read:
    // Shopify has not refused anything here, because nothing has been sent. It is
    // unreachable through the normal path — `selectWritePath(0)` returns `sync`, so a
    // run with nothing to write never chooses bulk — which leaves `forcePath: "bulk"`,
    // used by tests and diagnostics. That is a caller bug, and `UNKNOWN` ("something
    // went wrong on our side") is the honest classification for one.
    throw new Error(
      "submitBulkMutation was called with no writable rows. selectWritePath sends an " +
        "empty run down the sync path, so this means a caller forced the bulk path.",
    );
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
    const reason = stagedErrors.map((e) => e.message).join("; ");
    throw new BulkSubmissionError(
      `Shopify refused to start the bulk price update for this campaign: ${reason}. ` +
        "No prices were changed. Run the campaign again once that is resolved.",
      `stagedUploadsCreate failed: ${reason}`,
    );
  }

  const target = staged.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target) {
    throw new BulkSubmissionError(
      "Shopify accepted the request to start the bulk price update but returned nowhere " +
        "to upload it to, so nothing was submitted. No prices were changed. Run the " +
        "campaign again.",
      "stagedUploadsCreate returned no target.",
    );
  }

  await upload(target, body);

  // The staged path is carried in the `key` parameter of the upload target.
  const key = target.parameters.find((p) => p.name === "key")?.value;
  if (!key) {
    throw new BulkSubmissionError(
      "Shopify's upload location for this bulk price update arrived incomplete, so " +
        "nothing was submitted. No prices were changed. Run the campaign again.",
      "Staged target has no `key` parameter.",
    );
  }

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
    const reason = submitErrors.map((e) => e.message).join("; ");
    throw new BulkSubmissionError(
      `Shopify rejected the bulk price update for this campaign: ${reason}. ` +
        "No prices were changed. Run the campaign again once that is resolved.",
      `bulkOperationRunMutation failed: ${reason}`,
    );
  }

  const operation = submitted.data?.bulkOperationRunMutation?.bulkOperation;
  if (!operation) {
    throw new BulkSubmissionError(
      "Shopify accepted the bulk price update but did not report an operation to " +
        "follow, so this run cannot be tracked. No prices were changed. Run the " +
        "campaign again.",
      "Submission returned no bulkOperation.",
    );
  }

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
