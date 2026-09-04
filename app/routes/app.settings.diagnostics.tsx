/**
 * The page that turns "it crashed" into an answer.
 *
 * A merchant quotes an id; this looks it up and shows the stack, the route and the
 * context that call site attached. Without the id, it lists what has failed recently
 * grouped by code, which answers the other question worth asking fast: is this one
 * merchant hitting one bug, or is everything on fire.
 */

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Blank } from "../components/Blank";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { errorByPublicId, recentErrors } from "../services/error-report.server";
import { isErrorId } from "../lib/errors/error-id";
import { EmptyState } from "../components/AsyncState";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { CountsRow } from "../components/CountsRow";
import { Field } from "../components/FieldGrid";
import { HelpNote } from "../components/HelpNote";
import { SPACE } from "../lib/ui/spacing";
import { Secondary } from "../components/Type";

export const loader = withGuard("/app/settings/diagnostics", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const query = (new URL(request.url).searchParams.get("id") ?? "").trim();

  // A quoted id is the common case and deserves an exact match, not a search over
  // recent rows that may already have scrolled past the limit.
  const match = query && isErrorId(query) ? await errorByPublicId(query) : null;
  const recent = await recentErrors(shop.id, 50);

  const counts = new Map<string, number>();
  for (const row of recent) counts.set(row.code, (counts.get(row.code) ?? 0) + 1);

  return {
    query,
    invalidQuery: query.length > 0 && !isErrorId(query),
    match: match
      ? {
          ...match,
          createdAt: match.createdAt.toISOString(),
          context: JSON.stringify(match.context, null, 2),
        }
      : null,
    recent: recent.map((row) => ({
      errorId: row.errorId,
      code: row.code,
      message: row.message,
      route: row.route,
      retryable: row.retryable,
      createdAt: row.createdAt.toISOString(),
    })),
    byCode: [...counts.entries()].sort((a, b) => b[1] - a[1]),
  };
});

/**
 * The breakdown as tiles, bounded.
 *
 * `CountsRow` gives every item an equal column, so ten codes would be ten slivers of a
 * number. Four plus a remainder keeps the row readable — and the remainder is its own
 * tile rather than a silent truncation, because a summary that quietly drops codes is
 * worse than no summary. Every dropped code is still in the table below, on its own rows.
 */
const TILES = 4;

function tilesFor(byCode: Array<[string, number]>) {
  const top = byCode.slice(0, TILES).map(([label, value]) => ({ label, value }));
  const rest = byCode.slice(TILES);
  if (rest.length === 0) return top;

  return [
    ...top,
    {
      label: `${rest.length} other codes`,
      value: rest.reduce((total, [, count]) => total + count, 0),
    },
  ];
}

export default function Debug() {
  const { query, invalidQuery, match, recent, byCode } = useLoaderData<typeof loader>();
  const byKind = tilesFor(byCode);

  return (
    <PageShell heading="Diagnostics">
      <s-section heading="Look up an error">
        <s-paragraph>
          <s-text>
            Paste the reference from an error screen, for example ANC-K3M2-P7QR.
          </s-text>
        </s-paragraph>

        <Form method="get">
          {/* The field and its button are one control. `alignItems="end"` because the
              field carries a label above it and the button does not, so without it the
              button floats level with the label rather than with the box.

              That was the whole intent and it had never worked: an unbounded Polaris
              field takes the entire row, so the button wrapped underneath and the two
              rendered as two controls. `Field` is what makes the row a row -- and a
              reference is thirteen characters, so it is `short`. */}
          <s-stack direction="inline" gap={SPACE.item} alignItems="end">
            <Field width="short">
              <s-text-field name="id" label="Reference" value={query} />
            </Field>
            <s-button type="submit" variant="primary">
              Find
            </s-button>
          </s-stack>
        </Form>

        {invalidQuery ? (
          <s-banner tone="warning">
            <s-paragraph>
              That does not look like a reference. They are in the form ANC-XXXX-XXXX.
            </s-paragraph>
          </s-banner>
        ) : null}

        {query && !invalidQuery && !match ? (
          <s-banner tone="warning">
            <s-paragraph>
              No error stored under {query}. Errors are recorded when they happen; if
              the database itself was down, only the server log will have it.
            </s-paragraph>
          </s-banner>
        ) : null}

        {match ? (
          <s-stack gap={SPACE.section}>
            <s-divider />
            <s-heading>{match.errorId}</s-heading>
            <s-paragraph>
              <s-badge>{match.code}</s-badge>{" "}
              {match.retryable ? <s-badge tone="warning">retryable</s-badge> : null}
            </s-paragraph>
            <s-paragraph>
              <s-text>
                {match.createdAt} · {match.method ?? <Blank />} {match.route ?? <Blank />}
              </s-text>
            </s-paragraph>

            <s-heading>Shown to the merchant</s-heading>
            <s-paragraph>{match.userMessage}</s-paragraph>

            <s-heading>Technical message</s-heading>
            <pre style={PRE}>{match.message}</pre>

            {match.context && match.context !== "null" ? (
              <>
                <s-heading>Context</s-heading>
                <pre style={PRE}>{match.context}</pre>
              </>
            ) : null}

            {match.stack ? (
              <>
                <s-heading>Stack</s-heading>
                <pre style={PRE}>{match.stack}</pre>
              </>
            ) : null}
          </s-stack>
        ) : null}
      </s-section>

      <s-section heading="Recent failures">
        {recent.length === 0 ? (
          <EmptyState
            title="Nothing has failed recently"
            description="Errors appear here as they happen, with the reference the merchant sees."
          />
        ) : (
          <>
            {/* The breakdown sits above the rows it counts rather than in a sidebar.
                It answers the question the table cannot at a glance -- one broken thing
                or fifty -- and that question is asked while looking at the table, not
                across the page from it. */}
            <CountsRow items={byKind} />

            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="kicker">When</s-table-header>
                <s-table-header listSlot="primary">Reference</s-table-header>
                <s-table-header listSlot="inline">Code</s-table-header>
                <s-table-header listSlot="secondary">Route</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recent.map((row) => (
                  <s-table-row key={row.errorId}>
                    <s-table-cell>{row.createdAt}</s-table-cell>
                    <s-table-cell>
                      <s-link href={`/app/settings/diagnostics?id=${row.errorId}`}>
                        {row.errorId}
                      </s-link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={row.retryable ? "warning" : "critical"}>
                        {row.code}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{row.route ?? <Blank />}</s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        )}
      </s-section>

      <HelpNote label="Reading the failures">
        <s-paragraph>
          One code dominating usually means one broken thing, not fifty.
        </s-paragraph>
        <Secondary>
          The breakdown counts the fifty most recent failures — the same rows the table
          lists.
        </Secondary>
      </HelpNote>
    </PageShell>
  );
}

const PRE = {
  overflowX: "auto" as const,
  whiteSpace: "pre-wrap" as const,
  fontSize: "0.8rem",
};

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
