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
 * - **`Secondary`** — subdued. What qualifies it: a count, a caveat, a consequence. One
 *   grey, decided here, rather than each route choosing whether to grey a paragraph, the
 *   text inside it, or neither.
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
 * Subdued, and one decision rather than twenty-one. It used to be
 * `<s-paragraph><s-text color="subdued">` written out at every call site.
 *
 * ## The size lever that is not there
 *
 * `small` is a real Polaris type — `ParagraphType` is `'paragraph' | 'small'`, documented
 * as "considered less important than the main content… surfaces should apply a smaller
 * font size than the default size", rendered as `<small>`. It is not in the **React**
 * props for the pinned version, which pick only `id` and `children` for a paragraph, the
 * same way they omit `s-page`'s `subheading`.
 *
 * That omission turned out not to be the wrapper lagging behind the runtime. Passed
 * through anyway — React forwards unknown attributes to a custom element — the rendered
 * text was **byte-for-byte the same width** on the deployed page as it had been without
 * it. The runtime does not implement it either, so the attribute arrives and nothing
 * reads it: no error, no warning, no change.
 *
 * So within the typed API this app has exactly **one** de-emphasis lever, and it is
 * colour. That is the constraint these roles are designed inside, and it is why the
 * separation between a card's lede and a field's label has to come from the heading
 * (#589) and the card's rhythm (#578) instead — neither of which depends on a size we
 * cannot set.
 *
 * What `Secondary` still earns without it: one grey, decided once, instead of the same
 * two elements written out at twenty-one call sites where the next one gets it slightly
 * different. When the runtime grows the size, it is one line here.
 */
export function Secondary({ children }: { children: ReactNode }) {
  return (
    <s-paragraph color="subdued">
      {children}
    </s-paragraph>
  );
}

/**
 * The label half of a labelled fact — "Last synced", "Plan", "Oldest baseline captured".
 *
 * Inline rather than a paragraph, because it sits directly above the value it names and a
 * paragraph's own leading would push the two apart. Subdued for the same reason
 * `Secondary` is, and by the same single decision.
 *
 * The value itself is deliberately not a component here — it is whatever it is, a number,
 * a date, a badge — and wrapping it would mean guessing.
 */
export function Caption({ children }: { children: ReactNode }) {
  return (
    <s-text color="subdued">
      {children}
    </s-text>
  );
}
