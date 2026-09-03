/**
 * Support, reachable from where the problem is.
 *
 * NA puts a contact line in the footer of every page; ours was a nav item, one navigation
 * away from whatever had just gone wrong. On an error screen or a held campaign that is
 * exactly the wrong moment to ask somebody to go and find the help section.
 *
 * So this route takes its context from the URL — the page they were on, the campaign, the
 * run, the error id — and the surfaces that know those things link here carrying them.
 *
 * ## Everything attached is shown
 *
 * The context is rendered as a list the merchant reads before pressing Send, not
 * summarised as "diagnostic information". A merchant cannot consent to a description, and
 * this app's whole argument is that it tells you exactly what it is about to do. The
 * fields are fixed and price-free by construction — see `lib/support/context.ts`.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { billingFor } from "../services/billing.server";
import { sendSupportRequest } from "../services/support.server";
import { CONTEXT_FIELDS, CONTEXT_LABELS, supportContext } from "../lib/support/context";
import { PageShell } from "../components/PageShell";
import { Field } from "../components/FieldGrid";
import { ActionRow } from "../components/ActionRow";
import { RouteBoundary } from "../components/RouteBoundary";
import { HelpNote } from "../components/HelpNote";
import { withGuard } from "../lib/errors/guard.server";
import { SPACE } from "../lib/ui/spacing";

/**
 * Which build this is.
 *
 * The same value Sentry tags its releases with, so a support thread and a stack trace can
 * be lined up. "dev" locally, where the question "which release" has no answer worth
 * printing.
 */
function appVersion(): string {
  // eslint-disable-next-line no-undef
  const env = process.env;
  return env.SENTRY_RELEASE ?? env.SOURCE_VERSION ?? "dev";
}

async function contextFor(request: Request) {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const params = new URL(request.url).searchParams;
  const billing = await billingFor(shop.id);

  return supportContext({
    shopDomain: session.shop,
    plan: billing.plan.name,
    appVersion: appVersion(),
    path: params.get("from"),
    campaignId: params.get("campaign"),
    runId: params.get("run"),
    errorId: params.get("error"),
  });
}

export const loader = withGuard("/app/support", async ({ request }: LoaderFunctionArgs) => {
  return { context: await contextFor(request) };
});

export const action = withGuard("/app/support", async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const body = String(form.get("body") ?? "").trim();
  const replyTo = String(form.get("replyTo") ?? "").trim();

  if (!body) {
    return { ok: false, message: "Tell us what happened first — even one line helps." };
  }
  if (!replyTo.includes("@")) {
    return { ok: false, message: "We need an address to reply to." };
  }

  // Rebuilt from the request rather than read from the form. The form shows the merchant
  // what will be attached; it does not get to decide it, or a posted field could name
  // another shop.
  const context = await contextFor(request);

  const result = await sendSupportRequest({
    subject: String(form.get("subject") ?? "").trim() || "Support request",
    body,
    replyTo,
    context,
  });

  return { ok: result.sent, message: result.message };
});

export default function Support() {
  const { context } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";

  return (
    <PageShell heading="Contact support" backTo={{ href: "/app/help", label: "Help" }}>
      {fetcher.data ? (
        <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      {/* "Your message", not "What happened".

          The card was headed "What happened" and its third field was labelled "What
          happened" — the same three words twice, four hundred pixels apart, with an
          email address and a subject line in between. The card holds the whole message;
          the field holds the account of the problem. Naming the container after one of
          its contents is how a form stops being legible as a form. */}
      <s-section heading="Your message">
        <fetcher.Form method="post">
          {/* Each field at the width of what it holds. An email address and a subject
              line rendered the full width of the card, which is a message box's worth of
              room for one line — and it made the three fields read as one block rather
              than as a short answer, a short answer and a long one. */}
          <s-stack direction="block" gap={SPACE.item}>
            <Field width="medium">
              <s-text-field
                name="replyTo"
                label="Your email"
                details="Where we reply. Not stored."
                placeholder="you@yourshop.com"
              />
            </Field>
            <Field width="long">
              <s-text-field
                name="subject"
                label="Subject"
                placeholder="A campaign is stuck on Held"
              />
            </Field>
            <Field width="long">
              <s-text-area
                name="body"
                label="What happened"
                rows={6}
                placeholder="What you expected, what happened instead, and what you have already tried."
              />
            </Field>
            {/* Under the fields it belongs to rather than pushed to the far right of the
                card, where it was the only thing on its line and a long way from the last
                thing typed. */}
            <ActionRow>
              <s-button type="submit" variant="primary" loading={busy || undefined}>
                Send
              </s-button>
            </ActionRow>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section heading="What we attach">
        {/* Listed, not summarised. A merchant cannot consent to "diagnostic
            information", and the fastest way to make somebody distrust a Send button is
            to be vague about it one time. */}
        <s-paragraph>
          <s-text color="subdued">
            Sent with your message so we do not have to ask. No prices are included — this
            is the same rule our error reporting follows.
          </s-text>
        </s-paragraph>
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">What</s-table-header>
            <s-table-header listSlot="inline">Value</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {CONTEXT_FIELDS.filter((field) => context[field]).map((field) => (
              <s-table-row key={field}>
                <s-table-cell>{CONTEXT_LABELS[field]}</s-table-cell>
                <s-table-cell>{context[field]}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <HelpNote label="Before you write">
        <s-paragraph>
          A campaign on Held is waiting for a decision rather than broken: somebody edited
          a price under it, and nothing is overwritten until you say which price wins.
        </s-paragraph>
        <s-paragraph>
          A partial run has a reason recorded against every row that did not land, on the
          campaign’s Ledger tab. Resuming retries only those rows.
        </s-paragraph>
      </HelpNote>
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
