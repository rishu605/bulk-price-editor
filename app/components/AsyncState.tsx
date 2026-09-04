import type { ReactNode } from "react";

import { PAD, SPACE } from "../lib/ui/spacing";
import { ActionRow } from "./ActionRow";
import { MEASURE } from "./FieldGrid";
import { Secondary } from "./Type";

/**
 * The three states a data-bearing section can be in, in one place.
 *
 * Every table in this app previously rendered only one of them: the happy path. An
 * empty catalogue and a catalogue that failed to load looked identical -- a blank
 * area with a heading -- which is the single most confusing thing a merchant can be
 * shown, because the two have opposite remedies.
 */

export interface EmptyStateProps {
  /** What is missing, in the merchant's words. */
  title: string;
  /** Why it might be missing and what to do about it. */
  description?: ReactNode;
  action?: { label: string; href: string };
}

/**
 * Nothing here, said deliberately.
 *
 * Centred and given block padding, because the failure mode of an empty state is looking
 * like a rendering accident. Left-aligned at the top of a full-width card, a title and
 * one sentence read as the beginning of content that did not arrive; the same words in
 * the middle of an obviously intentional space read as an answer.
 *
 * The three parts sit at item rhythm: the title, the reason and the way out are one
 * thought, and spacing them apart makes the merchant read three unrelated things.
 *
 * The description is capped rather than running the width of the card. This is the one
 * block on a page that is nothing but body copy, and body copy set across a very wide
 * column is measurably harder to read.
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    /* Left, on the card's own edge — not centred.
    
       Centring is right for a full-page empty state with an illustration, standing on
       its own. Inside a card whose heading is hard left two inches above it, it reads as
       a different component that has wandered in: on Diagnostics the "Recent failures"
       card ran a left-aligned heading, then a gap, then a centred title and a centred
       paragraph floating in the middle of the card. The same shape was on Variants,
       Baselines, Campaigns, Segments, Activity and Price drift — most of the app's first
       run.
    
       The measure stays. It is what stops the description running the width of a table,
       and it is the reason this was given a box in the first place; it just no longer
       has to be centred to have one. */
    <s-box paddingBlock={PAD.block} maxInlineSize={MEASURE}>
      <s-stack gap={SPACE.item}>
        <s-heading>{title}</s-heading>
        {description ? <Secondary>{description}</Secondary> : null}
        {action ? (
          <ActionRow>
            <s-button href={action.href}>{action.label}</s-button>
          </ActionRow>
        ) : null}
      </s-stack>
    </s-box>
  );
}

/**
 * Empty because of a filter, which is a different situation and needs a different answer.
 *
 * Conflating the two is the usual mistake, and the app had been making it on six pages: a
 * shop with no variants needs telling what a variant is, and a shop whose filter matched
 * nothing needs the filter taken off. Six of those pages said "nothing matches" and
 * offered no way to stop matching nothing — one of them, the reconciliation table, went
 * as far as guessing what the merchant had been looking for.
 *
 * A separate export rather than a `filtered` flag on the one above, so the way out cannot
 * be forgotten: there is no way to call this without saying where Clear filters goes.
 *
 * The title names the subject — "No campaigns match those filters" — because the four
 * pages doing this by hand had four different sentences for one situation, two of which
 * ("Nothing matches.") did not say what was missing.
 */
export function NoMatches({
  /** Plural, lower case: campaigns, variants, baselines, prices. */
  noun,
  /** What clearing them would show. Optional — the title is often the whole of it. */
  description,
  /** Where Clear filters goes. See `clearedSearch` in `FilterForm`. */
  clearHref,
}: {
  noun: string;
  description?: ReactNode;
  clearHref: string;
}) {
  return (
    <EmptyState
      title={`No ${noun} match those filters`}
      description={description}
      // Secondary, not primary. A page's primary action is its own — Create campaign,
      // Sync catalogue — and a second black button here would be two answers to "what
      // should I do next".
      action={{ label: "Clear filters", href: clearHref }}
    />
  );
}

/**
 * An inline failure, for a section that failed while the rest of the page is fine.
 *
 * Carries the error id for the same reason the full screen does: a merchant reporting
 * "the drift panel is empty" is unanswerable, and "the drift panel says ANC-K3M2-P7QR"
 * is a single query.
 */
export function InlineError({
  message,
  errorId,
}: {
  message: string;
  errorId?: string;
}) {
  return (
    <s-banner tone="critical">
      <s-paragraph>{message}</s-paragraph>
      {errorId ? (
        <s-paragraph>
          {/* Subdued, not because it matters less -- it is the whole point of the id --
              but because it is a string to copy rather than a sentence to read, and it
              should not compete with the message that tells the merchant what broke. */}
          <s-text color="subdued">Reference {errorId}</s-text>
        </s-paragraph>
      ) : null}
    </s-banner>
  );
}

/**
 * A section waiting on a fetcher, as opposed to a whole-page navigation.
 *
 * Item rhythm and a shared centre line: a spinner and its label are one object, and at
 * `base` with no alignment the label sat off the spinner's centre far enough to look
 * like two things that happened to be next to each other.
 */
export function InlineBusy({ label = "Working…" }: { label?: string }) {
  return (
    <s-stack direction="inline" gap={SPACE.item} alignItems="center">
      <s-spinner accessibilityLabel={label} size="base" />
      <s-text color="subdued">{label}</s-text>
    </s-stack>
  );
}
