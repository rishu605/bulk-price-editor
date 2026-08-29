/**
 * What the campaign editor's form says before a merchant touches it.
 *
 * These used to live only in the JSX, which was fine while the only thing that read the
 * form was the form's own submit. It stopped being fine when the loader started pricing
 * the draft server-side so the preview is populated on first paint: the loader has no
 * form to read, so it has to know what the unedited form would have said, and a second
 * copy of "-20" is a preview that disagrees with the editor it previews.
 *
 * One object, imported by the fields that render the defaults and by the loader that
 * prices them. `draft-defaults.test.ts` checks the editor still renders these rather
 * than literals of its own.
 */
export const DRAFT_DEFAULTS = {
  /** Percent change, which is what nearly every campaign is. */
  ruleKind: "percent-change",
  /** Negative discounts: -20 is 20% off the baseline. */
  percentValue: "-20",
  /** The money equivalent, used by the two rules that take an amount. */
  fixedValue: "-10",
  /** A strike-through by default: a sale that does not look like one converts worse. */
  compareAt: "set-to-baseline",
  /** Only matters once two campaigns overlap. */
  priority: "100",
} as const;

/**
 * The defaults as form fields, for the loader's first-paint preview.
 *
 * Rounding is deliberately absent: it comes from the shop's own setting, and seeding a
 * default here would preview a rounding rule the merchant never chose.
 */
export function draftDefaultParams(): URLSearchParams {
  return new URLSearchParams({
    ruleKind: DRAFT_DEFAULTS.ruleKind,
    ruleValue: DRAFT_DEFAULTS.percentValue,
    compareAt: DRAFT_DEFAULTS.compareAt,
    priority: DRAFT_DEFAULTS.priority,
  });
}
