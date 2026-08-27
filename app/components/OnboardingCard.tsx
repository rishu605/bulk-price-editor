import { useState } from "react";

import type { OnboardingState, OnboardingStep } from "../lib/onboarding/steps";
import { HAIRLINE, PAD, SPACE } from "../lib/ui/spacing";

/**
 * The checklist, until the first campaign has run cleanly.
 *
 * It used to render every step's explanation at once — roughly 120 words before the
 * merchant reached a link, on the first screen they see after installing. The
 * explanations are good and the baseline concept genuinely does need teaching; the
 * mistake was teaching all of it before being asked.
 *
 * So the checklist is a checklist: one line per step, the next step's action in reach,
 * and the *why* behind a toggle. A merchant who wants the reasoning can have it in one
 * click; a merchant who wants to get on with it is not made to scroll past it.
 *
 * Completed steps lose their button. A finished step with a call to action invites
 * redoing it, and redoing the first one recaptures baselines — which mid-sale would make
 * the sale prices somebody's new normal, permanently.
 *
 * The state comes from what the shop has actually done, never from "steps dismissed", so
 * there is nothing here to dismiss: the card retires itself when the work is real.
 *
 * Three rhythms, nested, and they are what make it scan as a checklist rather than a
 * paragraph with badges in it: section rhythm between the progress line and the list,
 * item rhythm between the steps, item rhythm again inside a step. The steps are bounded
 * boxes for the same reason the stat tiles are — a checklist whose items have no edges
 * is just four lines of text, and the merchant has to count the badges to work out where
 * one step stops.
 */
export function OnboardingCard({ state }: { state: OnboardingState }) {
  if (state.complete) return null;

  const done = state.steps.filter((step) => step.done).length;

  return (
    <s-section heading="Getting started">
      <s-stack gap={SPACE.section}>
        <s-stack direction="inline" gap={SPACE.item} alignItems="center">
          <s-badge tone={done === state.steps.length ? "success" : "info"}>
            {done} of {state.steps.length} done
          </s-badge>
          {/* `color="subdued"`, not `tone="neutral"`. Tone carries status, and "neutral"
              says this sentence has none -- which is not the same as saying it is
              supporting text, and is not what the muted rendering here was for. */}
          <s-text color="subdued">Nothing here changes a price until you apply one.</s-text>
        </s-stack>

        <s-stack gap={SPACE.item}>
          {state.steps.map((step) => (
            <Step key={step.id} step={step} isNext={step.id === state.next?.id} />
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

function Step({ step, isNext }: { step: OnboardingStep; isNext: boolean }) {
  const [why, setWhy] = useState(false);

  return (
    <s-box
      padding={PAD.card}
      borderWidth={HAIRLINE.borderWidth}
      borderStyle={HAIRLINE.borderStyle}
      borderColor={HAIRLINE.borderColor}
      borderRadius="base"
    >
      <s-stack gap={SPACE.item}>
        <s-stack direction="inline" gap={SPACE.item} alignItems="center">
          <s-badge tone={step.done ? "success" : isNext ? "info" : "neutral"}>
            {step.done ? "Done" : isNext ? "Next" : "Later"}
          </s-badge>
          <s-text type="strong">{step.title}</s-text>
          {/* Progressive disclosure, not a link away. The reasoning belongs next to the
              step it explains — sending a merchant to a docs page to find out why they
              are being asked to sync is how they end up not syncing.

              Before the action, deliberately. The row wraps on a narrow column, and when
              the toggle was last it wrapped onto its own line and read as belonging to
              the step below it. The action wrapping is harmless; an explanation attached
              to the wrong step is not. */}
          <s-clickable onClick={() => setWhy((open) => !open)}>
            <s-text color="subdued">{why ? "Hide why" : "Why?"}</s-text>
          </s-clickable>
          {step.href && step.cta ? <s-link href={step.href}>{step.cta}</s-link> : null}
        </s-stack>

        {why ? (
          <s-paragraph>
            <s-text color="subdued">{step.detail}</s-text>
          </s-paragraph>
        ) : null}
      </s-stack>
    </s-box>
  );
}
