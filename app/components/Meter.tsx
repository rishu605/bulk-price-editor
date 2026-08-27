import { HAIRLINE } from "../lib/ui/spacing";

/**
 * A proportion, drawn.
 *
 * ## Why this exists
 *
 * "9,081 of 9,145 variants" is precise, and it is also the slowest possible way to answer
 * the only question being asked of it, which is *nearly all, or barely any?* A bar answers
 * that before the reader has finished arriving at it.
 *
 * The figure stays. This is deliberately not a replacement for saying the number: a bar
 * alone is unreadable to anybody using a screen reader and imprecise for everybody else,
 * so it is always rendered next to the sentence it illustrates and never instead of it.
 * That is also why it takes no accessibility label — labelling it would announce the same
 * fact twice.
 *
 * ## Why the fill is outlined
 *
 * Polaris has no progress element in this version, so the bar is built from the box
 * primitives that are in it rather than from a hardcoded colour that would not follow the
 * merchant's theme. The catch is that every background token available to a box —
 * `subdued`, `base`, `strong` — is a near-white grey, and they were checked side by side:
 * a strong fill on a subdued track is a boundary you have to hunt for, which is a
 * progress bar that does not report progress.
 *
 * The hairline around the fill is what makes it a shape rather than a smudge. It is the
 * same border the stat tiles use, so the bar belongs to the same drawing as the rest of
 * the app, and it stays legible in dark mode where a fixed grey would not.
 */

/** Bar height. Thick enough for the fill's outline to close, thin enough to read as a rule. */
const THICKNESS = "10px";

export function Meter({ value, max }: { value: number; max: number }) {
  // A zero denominator is a real state here — a shop with no variants yet — and it is
  // an empty bar, not a division by zero rendered as `NaN%`.
  const filled = max > 0 ? Math.min(100, Math.max(0, Math.round((value / max) * 100))) : 0;

  return (
    <s-box
      background="subdued"
      borderRadius="large"
      blockSize={THICKNESS}
      inlineSize="100%"
      overflow="hidden"
    >
      {/* The template literal is cast because Polaris types sizes as `${number}%`, and a
          string built from a variable widens to `string`. The clamp above is what makes
          the cast true. */}
      <s-box
        background="strong"
        borderWidth={HAIRLINE.borderWidth}
        borderStyle={HAIRLINE.borderStyle}
        borderColor="strong"
        borderRadius="large"
        blockSize={THICKNESS}
        inlineSize={`${filled}%` as `${number}%`}
      />
    </s-box>
  );
}
