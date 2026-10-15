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
 *   a poll of the operation, by its id, once the expected duration has elapsed.
 *
 * Community reports document missed `finish` deliveries. Without the fallback a
 * missed webhook means a run that never completes and a merchant watching a progress
 * bar that never moves (edge case E13).
 *
 * ## More than one at a time (#1054)
 *
 * Shopify limits how many bulk mutations one app runs in one shop at once. For the API
 * version this app pins (2026-07) the limit is five: "In API versions 2026-01 and higher,
 * each app can run up to five bulk mutation operations concurrently per shop"; before
 * 2026-01 it was one of each type
 * (https://shopify.dev/docs/api/usage/bulk-operations/imports#manage-concurrent-operations).
 * Two campaigns going down this path at once -- two sales starting together, an apply
 * beside another campaign's revert -- is therefore ordinary, and two things follow.
 *
 * **Each run follows its own operation, by id** (`bulkOperation(id:)`, added in 2026-01).
 * It used to poll `currentBulkOperation(type: MUTATION)`, which answers with the app's
 * *most recent* operation and is deprecated in 2026-07. With two running, the older run
 * read the newer one's status and result file, and settled its own rows against somebody
 * else's prices.
 *
 * **A submission past the limit waits for a turn.** Shopify answers it with a user error
 * and runs nothing. The schema's `BulkMutationErrorCode` has two codes for it, and the docs
 * do not say which the five-at-once limit returns: `LIMIT_REACHED` ("Bulk operations limit
 * reached. Please try again later.") and `OPERATION_IN_PROGRESS` ("The operation did not
 * run because another bulk mutation is already running.", the one-at-a-time wording). Either
 * is read as "not yet". Asking again is the one read of the live state that cannot race: a
 * slot seen free by a list query can be taken before the submission that follows it.
 */

import { AppError } from "../errors/app-error";
import type { PlannedRow } from "../planning/types";
import { isThrottledError, withRetry } from "../shopify/budget";
import type { AnchorBulkOperationByIdQuery, AnchorBulkOperationRunMutationMutation } from "../../types/admin.generated";
import type { AdminClient } from "./sync-executor";
import { buildMutationLines, layoutOf, parseResults, serializeJsonl, streamLines } from "./jsonl";
import type { LineLayout, VariantOutcome } from "./jsonl";

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED";

/** Between polls of an operation, and between asks for a turn (#1054). */
export const BULK_POLL_INTERVAL_MS = 5_000;

/**
 * How long a run waits on Shopify before it stops: for its operation to finish (#832), or
 * for a turn to submit one (#1054). Each wait gets the whole of it.
 */
export const BULK_WAIT_MS = 30 * 60_000;

/** The refusals that mean "the app is running as many bulk mutations here as it may" (#1054). */
const NO_TURN_YET: ReadonlySet<string> = new Set(["LIMIT_REACHED", "OPERATION_IN_PROGRESS"]);

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
      userErrors { field message code }
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
  /**
   * Called each time Shopify refuses the submission because the app already runs as many
   * bulk mutations in this shop as it may (#1054), with Shopify's reason. Given, the
   * submission waits `intervalMs` and asks again, the same upload, until `waitMs` has
   * passed since the first refusal. Absent, that refusal is thrown like any other.
   */
  onBusy?: (reason: string) => Promise<void>;
  intervalMs?: number;
  waitMs?: number;
  now?: () => number;
}

/** An operation Shopify accepted, and what each line of its upload carried. */
export interface BulkSubmission {
  operation: BulkOperationState;
  /**
   * The upload's lines, as variant ids: what its result file is read against (#985).
   * Returned rather than rebuilt from the rows, so the results are matched against the
   * lines that were sent and not against a second build that has to agree with them.
   */
  layout: string[][];
}

/** Builds the payload, stages it, uploads it and submits the operation. */
export async function submitBulkMutation(
  rows: Iterable<PlannedRow>,
  options: SubmitOptions,
): Promise<BulkSubmission> {
  const {
    client,
    upload,
    productOf,
    sleep,
    maxAttempts = 5,
    onBusy,
    intervalMs = BULK_POLL_INTERVAL_MS,
    waitMs = BULK_WAIT_MS,
    now = () => Date.now(),
  } = options;

  const lines = [...buildMutationLines(rows, productOf)];
  const body = [...serializeJsonl(lines)].join("");
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

  // Asked again while Shopify says the app has no turn (#1054), with the same upload: the
  // refusal ran nothing, so there is nothing to undo and nothing to send twice.
  let firstRefused: number | undefined;
  let payload: AnchorBulkOperationRunMutationMutation["bulkOperationRunMutation"];
  for (;;) {
    const submitted = await withRetry(
      () =>
        client.request<AnchorBulkOperationRunMutationMutation>(BULK_OPERATION_RUN_MUTATION, {
          mutation: options.mutation ?? DEFAULT_BULK_MUTATION,
          stagedUploadPath: key,
        }),
      isThrottledError,
      { maxAttempts, sleep },
    );
    payload = submitted.data?.bulkOperationRunMutation;

    const submitErrors = payload?.userErrors ?? [];
    if (submitErrors.length === 0) break;
    const reason = submitErrors.map((e) => e.message).join("; ");

    if (onBusy && submitErrors.every((e) => NO_TURN_YET.has(String(e.code ?? "")))) {
      firstRefused ??= now();
      const waited = now() - firstRefused;
      if (waited < waitMs) {
        await onBusy(reason);
        await (sleep ?? realSleep)(intervalMs);
        continue;
      }
      throw new BulkSubmissionError(
        "Shopify was still running other bulk price updates for this store after this campaign had waited " +
          `${waited < 60_000 ? "under a minute" : `${Math.round(waited / 60_000)} minutes`} for its turn, so none ` +
          "of its prices were sent. No prices were changed. Run the campaign again once they have finished.",
        `bulkOperationRunMutation refused for ${waited} ms: ${reason}`,
      );
    }

    throw new BulkSubmissionError(
      `Shopify rejected the bulk price update for this campaign: ${reason}. ` +
        "No prices were changed. Run the campaign again once that is resolved.",
      `bulkOperationRunMutation failed: ${reason}`,
    );
  }

  const operation = payload?.bulkOperation as BulkOperationState | null | undefined;
  if (!operation) {
    throw new BulkSubmissionError(
      "Shopify accepted the bulk price update but did not report an operation to " +
        "follow, so this run cannot be tracked. No prices were changed. Run the " +
        "campaign again.",
      "Submission returned no bulkOperation.",
    );
  }

  return { operation, layout: layoutOf(lines) };
}

/** Each line's rows stand or fall on their own, as on the sync path (#1020, D14). */
export const DEFAULT_BULK_MUTATION = `
  mutation call($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: true) {
      product { updatedAt }
      productVariants { id price compareAtPrice }
      userErrors { field message code }
    }
  }
`;

/**
 * One operation by id: how a run follows its own (#1054), and how a resume learns how a
 * run's operation ended (#832). `bulkOperation(id:)` is the lookup the 2026-01 docs give for
 * exactly this; it used to be `node(id:)`, which answers the same.
 */
export const BULK_OPERATION_BY_ID = `#graphql
  query AnchorBulkOperationById($id: ID!) {
    bulkOperation(id: $id) { id status url partialDataUrl objectCount errorCode }
  }
`;

/** That operation's state, or null when Shopify no longer knows it (it expires after a week). */
export async function bulkOperationById(
  client: AdminClient,
  id: string,
  retry: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<BulkOperationState | null> {
  const response = await withRetry(
    () => client.request<AnchorBulkOperationByIdQuery>(BULK_OPERATION_BY_ID, { id }),
    isThrottledError,
    retry,
  );
  return (response.data?.bulkOperation as BulkOperationState | null | undefined) ?? null;
}

/** Terminal states: no further polling will change the outcome. */
export function isTerminal(status: BulkOperationStatus): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELED" || status === "EXPIRED";
}

export interface PollOptions {
  client: AdminClient;
  /**
   * The operation to follow: the one this run submitted, never "the app's most recent"
   * (#1054). Another campaign's may be newer.
   */
  id: string;
  /** Time between polls. */
  intervalMs?: number;
  /** Give up after this long and report, rather than polling forever. */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  /** Called with each answer, so a caller can record how far Shopify has got (#832). */
  onPoll?: (state: BulkOperationState) => void | Promise<void>;
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
    id,
    intervalMs = BULK_POLL_INTERVAL_MS,
    timeoutMs = BULK_WAIT_MS,
    now = () => Date.now(),
    sleep = realSleep,
    maxAttempts = 5,
    onPoll,
  } = options;

  const deadline = now() + timeoutMs;
  let last: BulkOperationState | undefined;

  for (;;) {
    last = (await bulkOperationById(client, id, { maxAttempts, sleep })) ?? last;
    if (last) await onPoll?.(last);
    if (last && isTerminal(last.status)) return last;
    if (now() >= deadline) return last;

    await sleep(intervalMs);
  }
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 *
 * `layout` is the submission's: with it, each result line's errors land on the variants
 * that line sent (#985). See `parseResults` for a reconcile without it.
 */
export async function reconcileResults(
  operation: BulkOperationState,
  submittedVariantGids: Iterable<string>,
  fetchResults: ResultFetcher,
  layout?: LineLayout,
): Promise<ReconcileResult> {
  const outcomes = new Map<string, VariantOutcome>();
  const malformedLines: Array<{ malformed: string; reason: string }> = [];

  const url = operation.url ?? operation.partialDataUrl ?? undefined;

  if (url) {
    for await (const item of parseResults(streamLines(fetchResults(url)), layout)) {
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
