/**
 * The bulk cost form, read one way by the page that shows it and the action that runs it.
 *
 * The form opened with an amount of 4 already in it, and beside "Check without changing"
 * sat a button that committed whatever the form held (#754). On a store of 3,669 variants
 * that was 2,699 costs raised by 4% on one click, with a number the merchant never typed.
 * Costs set the never-below-cost and minimum-margin floors, so that click moved every
 * guardrail in the store — the one store-wide write in the app with no ceremony at all,
 * while recapture asks for a typed phrase and applying a campaign opens a dialog.
 *
 * Two things here close it.
 *
 * **An empty amount is refused, not read as zero.** `Number("")` is 0, so an empty field
 * under "Set an exact cost" would have set every cost in scope to nothing: a floor of zero
 * under every product, which is the guardrail switched off rather than tightened.
 *
 * **A commit names the check it follows.** The dry run hands back a key for exactly the
 * rule and scope it counted, and the commit posts that key back with the count the
 * merchant was shown. The action refuses a commit whose form no longer produces the key,
 * and the page keeps the button disabled on the same comparison — one function, so the
 * page and the server cannot disagree about what "the same values" means.
 *
 * The key is built from the *rule*, not from the text in the fields. "4" and "4.0" are one
 * check; "4" on a yen shop and "4" on a dollar shop are not, because they store different
 * minor units, and what is being confirmed is what will be stored.
 */

import { formatCount } from "../format/display";
import { costRuleFrom, describeCostRule, type CostRule } from "./cost-rules";

/** Anything a form's values can be read from: `FormData` on both sides. */
export interface CostFormFields {
  get(name: string): FormDataEntryValue | null;
}

export type CostFormRead =
  | { ok: true; vendor: string; rule: CostRule; key: string }
  /** Which field to mark, and the sentence to mark it with. */
  | { ok: false; field: "value"; message: string };

/**
 * The rule and scope the form describes, or why it describes none.
 *
 * Refuses for both buttons, not only the one that writes. A check of an empty amount
 * would report "0 of 3,669 would change" — true, and an invitation to believe the form
 * is filled in.
 */
export function readCostForm(fields: CostFormFields, currency: string): CostFormRead {
  const vendor = String(fields.get("vendor") ?? "").trim();
  const kind = String(fields.get("ruleKind") ?? "percent-change");
  const typed = String(fields.get("value") ?? "").trim();

  if (typed === "") {
    return {
      ok: false,
      field: "value",
      message: `The amount is empty, so nothing was checked or changed. Type a percentage, or an amount in ${currency}, then check it.`,
    };
  }

  const amount = Number(typed);
  if (!Number.isFinite(amount)) {
    return {
      ok: false,
      field: "value",
      message: `“${typed}” is not a number, so nothing was checked or changed. Type a percentage, or an amount in ${currency}, then check it.`,
    };
  }

  const rule = costRuleFrom(kind, amount, currency);
  return { ok: true, vendor, rule, key: checkKeyOf(vendor, rule) };
}

/**
 * What a check was of: the scope and the rule as it will be stored.
 *
 * JSON of objects `costRuleFrom` builds in a fixed shape, so the same rule always spells
 * the same key. Opaque to the page, which only ever compares two of them.
 */
export function checkKeyOf(vendor: string, rule: CostRule): string {
  return JSON.stringify({ vendor, rule });
}

export type CommitRead = { ok: true; expected: number } | { ok: false; message: string };

/**
 * Whether a commit follows a check of the values it is committing.
 *
 * `checked` is the key the dry run returned and `expected` the count the confirmation
 * named. Either missing means a request this page did not build — a stray submit, or a
 * form somebody edited — and that is refused rather than written, the same rule
 * recapture applies to a scope nobody looked at (#716).
 */
export function readCommit(key: string, fields: CostFormFields): CommitRead {
  const checked = String(fields.get("checked") ?? "");
  const expected = String(fields.get("expected") ?? "");

  if (checked === "" || !/^\d+$/.test(expected)) {
    return {
      ok: false,
      message:
        "Nothing was changed: these costs have not been checked. Press Check without changing, read how many would change, then change them.",
    };
  }

  if (checked !== key) {
    return {
      ok: false,
      message:
        "Nothing was changed: the form no longer matches what was checked. Press Check without changing again, read the new count, then change them.",
    };
  }

  return { ok: true, expected: Number(expected) };
}

/** "Every product", or the vendor the form narrowed it to — for the confirmation. */
export function costScopeOf(vendor: string): string {
  return vendor ? `Products from ${vendor}` : "Every product";
}

/** "2,699 costs" — grouped, because a count this size is read at a glance or misread. */
export function costCount(count: number): string {
  return `${formatCount(count)} ${count === 1 ? "cost" : "costs"}`;
}

/** What the check found, in the sentence the banner shows. Nothing has been written. */
export function checkedMessage(rule: CostRule, counts: { changed: number; matched: number }): string {
  return `${describeCostRule(rule)}: ${formatCount(counts.changed)} of ${formatCount(counts.matched)} would change. Nothing has been written.`;
}

/** What the commit did. */
export function changedMessage(changed: number): string {
  return `${costCount(changed)} updated.`;
}

/**
 * Why a commit found a different count from the one the merchant confirmed.
 *
 * The catalogue moved between the check and the click — a sync, an import, another tab.
 * The merchant agreed to a number, and writing a different one is not what they agreed
 * to, so nothing is written and they are told both.
 */
export function countMovedMessage(changed: number, expected: number): string {
  return (
    `${costCount(changed)} would change now, not the ${formatCount(expected)} you were shown, so nothing was changed. ` +
    "Check again and read the new count before changing them."
  );
}
