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
          <s-paragraph>
            <s-text color="subdued">
              Each page opens in a new tab, so nothing you have open in here is lost.
            </s-text>
          </s-paragraph>
        </s-stack>
      </s-section>

      {nav.sections.map((section) => (
        <s-section key={section.id} heading={section.title}>
          <s-stack gap={SPACE.section}>
            {section.blurb ? <s-paragraph>{section.blurb}</s-paragraph> : null}

            <s-stack gap={SPACE.item}>
              {section.items.map((item) => (
                <ActionRow key={item.slug}>
                  {/* Root-relative and a new tab. Relative because the app document is
                      served from our own origin inside the frame as well as outside it,
                      and a new tab because the destination is not an embedded page — see
                      the note at the top of this file for what happens when it is not. */}
                  <s-button
                    variant="tertiary"
                    icon="external"
                    href={`${HELP_ROUTE}/${item.slug}`}
                    target="_blank"
                  >
                    {item.title}
                  </s-button>
                  {item.blurb ? <s-text color="subdued">{item.blurb}</s-text> : null}
                </ActionRow>
              ))}
            </s-stack>
          </s-stack>
        </s-section>
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
