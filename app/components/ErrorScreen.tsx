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

import { ActionRow } from "./ActionRow";
import { PageShell } from "./PageShell";
import { helpLabelFor, helpPathFor } from "../lib/errors/help-links";
import { SPACE } from "../lib/ui/spacing";

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
    <PageShell heading="Something went wrong">
      <s-section>
        <s-banner tone={retryable ? "warning" : "critical"}>
          <s-paragraph>{userMessage}</s-paragraph>
        </s-banner>

        <s-stack gap={SPACE.section}>
          <s-paragraph>
            <s-text>
              No prices were changed by this error. If a run was in progress, open the
              campaign — its ledger shows exactly which variants were written before
              the failure, and resuming picks up from there.
            </s-text>
          </s-paragraph>

          {/* Every merchant-visible error links to the page that explains it. Somebody
              hitting this at 9pm before a sale wants the sentence that says what to do,
              one click from here — not a search box. It sits in the row with the other
              two actions rather than a paragraph above them, because it is one of the
              three things they might do next. */}
          <ActionRow>
            <s-button href={retryHref ?? "."} variant="primary">
              Try again
            </s-button>
            <s-button href="/app">Back to dashboard</s-button>
            <s-button variant="tertiary" href={helpPathFor(code)} target="_blank">
              {helpLabelFor(code)}
            </s-button>
          </ActionRow>

          <s-divider />

          <s-paragraph>
            <s-text>
              This reference links straight to the full technical detail. Contacting
              support from here carries it for you.
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text><strong>{errorId}</strong> · {code}</s-text>
          </s-paragraph>

          {/* The whole point of #457: support one click from the problem, not one
              navigation away from it. Somebody on this screen has already spent their
              patience, and asking them to find the help section and retype an id is how
              a support request becomes an uninstall. */}
          <ActionRow>
            <s-button variant="tertiary" icon="chat" href={supportHref(errorId)}>
              Contact support about this
            </s-button>
          </ActionRow>
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
    </PageShell>
  );
}

/**
 * The support route, carrying the error and the page it happened on.
 *
 * The path comes from the browser rather than from a prop: this screen is rendered by the
 * one boundary every route uses, so it does not know which route it replaced. Server-side
 * there is no location at all, and the link is still worth having without it — the error
 * id is the part support needs.
 */
function supportHref(errorId: string): string {
  const params = new URLSearchParams({ error: errorId });
  if (typeof window !== "undefined" && window.location?.pathname) {
    params.set("from", window.location.pathname);
  }
  return `/app/support?${params}`;
}
