/**
 * The page that turns "it crashed" into an answer.
 *
 * A merchant quotes an id; this looks it up and shows the stack, the route and the
 * context that call site attached. Without the id, it lists what has failed recently
 * grouped by code, which answers the other question worth asking fast: is this one
 * merchant hitting one bug, or is everything on fire.
 */

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { errorByPublicId, recentErrors } from "../services/error-report.server";
import { isErrorId } from "../lib/errors/error-id";
import { EmptyState } from "../components/AsyncState";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

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

export default function Debug() {
  const { query, invalidQuery, match, recent, byCode } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Diagnostics">
      <s-section heading="Look up an error">
        <s-paragraph>
          <s-text>
            Paste the reference from an error screen, for example ANC-K3M2-P7QR.
          </s-text>
        </s-paragraph>

        <Form method="get">
          <s-stack direction="inline" gap="base">
            <s-text-field name="id" label="Reference" value={query} />
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
          <s-stack gap="base">
            <s-divider />
            <s-heading>{match.errorId}</s-heading>
            <s-paragraph>
              <s-badge>{match.code}</s-badge>{" "}
              {match.retryable ? <s-badge tone="warning">retryable</s-badge> : null}
            </s-paragraph>
            <s-paragraph>
              <s-text>
                {match.createdAt} · {match.method ?? "—"} {match.route ?? "—"}
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
          <s-table>
            <s-table-header-row>
              <s-table-header>Reference</s-table-header>
              <s-table-header>Code</s-table-header>
              <s-table-header>Route</s-table-header>
              <s-table-header>When</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {recent.map((row) => (
                <s-table-row key={row.errorId}>
                  <s-table-cell>
                    <s-link href={`/app/settings/diagnostics?id=${row.errorId}`}>{row.errorId}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={row.retryable ? "warning" : "critical"}>
                      {row.code}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{row.route ?? "—"}</s-table-cell>
                  <s-table-cell>{row.createdAt}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {byCode.length > 0 ? (
        <s-section slot="aside" heading="By kind">
          <s-paragraph>
            <s-text>
              One code dominating usually means one broken thing, not fifty.
            </s-text>
          </s-paragraph>
          {byCode.map(([code, count]) => (
            <s-paragraph key={code}>
              <s-text>
                {code} — {count}
              </s-text>
            </s-paragraph>
          ))}
        </s-section>
      ) : null}
    </s-page>
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
