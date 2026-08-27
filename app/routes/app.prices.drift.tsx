import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { pendingDrift, resolveDrift, type DriftResolution } from "../services/drift.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

export const loader = withGuard("/app/prices/drift", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  return { events: await pendingDrift(shop.id) };
});

export const action = withGuard("/app/prices/drift", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const eventId = String(form.get("eventId"));
  const resolution = String(form.get("resolution")) as DriftResolution;

  await resolveDrift(shop.id, eventId, resolution, session.shop);

  const wording: Record<DriftResolution, string> = {
    adopt: "Adopted as the new baseline. Future campaigns compute from this price.",
    reassert: "Marked for reassertion. The campaign will rewrite this price on its next run.",
    ignore: "Ignored. The price stays as the merchant left it.",
  };

  return { ok: true, message: wording[resolution] };
});

type ActionData = { ok: boolean; message: string };

export default function DriftQueue() {
  const { events } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  return (
    <s-page heading="Price drift">
      {fetcher.data ? (
        <s-banner tone="success">
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section>
        {events.length === 0 ? (
          <s-paragraph>
            No drift detected. Prices set by your campaigns are still in place.
          </s-paragraph>
        ) : (
          <>
            <s-paragraph>
              These prices changed outside Anchor while a campaign was running. Someone
              did that deliberately, so nothing has been overwritten — choose what
              should happen to each.
            </s-paragraph>

            <s-table>
              <s-table-header-row>
                <s-table-header>Variant</s-table-header>
                <s-table-header>Campaign set</s-table-header>
                <s-table-header>Now shows</s-table-header>
                <s-table-header>Campaign</s-table-header>
                <s-table-header>Resolve</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {events.map((event) => (
                  <s-table-row key={event.id}>
                    <s-table-cell>{event.title}</s-table-cell>
                    <s-table-cell>{event.expected ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone="warning">{event.observed ?? "—"}</s-badge>
                    </s-table-cell>
                    <s-table-cell>{event.campaignName ?? "—"}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small">
                        {(["adopt", "reassert", "ignore"] as const).map((resolution) => (
                          <fetcher.Form method="post" key={resolution}>
                            <input type="hidden" name="eventId" value={event.id} />
                            <input type="hidden" name="resolution" value={resolution} />
                            <s-button type="submit" loading={busy || undefined}>
                              {resolution}
                            </s-button>
                          </fetcher.Form>
                        ))}
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </>
        )}
      </s-section>

      <s-section slot="aside" heading="What the three choices do">
        <s-paragraph>
          <strong>Adopt</strong> makes the new price the baseline. Use it when the edit
          was a permanent repricing — every future campaign will compute from it.
        </s-paragraph>
        <s-paragraph>
          <strong>Reassert</strong> puts the campaign price back on the next run. Use it
          when the edit was a mistake.
        </s-paragraph>
        <s-paragraph>
          <strong>Ignore</strong> leaves the price alone this time and closes the alert.
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Only adopt changes what future campaigns compute from, so it is the one
            worth being sure about.
          </s-text>
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
