import { useState, type ReactNode } from "react";

import type { OnboardingState, OnboardingStep, StepId } from "../lib/onboarding/steps";
import { SPACE } from "../lib/ui/spacing";
import { ActionRow } from "./ActionRow";
import { Secondary } from "./Type";

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
 * ## Why the steps are rows and not boxes
 *
 * Each step used to be a bordered box holding a stack, and the result was three tall
 * cards inside a card, each with a title on one line, a lone "Why?" on the next and its
 * action on a third. Nine lines and three borders to carry three short sentences, with
 * the right two-thirds of every box empty.
 *
 * The line breaks were `s-clickable`, which is block-level — it was the "Why?" toggle,
 * and a block element in the middle of an inline stack breaks the line before it and
 * after it, which is what put the action on a third row. It is a button now, and buttons
 * are not block-level. (An earlier version of this comment said `s-link` was too. It is
 * not; only `s-clickable` is, checked against the rendered components.)
 *
 * The grid is still here, and for a different reason than working around that: it lines
 * the *columns* up across rows. A stack would put each step's action wherever its title
 * happened to end, and three actions at three different distances from the edge read as
 * three unrelated things. So a step is one row — status, title, action — the steps are
 * separated by hairlines rather than each being drawn as its own card, and the eye can
 * run down the status column to see where it is up to.
 */
/**
 * A step's action, where a link cannot be one.
 *
 * Two of the three steps go somewhere — the editor, in practice or guided mode — and a
 * link is the right control for those. The first does not: capturing baselines is a
 * `POST` from the page the checklist is already on, and it was written as a link to
 * `/app`. On Home that is a button that reloads the page you are looking at and changes
 * nothing, sitting directly above a second, black button that actually does the work
 * under a different name.
 *
 * So a page can hand the card the real control for a step, and the checklist stops being
 * a set of links that mostly work.
 */
export type StepActions = Partial<Record<StepId, ReactNode>>;

export function OnboardingCard({
  state,
  actions,
}: {
  state: OnboardingState;
  actions?: StepActions;
}) {
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
          {state.steps.map((step, index) => (
            <s-stack key={step.id} gap={SPACE.item}>
              {/* A rule between steps rather than a border around each. The separator is
                  the same information as the box — where one step stops — at a fraction
                  of the ink, and it does not nest a card inside a card. */}
              {index > 0 ? <s-divider /> : null}
              <Step
                step={step}
                isNext={step.id === state.next?.id}
                action={actions?.[step.id]}
              />
            </s-stack>
          ))}
        </s-stack>
      </s-stack>
    </s-section>
  );
}

/**
 * The status glyph.
 *
 * A checked circle, an open one and a dashed one: the standard vocabulary for done, now
 * and not yet, which means the column reads as a progress track without anybody having
 * to label it. The badge that used to say "Done" / "Next" / "Later" on every row is gone
 * with it — three badges to say what three glyphs say, and the two loudest words on the
 * card were "Done" and "Later".
 *
 * "Next" survives as a badge on exactly one row, because that one is not a status the
 * eye should merely be able to find. It is the instruction.
 */
function StatusIcon({ done, isNext }: { done: boolean; isNext: boolean }) {
  if (done) return <s-icon type="check-circle-filled" tone="success" />;
  if (isNext) return <s-icon type="circle" />;
  return <s-icon type="circle-dashed" color="subdued" />;
}

function Step({
  step,
  isNext,
  action,
}: {
  step: OnboardingStep;
  isNext: boolean;
  action?: ReactNode;
}) {
  const [why, setWhy] = useState(false);

  return (
    <s-stack gap={SPACE.tight}>
      <s-grid
        // Three columns, collapsing to two. `auto 1fr auto` keeps the status glyph and
        // the action tight to their content and gives the title everything left over,
        // which is what stops the row from breaking into three.
        //
        // One comma only. Polaris splits a responsive value on the comma to separate
        // "when the query matches" from "otherwise", so a second one anywhere in the
        // value stops the whole thing parsing and it falls back to `none`.
        gridTemplateColumns="@container (inline-size <= 500px) auto 1fr, auto 1fr auto"
        gap={SPACE.item}
        alignItems="center"
      >
        <StatusIcon done={step.done} isNext={isNext} />

        <s-stack direction="inline" gap={SPACE.item} alignItems="center">
          {/* Subdued once done. A finished step should still be findable — it is the
              evidence the checklist is being honest — without competing with the step
              the merchant is actually being asked to do. */}
          <s-text type={step.done ? undefined : "strong"} color={step.done ? "subdued" : undefined}>
            {step.title}
          </s-text>
          {isNext ? <s-badge tone="info">Next</s-badge> : null}
        </s-stack>

        {/* Why before the action, deliberately: when the row wraps it is the action
            that should fall to the next line, not the explanation, which would then read
            as belonging to the step below it. */}
        <ActionRow>
          {/* Not on a finished step. The reasoning for work already done is the one
              thing on this card nobody needs, and on a completed row — which has no
              action beside it — it was also the only thing left hanging off the right
              edge, so the column of actions read as ragged. */}
          {step.done ? null : (
            <s-button variant="tertiary" onClick={() => setWhy((open) => !open)}>
              {why ? "Hide why" : "Why?"}
            </s-button>
          )}
          {/* Black on the step being asked for, bordered on the ones after it. A
              checklist whose every row shouts equally is a checklist that has not said
              what to do next — which is the only thing it is for. See `ActionRow` for
              the vocabulary. */}
          {/* The page's own control wins where it supplied one. A finished step keeps
              none either way: `onboarding()` drops the href and the label once a step is
              done, and a page that hands over a form has to do the same or the checklist
              would offer to redo work it has just ticked off. */}
          {step.done ? null : action}
          {!action && step.href && step.cta ? (
            <s-button href={step.href} variant={isNext ? "primary" : "secondary"}>
              {step.cta}
            </s-button>
          ) : null}
        </ActionRow>
      </s-grid>

      {/* Progressive disclosure, not a link away. The reasoning belongs next to the step
          it explains — sending a merchant to a docs page to find out why they are being
          asked to sync is how they end up not syncing. */}
      {why ? (
        <Secondary>{step.detail}</Secondary>
      ) : null}
    </s-stack>
  );
}
