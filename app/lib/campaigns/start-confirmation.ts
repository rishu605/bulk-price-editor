/**
 * The typed confirmation for a start nobody is watching (#1009).
 *
 * A-3.11 asks for "apply" to be typed before a campaign over the store's thresholds runs
 * (#818), and only the Apply button asked. A scheduled campaign is started by the scheduler,
 * and a Flow-started one by the Flow action. Neither can ask anybody anything, so a scheduled
 * 95%-off sale, or an exact price on the wrong collection, started unconfirmed at exactly the
 * moment nobody was looking.
 *
 * So the word is asked when the start is decided instead: when dates are saved, in the editor
 * or on the campaign page, or when the campaign is confirmed for Flow on its page. What was
 * confirmed is kept with the campaign: who, when, and how far the campaign reached then. The
 * start checks the campaign as it is at that moment against it. A start that reaches further
 * than the person saw is refused, saying what grew.
 *
 * Pure, and the one place "covered by the confirmation" is decided, so the save that asks and
 * the start that refuses cannot disagree (rule 4).
 */

import { describeActor } from "../audit/actor";
import { formatCount } from "../format/display";
import {
  asksForConfirmation,
  confirmationReasons,
  MINIMUM_PRICE_HANDFUL,
  percentText,
  type BlastRadius,
} from "./blast-radius";

/**
 * Where the confirmation is kept, in the campaign's `schedule` JSON.
 *
 * Not part of the window: it is about what the campaign writes, which moving its dates does
 * not change, and every start is checked against it anyway. It is the campaign's own record
 * (`OWN_KEYS` in `own-record.ts`), which an unschedule and new dates keep and a copy leaves
 * behind: the person confirmed that campaign, not the copy.
 */
export const START_CONFIRMED_KEY = "startConfirmed";

/** A confirmation as stored: who typed the word, when, and what the campaign reached then. */
export interface StartConfirmation {
  /** The actor, as the audit log records one. */
  by: string;
  /** An ISO instant. */
  at: string;
  /** Prices it wrote. */
  planned: number;
  /** Of those, how many moved further than the change threshold. */
  largeChanges: number;
  /** How far the largest of them moved, in hundredths of a percent; 0 when none did. */
  largestBasisPoints: number;
  /** Prices taken to zero or below and written at the smallest price. */
  atMinimum: number;
  /**
   * Prices it would discount again from a baseline recaptured at its own sale price (#781).
   * Absent from a confirmation stored before it was counted, which covered none.
   */
  compounding?: number;
}

/** What a person confirms by typing the word over this preview. */
export function confirmationOf(radius: BlastRadius, by: string, at: Date): StartConfirmation {
  return {
    by,
    at: at.toISOString(),
    planned: radius.planned,
    largeChanges: radius.largeChanges,
    largestBasisPoints: radius.largest?.basisPoints ?? 0,
    atMinimum: radius.atMinimum,
    // Only where there is some, as a confirmation stored before it was counted reads.
    ...(radius.compounding ? { compounding: radius.compounding.count } : {}),
  };
}

/** The schedule blob with this confirmation recorded, replacing any earlier one. */
export function withStartConfirmed(schedule: unknown, confirmation: StartConfirmation): Record<string, unknown> {
  return { ...((schedule ?? {}) as Record<string, unknown>), [START_CONFIRMED_KEY]: confirmation };
}

/** The confirmation stored with a campaign, or null when there is none or it is unreadable. */
export function startConfirmationOf(schedule: unknown): StartConfirmation | null {
  const stored = ((schedule ?? {}) as Record<string, unknown>)[START_CONFIRMED_KEY] as Partial<StartConfirmation> | undefined;
  if (!stored || typeof stored.by !== "string" || typeof stored.at !== "string") return null;
  const counts = [stored.planned, stored.largeChanges, stored.largestBasisPoints, stored.atMinimum];
  if (!counts.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  return stored as StartConfirmation;
}

/**
 * Whether a count is still within what was confirmed: no more than a tenth over it.
 *
 * A start can come days after its confirmation, and a scope gains products in that time. A
 * sale on a collection confirmed at 1,200 prices that meets 1,212 at midnight is the sale the
 * merchant confirmed, and refusing it would leave a planned sale unstarted over a product
 * nobody thinks of as a change. A tenth is far short of the mistakes the word is for: a scope
 * widened to the whole catalogue, or a rule with a digit too many, reaches many times further.
 * Under ten there is no slack at all (integer division): a small, deep campaign is the one the
 * confirmation exists for, and one more product at 95% off is worth asking about.
 */
export function withinCount(now: number, confirmed: number): boolean {
  return now <= confirmed + Math.floor(confirmed / 10);
}

/**
 * How much further than confirmed the largest change may move: one percentage point.
 *
 * Rounding puts a new product's price a fraction away from the rule's percentage, so a 60%
 * sale confirmed at 60.0% meets 60.4% on a product added since. That is not a new decision. A
 * rule changed from 9.5% to 95%, or from 40% to 60%, is.
 */
export const DEPTH_ALLOWANCE_BASIS_POINTS = 100;

/** "1 price" / "3 prices". */
function prices(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "price" : "prices"}`;
}

/** Each way this preview reaches further than the confirmation, as a clause; empty when it does not. */
export function beyondConfirmation(radius: BlastRadius, confirmed: StartConfirmation): string[] {
  const grown: string[] = [];

  if (!withinCount(radius.planned, confirmed.planned)) {
    grown.push(`it now writes ${prices(radius.planned)}, and ${formatCount(confirmed.planned)} were confirmed`);
  }
  if (radius.largeChanges > 0 && !withinCount(radius.largeChanges, confirmed.largeChanges)) {
    grown.push(
      `${prices(radius.largeChanges)} now move more than ${radius.thresholds.changePercent}% from their baseline ` +
        `or land that far below cost, and ${formatCount(confirmed.largeChanges)} did when it was confirmed`,
    );
  }
  if (radius.largest && radius.largest.basisPoints > confirmed.largestBasisPoints + DEPTH_ALLOWANCE_BASIS_POINTS) {
    grown.push(
      `its largest change is now “${radius.largest.title}”, ${radius.largest.direction} ${percentText(radius.largest.basisPoints)}, ` +
        (confirmed.largestBasisPoints > 0
          ? `and the largest confirmed was ${percentText(confirmed.largestBasisPoints)}`
          : "and no price moved that far when it was confirmed"),
    );
  }
  // No slack at all: each one is a sale price discounted again, which nobody confirmed (#781).
  const compounding = radius.compounding?.count ?? 0;
  if (compounding > (confirmed.compounding ?? 0)) {
    grown.push(
      `${prices(compounding)} it already set would now be discounted again, from a baseline recaptured at its sale price, ` +
        `and ${formatCount(confirmed.compounding ?? 0)} ${(confirmed.compounding ?? 0) === 1 ? "was" : "were"} confirmed`,
    );
  }
  if (radius.atMinimum > MINIMUM_PRICE_HANDFUL && !withinCount(radius.atMinimum, confirmed.atMinimum)) {
    grown.push(
      `${prices(radius.atMinimum)} would now reach zero or below, and ${formatCount(confirmed.atMinimum)} were confirmed`,
    );
  }

  return grown;
}

/**
 * Why this campaign cannot start without somebody typing the word now, or null when it can.
 *
 * Null when the preview does not ask for the word at all, or when the confirmation stored
 * with the campaign covers it. Otherwise the reasons: the dialog's own sentences for a
 * campaign nobody confirmed, or what grew since the confirmation. No prices, only counts,
 * percentages and a product's title, like the dialog's reasons (#818): this is stored on the
 * campaign, emailed and logged.
 */
export function unconfirmedStart(radius: BlastRadius, confirmed: StartConfirmation | null): string | null {
  if (!asksForConfirmation(radius)) return null;
  if (!confirmed) return `${confirmationReasons(radius).join(" ")} Nobody has confirmed it by typing “apply”.`;

  const grown = beyondConfirmation(radius, confirmed);
  if (grown.length === 0) return null;
  return `It reaches further than ${describeActor(confirmed.by)} confirmed: ${grown.join("; ")}.`;
}

/** What a confirmation covered, for saying so: "1,204 prices; 8 past the change threshold, the largest 95%". */
export function confirmedReach(confirmed: StartConfirmation): string {
  const parts = [prices(confirmed.planned)];
  if (confirmed.largeChanges > 0) {
    parts.push(`${formatCount(confirmed.largeChanges)} past the change threshold, the largest ${percentText(confirmed.largestBasisPoints)}`);
  }
  if (confirmed.atMinimum > 0) parts.push(`${prices(confirmed.atMinimum)} at the smallest price`);
  return parts.join("; ");
}

/**
 * What the campaign page says about its scheduled and Flow starts: the confirmation on record,
 * named and dated for reading, and why the current preview is not covered by it, if it is not.
 * From the page's own preview, so the box it shows is the one the server asks with.
 */
export function startConfirmationView(
  schedule: unknown,
  radius: BlastRadius | null | undefined,
  formatAt: (iso: string) => string,
): { confirmed: { by: string; at: string; reach: string } | null; unconfirmed: string | null } {
  const confirmed = startConfirmationOf(schedule);
  return {
    confirmed: confirmed ? { by: describeActor(confirmed.by), at: formatAt(confirmed.at), reach: confirmedReach(confirmed) } : null,
    unconfirmed: radius ? unconfirmedStart(radius, confirmed) : null,
  };
}
