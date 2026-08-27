import { PAD, SPACE } from "../lib/ui/spacing";

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
  description?: string;
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
 */
export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <s-box paddingBlock={PAD.block}>
      <s-stack gap={SPACE.item} alignItems="center">
        <s-heading>{title}</s-heading>
        {description ? (
          <s-paragraph>
            <s-text color="subdued">{description}</s-text>
          </s-paragraph>
        ) : null}
        {action ? <s-button href={action.href}>{action.label}</s-button> : null}
      </s-stack>
    </s-box>
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
