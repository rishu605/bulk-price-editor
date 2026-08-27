import { useState } from "react";

import type { OnboardingState, OnboardingStep } from "../lib/onboarding/steps";

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
 */
export function OnboardingCard({ state }: { state: OnboardingState }) {
  if (state.complete) return null;

  const done = state.steps.filter((step) => step.done).length;

  return (
    <s-section heading="Getting started">
      <s-stack direction="inline" gap="base">
        <s-badge tone={done === state.steps.length ? "success" : "info"}>
          {done} of {state.steps.length} done
        </s-badge>
        <s-text tone="neutral">Nothing here changes a price until you apply one.</s-text>
      </s-stack>

      {state.steps.map((step) => (
        <Step key={step.id} step={step} isNext={step.id === state.next?.id} />
      ))}
    </s-section>
  );
}

function Step({ step, isNext }: { step: OnboardingStep; isNext: boolean }) {
  const [why, setWhy] = useState(false);

  return (
    <s-box>
      <s-stack direction="inline" gap="base">
        <s-badge tone={step.done ? "success" : isNext ? "info" : "neutral"}>
          {step.done ? "Done" : isNext ? "Next" : "Later"}
        </s-badge>
        <s-text type="strong">{step.title}</s-text>
        {step.href && step.cta ? <s-link href={step.href}>{step.cta}</s-link> : null}
        {/* Progressive disclosure, not a link away. The reasoning belongs next to the
            step it explains — sending a merchant to a docs page to find out why they
            are being asked to sync is how they end up not syncing. */}
        <s-clickable onClick={() => setWhy((open) => !open)}>
          <s-text tone="neutral">{why ? "Hide why" : "Why?"}</s-text>
        </s-clickable>
      </s-stack>

      {why ? (
        <s-paragraph>
          <s-text>{step.detail}</s-text>
        </s-paragraph>
      ) : null}
    </s-box>
  );
}
