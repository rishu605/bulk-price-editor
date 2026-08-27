/**
 * Receiving feedback, and showing a merchant what came of it.
 *
 * The list is the point as much as the form. A beta merchant keeps talking to you for
 * exactly as long as talking to you appears to change something, and "we received this,
 * here is what we decided" is the cheapest way to show that.
 */

import { formatDay } from "../lib/format/display";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { feedbackFor, isSentiment, recordFeedback } from "../services/feedback.server";
import { actorFor } from "../lib/audit/actor";
import { FeedbackForm } from "../components/FeedbackForm";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

export const loader = withGuard("/app/settings/feedback", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const sent = await feedbackFor(shop.id);

  return {
    timeZone: shop.timezone,
    sent: sent.map((entry) => ({
      id: entry.id,
      message: entry.message,
      sentiment: entry.sentiment,
      status: entry.status,
      shippedAt: entry.shippedAt?.toISOString() ?? null,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
});

export const action = withGuard("/app/settings/feedback", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const sentiment = form.get("sentiment");

  return recordFeedback(
    shop.id,
    String(form.get("message") ?? ""),
    isSentiment(sentiment) ? sentiment : "problem",
    {
      route: String(form.get("route") ?? "") || undefined,
      actor: actorFor(sessionToken, session.shop),
    },
  );
});

export default function FeedbackPage() {
  const { sent, timeZone } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Feedback">
      <FeedbackForm route="/app/settings/feedback" />

      {sent.length > 0 ? (
        <s-section heading="What you have sent">
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Kind</s-table-header>
              <s-table-header>What you said</s-table-header>
              <s-table-header>Where it got to</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {sent.map((entry) => (
                <s-table-row key={entry.id}>
                  <s-table-cell>
                    {formatDay(entry.createdAt, timeZone)}
                  </s-table-cell>
                  <s-table-cell>{entry.sentiment}</s-table-cell>
                  <s-table-cell>
                    {entry.message.length > 120
                      ? `${entry.message.slice(0, 117)}…`
                      : entry.message}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={statusTone(entry.status)}>{describeStatus(entry.status)}</s-badge>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      ) : null}
    </s-page>
  );
}

/**
 * What a merchant is told about the state of their feedback.
 *
 * Never the internal label. "p6" means nothing to them, and "we are not doing this" is
 * more respectful than leaving it looking unread for ever.
 */
function describeStatus(status: string | null): string {
  switch (status) {
    case "shipped":
      return "Shipped";
    case "p5":
      return "Planned";
    case "p6":
      return "On the longer list";
    case "wont-do":
      return "Not planned";
    default:
      return "Received";
  }
}

function statusTone(status: string | null): "success" | "info" | "neutral" {
  if (status === "shipped") return "success";
  if (status === "p5" || status === "p6") return "info";
  return "neutral";
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
