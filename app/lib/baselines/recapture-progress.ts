/**
 * A recapture from the recapture page, as the page following it says it (#1105).
 *
 * A recapture whose wholesale prices need more quantity-ladder reads than the page can wait
 * on runs in the worker, and its row says which step it is on and how far that step has got,
 * as the shop row does for a catalogue sync (#801). This reads that row into what the page
 * shows: the step and its count while it runs, the sentence the page used to answer with once
 * it finishes, and why it stopped when it did not -- a row that has gone quiet included, so a
 * worker that died mid-recapture never leaves the page saying "running" for good.
 *
 * Pure, and not in a `.server` module, so it is tested on its own and the page's component
 * can name its types.
 */

import { countOf, formatCount } from "../format/display";
import { recapturedMessage } from "./recapture";

export type RecapturePhase = "queued" | "checking" | "ladders" | "baselines";

/** Each step, as the page names it. */
export const RECAPTURE_PHASE_TEXT: Record<RecapturePhase, string> = {
  queued: "Waiting for the background worker",
  checking: "Checking the scope again",
  ladders: "Reading wholesale quantity breaks from Shopify",
  baselines: "Recording baselines",
};

/**
 * How long a recapture may go without a sign of life before it is treated as stopped: a
 * sync's ten minutes (`SYNC_STALE_AFTER_MS`). The worker stamps it every thirty seconds
 * whatever it is doing, so ten minutes of silence is a process that is gone.
 */
export const RECAPTURE_STALE_AFTER_MS = 10 * 60_000;

export interface RecaptureProgress {
  done: number;
  total: number;
}

/** What the page needs of a recapture's row. */
export interface RecaptureRow {
  id: string;
  scope: number;
  phase: string;
  progress: unknown;
  heartbeatAt: Date;
  finishedAt: Date | null;
  outcome: unknown;
  failure: string | null;
}

/** A recapture as the page shows it. */
export interface RecaptureState {
  id: string;
  /** Variants it covers, as the page counted them when the merchant confirmed it. */
  scope: number;
  running: boolean;
  phase: RecapturePhase | null;
  /** While it runs: one sentence saying what it is doing and how far it has got. */
  text: string | null;
  /** Once it finished: what it did, in the sentence an inline recapture answers with. */
  outcome: string | null;
  /** Finished with wholesale prices left as they were, which the page shows as a warning. */
  partial: boolean;
  /** Once it stopped or was refused: why, and what to do next. */
  failure: string | null;
}

/** What the outcome column holds: `CaptureResult` and the scope. Counts only. */
export interface RecaptureOutcome {
  scope: number;
  captured: number;
  superseded: number;
  alreadyCurrent: number;
  wholesale: number;
  wholesaleLeft: number;
}

/** The step and its count: "Reading wholesale quantity breaks from Shopify: 250 of 1,000 prices". */
export function describeRecapture(phase: RecapturePhase, progress: RecaptureProgress | null): string {
  const base = RECAPTURE_PHASE_TEXT[phase];
  if (!progress || progress.done <= 0 || progress.total <= 0) return base;
  const count = `${formatCount(Math.min(progress.done, progress.total))} of ${formatCount(progress.total)}`;
  return phase === "ladders" ? `${base}: ${count} prices` : `${base}: ${count}`;
}

/**
 * What the page says while one runs. It names the scope, because the merchant may have
 * opened the page in another tab and never seen the button that started it.
 */
export function runningSentence(state: RecaptureState): string {
  return (
    `Recapturing ${countOf(state.scope, "variant")} in the background. ${state.text ?? RECAPTURE_PHASE_TEXT.queued}. ` +
    "You can leave this page: the recapture carries on without it, and Replace is offered again once it ends."
  );
}

/**
 * Why a recapture stopped without saying so, from the step it was on. Whether anything was
 * recorded is the step's to say: everything before `baselines` writes nothing.
 */
export function stoppedSentence(phase: RecapturePhase | null): string {
  if (phase === "queued" || phase === null) {
    return (
      "The recapture was never started: the background worker did not pick it up within ten minutes, so nothing " +
      "was recaptured. Check the scope again, then recapture."
    );
  }
  if (phase === "baselines") {
    return (
      "The recapture stopped responding while recording baselines. The ones it recorded before it stopped are " +
      "kept and the rest are as they were. Check the scope again, then recapture to record the rest."
    );
  }
  return (
    `The recapture stopped responding while ${stepInSentence(phase)}, before it recorded ` +
    "anything, so nothing was recaptured. Check the scope again, then recapture."
  );
}

/** A step's name inside a sentence: "while reading wholesale quantity breaks from Shopify". */
export function stepInSentence(phase: RecapturePhase): string {
  const text = RECAPTURE_PHASE_TEXT[phase];
  // The first letter only: the steps name Shopify, which stays capitalised.
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Whether a recapture that has not finished has gone quiet for longer than a live one can. */
export function quiet(row: Pick<RecaptureRow, "heartbeatAt">, now: Date = new Date()): boolean {
  return now.getTime() - row.heartbeatAt.getTime() > RECAPTURE_STALE_AFTER_MS;
}

/**
 * The recapture as of `now`, from its row.
 *
 * One that has not finished but has gone quiet past `RECAPTURE_STALE_AFTER_MS` is not
 * running, whatever its row says: its process stopped without recording it. One finished
 * with neither an outcome nor a failure was closed for the same reason -- by the next
 * recapture's claim, or by the worker that found it too late -- and says so the same way.
 */
export function recaptureStateOf(row: RecaptureRow, now: Date = new Date()): RecaptureState {
  const phase = phaseOf(row.phase);
  const base = { id: row.id, scope: row.scope, phase: null, text: null, outcome: null, partial: false, failure: null };

  if (!row.finishedAt) {
    if (!quiet(row, now)) {
      return { ...base, running: true, phase, text: describeRecapture(phase ?? "queued", progressOf(row.progress)) };
    }
    return { ...base, running: false, failure: stoppedSentence(phase) };
  }

  if (row.failure) return { ...base, running: false, failure: row.failure };
  const outcome = outcomeOf(row.outcome);
  if (outcome) return { ...base, running: false, outcome: recapturedMessage(outcome), partial: outcome.wholesaleLeft > 0 };
  return { ...base, running: false, failure: stoppedSentence(phase) };
}

function phaseOf(value: string): RecapturePhase | null {
  // Its own keys only: `in` would take "toString" for a step.
  return Object.prototype.hasOwnProperty.call(RECAPTURE_PHASE_TEXT, value) ? (value as RecapturePhase) : null;
}

function progressOf(value: unknown): RecaptureProgress | null {
  const progress = value as Partial<RecaptureProgress> | null;
  return progress && typeof progress.done === "number" && typeof progress.total === "number"
    ? { done: progress.done, total: progress.total }
    : null;
}

function outcomeOf(value: unknown): RecaptureOutcome | null {
  const outcome = value as Partial<RecaptureOutcome> | null;
  if (!outcome || typeof outcome.captured !== "number" || typeof outcome.scope !== "number") return null;
  const count = (field: keyof RecaptureOutcome) => (typeof outcome[field] === "number" ? (outcome[field] as number) : 0);
  return {
    scope: outcome.scope,
    captured: outcome.captured,
    superseded: count("superseded"),
    alreadyCurrent: count("alreadyCurrent"),
    wholesale: count("wholesale"),
    wholesaleLeft: count("wholesaleLeft"),
  };
}
