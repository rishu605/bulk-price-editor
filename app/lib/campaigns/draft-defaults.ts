/**
 * What the campaign editor's form says before a merchant touches it.
 *
 * These used to live only in the JSX, spelled out as literals next to the fields that
 * rendered them. That is fine while one thing reads the form — its own submit — and it
 * stops being fine the moment anything has to know what an untouched form would say
 * without a form in front of it.
 *
 * One object, imported by the fields that render the defaults. `draft-defaults.test.ts`
 * checks the editor still renders these rather than literals of its own, which is the
 * property worth keeping: a "-20" written out beside the field is a value that can drift
 * from every other statement of what this form does.
 */
export const DRAFT_DEFAULTS = {
  /** Percent change, which is what nearly every campaign is. */
  ruleKind: "percent-change",
  /** Negative discounts: -20 is 20% off the baseline. */
  percentValue: "-20",
  /** The money equivalent, used by the two rules that take an amount. */
  fixedValue: "-10",
  /* The same two defaults said the way the editor now asks for them: a direction and a
     positive magnitude. The signed pair above is still what `draftDefaultParams` sends,
     what quick create on Home posts, and what a bookmarked URL carries, and
     `draft-form.ts` explains why both spellings have to keep working. */
  /** Which way a change goes, when the form asks rather than relying on a minus sign. */
  direction: "down",
  /** 20% off, as the merchant says it. */
  percentMagnitude: "20",
  /** The money equivalent of the same. */
  fixedMagnitude: "10",
  /** A strike-through by default: a sale that does not look like one converts worse. */
  compareAt: "set-to-baseline",
  /** Only matters once two campaigns overlap. */
  priority: "100",
} as const;

/**
 * The defaults as form fields — what the editor posts if a merchant submits it untouched.
 *
 * Nothing in the app builds this: the preview is asked for by the client, which posts the
 * real form. It exists so the tests that matter can be written against a value rather
 * than against a hand-typed copy of one — that both readings of the fields agree, and
 * that the unedited form prices as a percent discount off the baseline.
 *
 * Rounding is deliberately absent: it comes from the shop's own setting, and a default
 * here would describe a rounding rule the merchant never chose.
 */
export function draftDefaultParams(): URLSearchParams {
  return new URLSearchParams({
    ruleKind: DRAFT_DEFAULTS.ruleKind,
    ruleValue: DRAFT_DEFAULTS.percentValue,
    compareAt: DRAFT_DEFAULTS.compareAt,
    priority: DRAFT_DEFAULTS.priority,
  });
}
