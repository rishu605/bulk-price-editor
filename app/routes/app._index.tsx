import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop, markSyncComplete } from "../services/shop.server";
import { fetchShopBasics, syncCatalog } from "../services/catalog-sync.server";
import { baselineHealth, captureBaselines } from "../services/baselines.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [health, campaigns] = await Promise.all([
    baselineHealth(shop.id),
    prisma.campaign.count({ where: { shopId: shop.id } }),
  ]);

  return {
    shopDomain: shop.domain,
    syncedAt: shop.initialSyncCompletedAt?.toISOString() ?? null,
    health: {
      ...health,
      oldestCapturedAt: health.oldestCapturedAt?.toISOString() ?? null,
    },
    campaigns,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "sync") {
    const basics = await fetchShopBasics(admin);
    await prisma.shop.update({
      where: { id: shop.id },
      data: { timezone: basics.timezone },
    });

    const sync = await syncCatalog(admin, shop.id, basics.currency);

    // Capture baselines immediately: a variant with no baseline cannot be priced by
    // a campaign, and capturing at sync time is the only moment we can be confident
    // the live price is the merchant's normal price.
    const capture = await captureBaselines(shop.id);
    await markSyncComplete(shop.id);

    return {
      ok: sync.errors.length === 0,
      message:
        `Synced ${sync.variants} variants across ${sync.products} products. ` +
        `Captured ${capture.captured} baselines` +
        (capture.alreadyCurrent > 0 ? `, ${capture.alreadyCurrent} already current` : "") +
        ".",
      errors: sync.errors.slice(0, 5),
    };
  }

  if (intent === "recapture") {
    const capture = await captureBaselines(shop.id, {
      recapture: true,
      source: "RECAPTURE",
      capturedBy: session.shop,
    });
    return {
      ok: true,
      message: `Recaptured ${capture.captured} baselines (${capture.superseded} superseded).`,
      errors: [],
    };
  }

  return { ok: false, message: `Unknown action: ${intent}`, errors: [] };
};

type ActionData = { ok: boolean; message: string; errors: string[] };

export default function Dashboard() {
  const { shopDomain, syncedAt, health, campaigns } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  const neverSynced = syncedAt === null;

  return (
    <s-page heading="Anchor">
      {result ? (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.errors.map((error) => (
            <s-paragraph key={error}>{error}</s-paragraph>
          ))}
        </s-banner>
      ) : null}

      {neverSynced ? (
        <s-section heading="Start by capturing your baselines">
          <s-paragraph>
            Anchor computes every price change from a <strong>baseline</strong> — a
            stored reference price for each variant — rather than from whatever price
            happens to be live. That is what makes running a campaign twice safe, and
            what makes reverting exact.
          </s-paragraph>
          <s-paragraph>
            Syncing reads your catalogue and records today&rsquo;s prices as those
            baselines. Nothing on your storefront is changed.
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="sync" />
            <s-button type="submit" variant="primary" loading={busy}>
              {busy ? "Syncing…" : "Sync catalogue and capture baselines"}
            </s-button>
          </fetcher.Form>
        </s-section>
      ) : (
        <s-section heading="Catalogue">
          <s-stack direction="inline" gap="large">
            <s-box>
              <s-text>Variants</s-text>
              <s-heading>{health.variants}</s-heading>
            </s-box>
            <s-box>
              <s-text>With baseline</s-text>
              <s-heading>{health.withBaseline}</s-heading>
            </s-box>
            <s-box>
              <s-text>Not at baseline</s-text>
              <s-heading>{health.drifted}</s-heading>
            </s-box>
            <s-box>
              <s-text>Campaigns</s-text>
              <s-heading>{campaigns}</s-heading>
            </s-box>
          </s-stack>

          {health.missing > 0 ? (
            <s-banner tone="warning">
              <s-paragraph>
                {health.missing} variants have no baseline yet and cannot be included
                in a campaign. Re-sync to capture them.
              </s-paragraph>
            </s-banner>
          ) : null}

          <s-stack direction="inline" gap="base">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <s-button type="submit" loading={busy}>
                Re-sync catalogue
              </s-button>
            </fetcher.Form>
            <s-link href="/app/catalog">Browse variants and baselines</s-link>
          </s-stack>
        </s-section>
      )}

      <s-section slot="aside" heading="Store">
        <s-paragraph>{shopDomain}</s-paragraph>
        <s-paragraph>
          <s-text>
            {syncedAt ? `Last synced ${new Date(syncedAt).toLocaleString()}` : "Not yet synced"}
          </s-text>
        </s-paragraph>
      </s-section>

      {!neverSynced ? (
        <s-section slot="aside" heading="Baselines">
          <s-paragraph>
            <s-text>
              {health.oldestCapturedAt
                ? `Oldest captured ${new Date(health.oldestCapturedAt).toLocaleDateString()}`
                : "None captured"}
            </s-text>
          </s-paragraph>
          <s-paragraph>
            Recapturing replaces every baseline with today&rsquo;s live prices. Do not
            do this while a sale is running — it would make the sale prices your new
            normal, permanently.
          </s-paragraph>
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="recapture" />
            <s-button type="submit" tone="critical" loading={busy}>
              Recapture all baselines
            </s-button>
          </fetcher.Form>
        </s-section>
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
