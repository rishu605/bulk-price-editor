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
import type { ReferenceState } from "../lib/errors/browser-report";
import { helpLabelFor, helpPathFor } from "../lib/errors/help-links";
import { newTabName } from "../lib/ui/new-tab";
import { SPACE } from "../lib/ui/spacing";

export interface ErrorScreenProps {
  /** Null for a refusal the merchant can fix themselves: there is nothing for support to look up (#741). */
  errorId: string | null;
  userMessage: string;
  code: string;
  retryable: boolean;
  /** Development only; omitted in production. */
  stack?: string | null;
  /** Where "try again" should go. Defaults to reloading. */
  retryHref?: string;
  /**
   * Whether support can look the reference up (#783). Defaults to `recorded`, which is true
   * of every error the server guard reported; a crash in the browser is `recording` until
   * the server confirms it stored the report.
   */
  reference?: ReferenceState;
}

export function ErrorScreen({
  errorId,
  userMessage,
  code,
  retryable,
  stack,
  retryHref,
  reference = "recorded",
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
            {/* A new tab, which nothing on the button showed (#798): the name says so. */}
            <s-button
              variant="secondary"
              href={helpPathFor(code)}
              target="_blank"
              accessibilityLabel={newTabName(helpLabelFor(code))}
            >
              {helpLabelFor(code)}
            </s-button>
          </ActionRow>

          {errorId ? (
            <>
              <s-divider />

              <s-paragraph>
                <s-text>{REFERENCE_COPY[reference]}</s-text>
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
            </>
          ) : null}
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
 * What the reference is good for, said only as far as it is true (#783).
 *
 * "Links straight to the full technical detail" is a promise about a row in the database.
 * A crash in the browser has one only once its report has reached the server, and the
 * screen used to make the promise for references that were never stored: Diagnostics
 * then answered "No error stored", on the screen whose job is getting somebody help.
 * Until the server confirms it, the sentence says what support needs instead.
 */
export const REFERENCE_COPY: Record<ReferenceState, string> = {
  recorded:
    "This reference links straight to the full technical detail. Contacting support from here carries it for you.",
  recording:
    "Support needs this reference and a line about what you were doing. Contacting support from here carries the reference for you.",
  unrecorded:
    "This error's details didn't reach us, so the reference alone won't find them. Support needs it and a line about what you were doing; contacting support from here carries the reference for you.",
};

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
