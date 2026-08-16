/**
 * What a merchant sees when something breaks.
 *
 * Three things, in this order, because that is the order the questions arrive in:
 * what happened in plain language, whether their prices are safe, and what to do
 * next. The error id comes last -- it matters enormously to support and not at all
 * to someone who just wants their sale to run.
 *
 * The stack trace is shown only in development. In production it is in the log and
 * the error_events table, reachable by the id, which is where it belongs: a stack on
 * screen tells a merchant nothing and tells an attacker something.
 */

export interface ErrorScreenProps {
  errorId: string;
  userMessage: string;
  code: string;
  retryable: boolean;
  /** Development only; omitted in production. */
  stack?: string | null;
  /** Where "try again" should go. Defaults to reloading. */
  retryHref?: string;
}

export function ErrorScreen({
  errorId,
  userMessage,
  code,
  retryable,
  stack,
  retryHref,
}: ErrorScreenProps) {
  return (
    <s-page heading="Something went wrong">
      <s-section>
        <s-banner tone={retryable ? "warning" : "critical"}>
          <s-paragraph>{userMessage}</s-paragraph>
        </s-banner>

        <s-stack gap="base">
          <s-paragraph>
            <s-text>
              No prices were changed by this error. If a run was in progress, open the
              campaign — its ledger shows exactly which variants were written before
              the failure, and resuming picks up from there.
            </s-text>
          </s-paragraph>

          <s-stack direction="inline" gap="base">
            <s-button href={retryHref ?? "."} variant="primary">
              Try again
            </s-button>
            <s-button href="/app">Back to dashboard</s-button>
          </s-stack>

          <s-divider />

          <s-paragraph>
            <s-text>
              Quote this reference if you contact support — it links straight to the
              full technical detail.
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text><strong>{errorId}</strong> · {code}</s-text>
          </s-paragraph>
        </s-stack>

        {stack ? (
          <details>
            <summary>Technical detail (development only)</summary>
            <pre style={{ overflowX: "auto", whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>
              {stack}
            </pre>
          </details>
        ) : null}
      </s-section>
    </s-page>
  );
}
