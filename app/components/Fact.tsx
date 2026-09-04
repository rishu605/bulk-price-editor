import type { ReactNode } from "react";

import { Caption } from "./Type";
import { SPACE } from "../lib/ui/spacing";

/**
 * A fact about this shop, with what it is called above it.
 *
 * "Last synced / 2 hours ago", "Plan / Free · campaigns up to 500 variants", "Oldest
 * baseline captured / 12 August". The same shape was written out three ways — a stack
 * with a subdued `s-text` above a plain one on Home, a bordered tile in `CountsRow`, and
 * a third arrangement on the campaign page — so three parts of the app rendered "a value
 * and what it is called" differently.
 *
 * ## The label goes above, not beside
 *
 * Beside, the two compete for the same line and the eye has to work out which is which —
 * which is what two loose paragraphs did here before anything named this shape. Above,
 * the caption is unambiguously subordinate to the thing under it, and a column of facts
 * reads as a column.
 *
 * ## Why the value is not a component
 *
 * It is whatever it is: a date, a count, a sentence, a badge. Wrapping it would mean
 * guessing, and the one thing that must be consistent — the caption — already is.
 *
 * ## What belongs in `detail`
 *
 * The line that qualifies the value rather than restating it: "Your whole catalogue is 0
 * variants, so no campaign can reach the limit." It is tied to the fact rather than
 * floating after it, which is what stops a card of facts reading as one long paragraph
 * with occasional bold words.
 */
export function Fact({
  label,
  children,
  detail,
  action,
}: {
  /** What the value is called. */
  label: string;
  /** The value: a date, a count, a sentence, a badge. */
  children: ReactNode;
  /** One line qualifying the value, if it needs one. */
  detail?: ReactNode;
  /** Something to do about this fact, if there is anything. */
  action?: ReactNode;
}) {
  return (
    <s-stack gap={SPACE.tight}>
      <Caption>{label}</Caption>
      {children}
      {detail ? <Caption>{detail}</Caption> : null}
      {action}
    </s-stack>
  );
}
