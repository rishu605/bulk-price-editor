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

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <s-stack gap="base">
      <s-heading>{title}</s-heading>
      {description ? (
        <s-paragraph>
          <s-text>{description}</s-text>
        </s-paragraph>
      ) : null}
      {action ? <s-button href={action.href}>{action.label}</s-button> : null}
    </s-stack>
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
          <s-text>Reference {errorId}</s-text>
        </s-paragraph>
      ) : null}
    </s-banner>
  );
}

/** A section waiting on a fetcher, as opposed to a whole-page navigation. */
export function InlineBusy({ label = "Working…" }: { label?: string }) {
  return (
    <s-stack direction="inline" gap="base">
      <s-spinner accessibilityLabel={label} size="base" />
      <s-text>{label}</s-text>
    </s-stack>
  );
}
