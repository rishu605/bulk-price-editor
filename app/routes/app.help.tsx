/**
 * Help, inside the admin.
 *
 * This page exists because of what the nav item used to be: an `s-app-nav` child whose
 * href was the absolute `helpBase`, carrying `target="_blank"` in the belief that it would
 * open a tab. (Written out rather than quoted as JSX because `action-row.test.tsx` greps
 * the source for that tag, and a comment describing the mistake should not read as one
 * making it.)
 *
 * An app nav link's `href` **must be a relative path within your app** — Shopify's
 * documentation for the element says so, and says that clicking one "navigates the app to
 * this route without a full page reload". `helpBase` is absolute, and `target` is not part
 * of that contract. So App Bridge did what it does with a route it was handed: it pointed
 * the embedded frame at it. That is a full document load to a page outside the embedded
 * app, which drops `host`, `id_token` and `shop` — and with them App Bridge itself.
 *
 * The merchant sees the help centre, and from then on every nav item in the admin is inert,
 * because there is no longer anything in the frame listening for the navigation. Nothing
 * looks broken; clicking simply does nothing. It is the same session loss that
 * `docs/polaris-notes.md` records for a native form element, reached through a link
 * instead. (Written out rather than in angle brackets on purpose: `polaris-traps.test.ts`
 * greps the source for that tag, and a comment describing the trap should not read as one
 * committing it.)
 *
 * So the nav item points here, which is a real route under `app.tsx` and keeps App Bridge
 * alive, and this page sends a merchant onward in a **new tab** — the pattern `ErrorScreen`
 * already uses for the same destination, and the only safe way to reach a non-embedded page
 * from inside the frame.
 *
 * The list is `docs/help/index.md`, parsed — the same structure the help centre itself is
 * built from, so a page added there appears here without anybody remembering to.
 */

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Fragment } from "react";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ActionRow } from "../components/ActionRow";
import { PageShell } from "../components/PageShell";
import { RouteBoundary } from "../components/RouteBoundary";
import { HELP_ROUTE } from "../lib/errors/help-links";
import { withGuard } from "../lib/errors/guard.server";
import { helpNav } from "../lib/help/nav.server";
import { SPACE } from "../lib/ui/spacing";
import { Secondary } from "../components/Type";
import { Card } from "../components/Card";

export const loader = withGuard("/app/help", async ({ request }: LoaderFunctionArgs) => {
  // Authenticated like every other embedded route, even though the content is public
  // prose: an unauthenticated hit here has to go through OAuth rather than render a page
  // the admin frame cannot host.
  await authenticate.admin(request);

  return { nav: helpNav() };
});

export default function HelpIndex() {
  const { nav } = useLoaderData<typeof loader>();

  return (
    <PageShell heading="Help">
      <s-section>
        <s-stack gap={SPACE.section}>
          {nav.lede ? <s-paragraph>{nav.lede}</s-paragraph> : null}
          <Secondary>
            Each page opens in a new tab, so nothing you have open in here is lost.
          </Secondary>
        </s-stack>
      </s-section>

      {/* Above the reading list, not below it. Somebody who opened Help already has a
          question; making them scan every article before finding out a person will
          answer is the arrangement that makes support feel unreachable. Secondary,
          because most questions really are answered by the pages below. */}
      <Card heading="Still stuck">    <s-stack gap={SPACE.item}>
          <s-paragraph>
            Write to us and we reply to every message. Your shop, plan and the page you
            came from are attached, so you do not have to describe your setup — and you
            can see exactly what is being sent before you send it.
          </s-paragraph>
          <ActionRow>
            <s-button variant="secondary" icon="chat" href="/app/support?from=/app/help">
              Contact support
            </s-button>
          </ActionRow>
        </s-stack>
      </Card>

      {nav.sections.map((section) => (
        <Card key={section.id} heading={section.title}>      <s-stack gap={SPACE.section}>
            {section.blurb ? <s-paragraph>{section.blurb}</s-paragraph> : null}

            {/* A grid, so the list has a left edge.

                Each row was a title button followed by its blurb on the same line, and a
                button is as wide as its label — so every blurb started at a different x.
                "and why every campaign computes from it" began a hundred and thirty
                pixels right of "one winner per product, never stacked", and a reader
                scanning for the article they want had no column to scan down.

                `auto 1fr` rather than two equal halves: the titles are what is being
                chosen between, so they take the room they need and the blurbs take what
                is left. Below 700px the blurb wraps under its title instead, which is a
                list rather than two cramped columns. */}
            <s-grid
              gridTemplateColumns="@container (inline-size <= 700px) 1fr, auto 1fr"
              gap={SPACE.item}
              alignItems="center"
            >
              {section.items.map((item) => (
                <Fragment key={item.slug}>
                  {/* Root-relative and a new tab. Relative because the app document is
                      served from our own origin inside the frame as well as outside it,
                      and a new tab because the destination is not an embedded page — see
                      the note at the top of this file for what happens when it is not. */}
                  {/* Links, not tertiary buttons. A reading list is content: the
                      titles are what the merchant is scanning, and a list of them in
                      plain dark text is a list of things that do not look like they go
                      anywhere. */}
                  <s-link href={`${HELP_ROUTE}/${item.slug}`} target="_blank">
                    {item.title}
                  </s-link>
                  {/* Always rendered, even when there is no blurb: the grid places
                      children in order, so a skipped cell would pull the next article's
                      title into the blurb column and every row after it would be one
                      cell out of step. */}
                  <s-text color="subdued">{item.blurb ?? ""}</s-text>
                </Fragment>
              ))}
            </s-grid>
          </s-stack>
        </Card>
      ))}
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
