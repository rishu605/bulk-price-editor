import type { OnboardingState } from "../lib/onboarding/steps";

/**
 * The checklist, until the first campaign has run cleanly.
 *
 * It leads with *why* rather than what to click. The baseline concept is unfamiliar and
 * the app's whole value rests on the merchant understanding it, and nobody reads the
 * docs first — so the teaching happens here or it does not happen.
 *
 * Completed steps lose their button. A finished step with a call to action invites
 * redoing it, and redoing the first one recaptures baselines — which mid-sale would
 * make the sale prices somebody's new normal, permanently.
 */
export function OnboardingCard({ state }: { state: OnboardingState }) {
  if (state.complete) return null;

  return (
    <s-section heading="Getting started">
      <s-paragraph>
        <s-text>
          Three steps to your first campaign. Nothing here changes a price until you
          explicitly apply one.
        </s-text>
      </s-paragraph>

      {state.steps.map((step) => (
        <s-box key={step.id}>
          <s-paragraph>
            <s-badge tone={step.done ? "success" : step.id === state.next?.id ? "info" : "neutral"}>
              {step.done ? "Done" : step.id === state.next?.id ? "Next" : "Later"}
            </s-badge>{" "}
            <s-text>{step.title}</s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>{step.detail}</s-text>
          </s-paragraph>
          {step.href && step.cta ? <s-link href={step.href}>{step.cta}</s-link> : null}
        </s-box>
      ))}
    </s-section>
  );
}
