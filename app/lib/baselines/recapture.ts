/**
 * Deciding whether a recapture is safe to run.
 *
 * Recapture replaces every baseline in its scope with today's live price. Run it while a
 * sale is live and the sale prices *become* the merchant's normal prices — permanently,
 * for every campaign from then on, with the real prices gone from the current row and
 * recoverable only by reading superseded history. There is no undo button that makes
 * that not have happened.
 *
 * So the rules here are deliberately harder than "are you sure":
 *
 *   Overlap with a running campaign is named, per campaign, with how many variants each
 *   one covers. "This will affect 412 products in Summer Sale" is a fact somebody can
 *   act on; "some campaigns may be affected" is a dialog people click through.
 *
 *   Confirmation is typed, and typed exactly. A button is muscle memory by the third
 *   time; typing the word is not.
 */

import { countOf, formatCount } from "../format/display";

export interface ActiveOverlap {
  campaignId: string;
  campaignName: string;
  /** Variants in the recapture scope that this campaign is currently pricing. */
  variants: number;
}

export type RecaptureRisk = "safe" | "overlaps-active-campaign";

export interface RecaptureAssessment {
  risk: RecaptureRisk;
  /** Variants the recapture would rewrite. */
  scope: number;
  overlaps: ActiveOverlap[];
  /** The exact word the merchant must type. Absent when nothing is at risk. */
  confirmationPhrase: string | null;
  /** What to tell them, in their terms. */
  warning: string | null;
}

/** What a merchant must type to recapture over a live campaign. */
export const DANGEROUS_PHRASE = "REPLACE BASELINES";

export function assessRecapture(scope: number, overlaps: readonly ActiveOverlap[]): RecaptureAssessment {
  const affected = overlaps.filter((overlap) => overlap.variants > 0);

  if (affected.length === 0) {
    return {
      risk: "safe",
      scope,
      overlaps: [],
      // No phrase for the safe case. Demanding one every time is how a merchant learns
      // to type it without reading, and then types it on the day it mattered.
      confirmationPhrase: null,
      warning: null,
    };
  }

  const total = affected.reduce((sum, overlap) => sum + overlap.variants, 0);
  const names = affected.map((overlap) => `"${overlap.campaignName}" (${formatCount(overlap.variants)})`);

  return {
    risk: "overlaps-active-campaign",
    scope,
    overlaps: affected,
    confirmationPhrase: DANGEROUS_PHRASE,
    warning:
      `${formatCount(total)} of these ${formatCount(scope)} variants ${total === 1 ? "is" : "are"} on sale right now under ` +
      `${names.join(", ")}. Recapturing would make the sale price their new normal ` +
      `price, permanently — every future campaign would compute its discount from the ` +
      `discounted price. Revert those campaigns first unless that is genuinely what you ` +
      `want.`,
  };
}

/** The scope's size, under the Scope field: "3,669 variants in scope." (#759). */
export function scopeSentence(scope: number): string {
  return `${countOf(scope, "variant")} in scope.`;
}

/** The button, with the count it replaces: "Replace 3,669 baselines" (#759). */
export function replaceLabel(scope: number): string {
  return `Replace ${countOf(scope, "baseline")}`;
}

/** What a recapture did, in grouped counts that agree with one (#759). */
export function recapturedMessage(result: {
  captured: number;
  scope: number;
  superseded: number;
  alreadyCurrent: number;
}): string {
  return (
    `Recaptured ${countOf(result.captured, "baseline")} across ${countOf(result.scope, "variant")}` +
    (result.superseded > 0 ? `, superseding ${formatCount(result.superseded)}` : "") +
    (result.alreadyCurrent > 0
      ? `. ${formatCount(result.alreadyCurrent)} ${result.alreadyCurrent === 1 ? "was" : "were"} already correct`
      : "") +
    "."
  );
}

/**
 * Whether the typed confirmation matches.
 *
 * Trimmed and case-folded, because the requirement is that the merchant read the
 * sentence and type the words — not that they reproduce capitalisation. Being strict
 * about the case turns a safety check into a puzzle, and a puzzle gets copy-pasted.
 */
export function confirmationMatches(typed: string, expected: string | null): boolean {
  if (!expected) return true;
  return typed.trim().toLowerCase() === expected.trim().toLowerCase();
}
