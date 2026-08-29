import type { Tone } from "./tone";

/**
 * A row's state, badged only when it is worth looking at.
 *
 * ## The rule
 *
 * Colour spent on the normal case is colour that carries no information. A campaign's
 * ledger after a clean run is sixty rows all reading "Verified", and badging every one of
 * them produces a screenful of green pills, each drawing the eye to a variant that needs
 * nothing — while the one row that failed competes with fifty-nine that did not.
 *
 * The catalogue page argued this out first and fixed itself: `At baseline` is subdued
 * text, `No baseline` and `Not at baseline` are badges. Four other tables kept the old
 * shape, so this is that decision made once rather than a fifth time.
 *
 * **Subdued text, not a neutral badge.** This is the part that is easy to get wrong. A
 * badge is a shape as well as a colour, so recolouring forty green pills grey leaves
 * forty things that still look like forty things to look at. Removing the pill is the
 * de-emphasis that works.
 *
 * ## Why this does not break `colour-signal.test.ts`
 *
 * WCAG 1.4.1 forbids carrying information by colour alone. Nothing here does: the state
 * still says its own name in words, in both branches. What changes is only how loudly the
 * ordinary answer is said.
 *
 * ## Choosing `ordinary`
 *
 * It is not "the state whose tone is success". `Skipped` is toned neutral and is very
 * much worth noticing — it is a row the merchant expected to be priced and which was not.
 * The question is whether the state is the *expected outcome of the operation this table
 * reports on*, which is a judgement each caller makes about its own table, so it is a
 * prop rather than a lookup here.
 */
export function RowState({
  label,
  tone,
  ordinary = false,
}: {
  label: string;
  tone: Tone;
  /** True when this is the expected outcome, and so not worth a badge. */
  ordinary?: boolean;
}) {
  if (ordinary) return <s-text color="subdued">{label}</s-text>;

  return <s-badge tone={tone}>{label}</s-badge>;
}
