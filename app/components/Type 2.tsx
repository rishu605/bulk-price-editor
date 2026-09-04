import type { ReactNode } from "react";

/**
 * The typographic roles this app has, and what each one renders as.
 *
 * `spacing.ts` names every distance and `FieldGrid` names every width. Type had nothing —
 * so each route chose between `<s-paragraph>`, `<s-text color="subdued">` and a bare
 * string by hand, and five roles collapsed into three treatments with two of them
 * identical. From the settings page at 4× zoom, before this existed:
 *
 * | role | rendered as |
 * | --- | --- |
 * | card heading — "Guardrails" | 15px semibold black |
 * | card lede — "Floors that no campaign may price below…" | 15px regular black |
 * | **field label — "Minimum margin (%)"** | **15px regular black** |
 * | card secondary — "0 of 0 variants have a cost…" | 15px grey |
 * | field helper — "Share of the selling price…" | 14px grey |
 *
 * A reader could not tell a card's lede from a field's label, because they were the same
 * thing. And the two greys were different sizes doing similar jobs, so they did not read
 * as one rank either.
 *
 * ## The rank that was missing
 *
 * Polaris offers `type="small"` on both `s-paragraph` and `s-text`, and this app used it
 * **zero times** — 67 uses of `color="subdued"` and nothing else. So the whole hierarchy
 * was carried by grey-versus-black at one size, which is one bit of information doing the
 * work of three.
 *
 * Three ranks now, and each differs from its neighbours by more than one property:
 *
 * - **heading** — the card's own, set by `s-section`'s `heading` and sized by `Card`.
 * - **`Lede`** — body size, base colour. What this card is for, in a sentence.
 * - **`Secondary`** — small and subdued. What qualifies it: a count, a caveat, a
 *   consequence. Smaller *and* quieter, so it cannot be mistaken for a lede or for a
 *   field's label.
 *
 * ## What is deliberately not here
 *
 * **Field labels and field helper text.** Polaris fields own both — `label` and `details`
 * — and a second way to render them would be a way for them to disagree with the ones
 * Polaris draws. The collision above is fixed from the other side: the heading gets bigger
 * (#589) and the secondary rank gets smaller, so a label sits between two ranks that no
 * longer look like it.
 *
 * **A component per size.** These are roles, not sizes. `Secondary` is small *because*
 * qualifying prose should be quieter, and if that judgement changes it changes here rather
 * than in sixty routes.
 */

/**
 * The sentence under a card's heading that says what the card is for.
 *
 * Body size, base colour, and the only prose in a card that is neither the heading nor
 * subordinate to something. One per card is the intent; two ledes is a card with two
 * subjects.
 */
export function Lede({ children }: { children: ReactNode }) {
  return <s-paragraph>{children}</s-paragraph>;
}

/**
 * Prose that qualifies rather than explains: a count, a caveat, a consequence.
 *
 * Small and subdued. It used to be `<s-paragraph><s-text color="subdued">` written out at
 * twenty-one call sites — body size, grey — which is the same size as the lede above it
 * and the label beside it, so the only thing marking it as subordinate was a colour.
 *
 * ## The cast, and why it is not a shortcut
 *
 * `small` is a real Polaris type: `ParagraphType` is `'paragraph' | 'small'`, documented
 * as "considered less important than the main content… surfaces should apply a smaller
 * font size than the default size", rendered as `<small>`. What does not have it is the
 * **React** props for this version — `ReactProps` for `s-paragraph` picks only `id` and
 * `children`, the same way it omits `s-page`'s `subheading`. The element still receives
 * the attribute, because React passes unknown attributes through to a custom element.
 *
 * So the cast asserts something the platform documents and the pinned wrapper has not
 * caught up with, in one place, with the alternative named: without it there is exactly
 * one de-emphasis lever in the typed API — subdued colour — which is one bit of
 * information doing the work of three ranks.
 *
 * **If it does not render smaller, this is worth nothing and should go.** The rank would
 * then have to come from the heading (#589) and the card's rhythm (#578) alone. Checked
 * on the deployed build at 4× zoom, which is the only way to know.
 */
const SMALL = { type: "small" } as unknown as { type?: never };

export function Secondary({ children }: { children: ReactNode }) {
  return (
    <s-paragraph {...SMALL} color="subdued">
      {children}
    </s-paragraph>
  );
}

/**
 * The label half of a labelled fact — "Last synced", "Plan", "Oldest baseline captured".
 *
 * Inline rather than a paragraph, because it sits directly above the value it names and a
 * paragraph's own leading would push the two apart. Small and subdued for the same reason
 * `Secondary` is: a caption that is the same size as its value is not a caption.
 *
 * The value itself is deliberately not a component here — it is whatever it is, a number,
 * a date, a badge — and wrapping it would mean guessing.
 */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <s-text {...SMALL} color="subdued">
      {children}
    </s-text>
  );
}
