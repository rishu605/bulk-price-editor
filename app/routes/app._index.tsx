import { formatDay, formatWhen } from "../lib/format/display";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { openNotices, resolveNotice } from "../services/markets-topology.server";
import { ensureShop, markSyncComplete } from "../services/shop.server";
import { fetchShopBasics, syncCatalog } from "../services/catalog-sync.server";
import { baselineHealth, captureBaselines } from "../services/baselines.server";
import { syncMarkets } from "../services/markets-sync.server";
import { syncCatalogViaBulk } from "../services/catalog-bulk-sync.server";
import { toAdminClient } from "../services/admin-client.server";
import { OnboardingCard } from "../components/OnboardingCard";
import { RouteBoundary } from "../components/RouteBoundary";
import { onboarding } from "../lib/onboarding/steps";
import { withGuard } from "../lib/errors/guard.server";

export const loader = withGuard("/app", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  // Counted in parallel and as aggregates, never by loading rows. This is the landing
  // page and it has a sub-second budget; a card that costs a table scan is a card that
  // makes the whole app feel slow.
  const [health, campaigns, live, upcoming, driftOpen, lastRun, recent] = await Promise.all([
    baselineHealth(shop.id),
    prisma.campaign.count({ where: { shopId: shop.id } }),
    prisma.campaign.count({ where: { shopId: shop.id, status: { in: ["ACTIVE", "APPLYING"] } } }),
    prisma.campaign.count({ where: { shopId: shop.id, status: "SCHEDULED" } }),
    prisma.driftEvent.count({ where: { shopId: shop.id, resolution: "PENDING" } }),
    prisma.campaignRun.findFirst({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        kind: true,
        status: true,
        verifiedRows: true,
        failedRows: true,
        finishedAt: true,
        campaign: { select: { id: true, name: true } },
      },
    }),
    prisma.auditLogEntry.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, actor: true, action: true, createdAt: true },
    }),
  ]);

  // Runs that need somebody: the number a merchant should act on, distinct from how
  // many campaigns exist.
  const [notices, needsAttention, cleanRuns, practiceCampaigns] = await Promise.all([
    openNotices(shop.id),
    prisma.campaign.count({ where: { shopId: shop.id, status: { in: ["PARTIAL", "HELD"] } } }),
    // The onboarding goal, asked of the data rather than of a dismissed flag: a
    // merchant who clicked past a step has not run a campaign cleanly.
    prisma.campaignRun.count({
      where: { shopId: shop.id, kind: "APPLY", status: "COMPLETED", verifiedRows: { gt: 0 } },
    }),
    prisma.campaign.count({ where: { shopId: shop.id, schedule: { path: ["practice"], equals: true } } }),
  ]);

  return {
    timeZone: shop.timezone,
    shopDomain: shop.domain,
    syncedAt: shop.initialSyncCompletedAt?.toISOString() ?? null,
    health: {
      ...health,
      oldestCapturedAt: health.oldestCapturedAt?.toISOString() ?? null,
    },
    campaigns,
    onboarding: onboarding({
      hasBaselines: health.withBaseline > 0,
      hasCampaign: campaigns > 0,
      hasPracticed: practiceCampaigns > 0,
      hasCleanRun: cleanRuns > 0,
    }),
    live,
    upcoming,
    driftOpen,
    notices: notices.map((notice) => ({
      id: notice.id,
      kind: notice.kind,
      name: notice.name,
      detail: notice.detail,
      campaigns: notice.campaignIds.length,
    })),
    needsAttention,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          kind: lastRun.kind,
          status: lastRun.status,
          verified: lastRun.verifiedRows,
          failed: lastRun.failedRows,
          finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          campaignId: lastRun.campaign.id,
          campaignName: lastRun.campaign.name,
        }
      : null,
    recent: recent.map((entry) => ({
      id: entry.id,
      actor: entry.actor,
      action: entry.action,
      at: entry.createdAt.toISOString(),
    })),
  };
});

export const action = withGuard("/app", async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "resolve-notice") {
    const resolution = String(form.get("resolution"));
    await resolveNotice(
      shop.id,
      String(form.get("noticeId")),
      resolution === "extended" || resolution === "removed" ? resolution : "ignored",
    );
    return { ok: true, message: "Thanks — that market question is settled." };
  }

  if (intent === "sync") {
    const basics = await fetchShopBasics(admin);
    await prisma.shop.update({
      where: { id: shop.id },
      data: { timezone: basics.timezone },
    });

    // Bulk first. One operation and a streamed result beats ten thousand paginated
    // round trips against a rate limit that allows a couple a second — and the
    // paginated path holds nothing back on a catalogue that does not fit in memory.
    const client = toAdminClient(admin);
    const bulk = await syncCatalogViaBulk(client, shop.id, basics.currency);

    // Falling back rather than failing. A shop already running a bulk operation, or a
    // catalogue Shopify declines to build a file for, still deserves a sync — and on a
    // small store the paginated path is perfectly adequate, which is what it is for.
    const sync =
      bulk.errors.length === 0 && bulk.written > 0
        ? { variants: bulk.written, products: bulk.products, errors: [] as string[] }
        : await syncCatalog(admin, shop.id, basics.currency);

    // After the catalogue, never alongside it: Shopify allows one bulk operation per
    // shop, and the market sync checks for a running one rather than racing it.
    const markets = await syncMarkets(client, shop.id);

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
        (markets.priceLists > 0
          ? `. Mirrored ${markets.priceLists} price list${markets.priceLists === 1 ? "" : "s"}` +
            (markets.relative > 0 ? ` (${markets.relative} derived from a percentage)` : "") +
            (markets.entries > 0 ? `, ${markets.entries} fixed prices` : "")
          : "") +
        ".",
      errors: sync.errors.slice(0, 5),
    };
  }

  // The unguarded store-wide recapture that used to live here is gone. It took one
  // click, warned generically, checked nothing, and would happily enshrine a live sale's
  // prices as a merchant's permanent normal. /app/baselines/recapture does the same job
  // with the scope, the overlap check and the typed confirmation it always needed.

  return { ok: false, message: `Unknown action: ${intent}`, errors: [] };
});

type ActionData = { ok: boolean; message: string; errors: string[] };

export default function Dashboard() {
  const {
    shopDomain,
    syncedAt,
    health,
    campaigns,
    onboarding: guide,
    live,
    upcoming,
    driftOpen,
    notices,
    needsAttention,
    lastRun,
    recent,
    timeZone,
  } = useLoaderData<typeof loader>();
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

      <OnboardingCard state={guide} />

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
            <s-button type="submit" variant="primary" loading={busy || undefined}>
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

          {health.withBaseline > health.variants ? (
            <s-paragraph>
              <s-text>
                More baselines than variants is expected: baselines are kept for products
                you have deleted, so a campaign that priced them can still be explained
                and reverted.
              </s-text>
            </s-paragraph>
          ) : null}

          {notices.length > 0 ? (
            <s-banner tone="warning">
              <s-heading>Your markets changed</s-heading>
              {notices.map((notice) => (
                <s-stack key={notice.id} gap="small">
                  <s-paragraph>{notice.detail}</s-paragraph>
                  <s-stack direction="inline" gap="base">
                    {notice.kind === "added" ? (
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="resolve-notice" />
                        <input type="hidden" name="noticeId" value={notice.id} />
                        <input type="hidden" name="resolution" value="extended" />
                        <s-button type="submit" loading={busy || undefined}>
                          Add it to {notice.campaigns === 1 ? "that campaign" : "those campaigns"}
                        </s-button>
                      </fetcher.Form>
                    ) : (
                      <fetcher.Form method="post">
                        <input type="hidden" name="intent" value="resolve-notice" />
                        <input type="hidden" name="noticeId" value={notice.id} />
                        <input type="hidden" name="resolution" value="removed" />
                        <s-button type="submit" loading={busy || undefined}>
                          Remove it from{" "}
                          {notice.campaigns === 1 ? "that campaign" : "those campaigns"}
                        </s-button>
                      </fetcher.Form>
                    )}

                    <fetcher.Form method="post">
                      <input type="hidden" name="intent" value="resolve-notice" />
                      <input type="hidden" name="noticeId" value={notice.id} />
                      <input type="hidden" name="resolution" value="ignored" />
                      <s-button type="submit" variant="tertiary" loading={busy || undefined}>
                        Leave it as it is
                      </s-button>
                    </fetcher.Form>
                  </s-stack>
                </s-stack>
              ))}
            </s-banner>
          ) : null}

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
              <s-button type="submit" loading={busy || undefined}>
                Re-sync catalogue
              </s-button>
            </fetcher.Form>
            <s-link href="/app/catalog">Browse variants and baselines</s-link>
          </s-stack>
        </s-section>
      )}

      {!neverSynced ? (
        <s-section heading="What is live right now">
          <s-stack direction="inline" gap="large">
            <s-box>
              <s-text>Campaigns running</s-text>
              <s-heading>{live}</s-heading>
            </s-box>
            <s-box>
              <s-text>Scheduled</s-text>
              <s-heading>{upcoming}</s-heading>
            </s-box>
            <s-box>
              <s-text>Need attention</s-text>
              <s-heading>{needsAttention}</s-heading>
            </s-box>
            <s-box>
              <s-text>Prices changed outside the app</s-text>
              <s-heading>{driftOpen}</s-heading>
            </s-box>
          </s-stack>

          {live === 0 && upcoming === 0 && campaigns === 0 ? (
            <s-paragraph>
              <s-text>
                No campaigns yet. A <strong>campaign</strong> is a rule — “20% off
                everything tagged Summer” — plus when it should run. Anchor computes each
                price from that variant&rsquo;s baseline, so running it twice changes
                nothing the second time, and ending it puts prices back exactly.
              </s-text>
            </s-paragraph>
          ) : null}

          {needsAttention > 0 ? (
            <s-banner tone="warning">
              <s-paragraph>
                {needsAttention} campaign{needsAttention === 1 ? "" : "s"} did not finish
                cleanly. Every row that did not complete has a reason recorded, and
                resuming retries only those.
              </s-paragraph>
            </s-banner>
          ) : null}

          {driftOpen > 0 ? (
            <s-banner tone="info">
              <s-paragraph>
                {driftOpen} price{driftOpen === 1 ? " was" : "s were"} changed somewhere
                other than Anchor while a campaign was running. Those edits were
                deliberate, so nothing has been overwritten — each is waiting on your
                decision.
              </s-paragraph>
            </s-banner>
          ) : null}

          {lastRun ? (
            <s-paragraph>
              <s-text>
                Last run: {lastRun.kind.toLowerCase()} of “{lastRun.campaignName}” —{" "}
                {lastRun.status.toLowerCase()}, {lastRun.verified} verified
                {lastRun.failed > 0 ? `, ${lastRun.failed} failed` : ""}
                {lastRun.finishedAt
                  ? ` on ${formatWhen(lastRun.finishedAt, timeZone)}`
                  : " (still running)"}
                .
              </s-text>
            </s-paragraph>
          ) : (
            <s-paragraph>
              <s-text>
                Nothing has been applied to your storefront yet. Every run records what it
                changed, row by row, and stays readable for as long as you have the app.
              </s-text>
            </s-paragraph>
          )}

          <s-stack direction="inline" gap="base">
            <s-link href="/app/campaigns">Campaigns</s-link>
            <s-link href="/app/drift">Drift queue</s-link>
            <s-link href="/app/activity">Activity log</s-link>
          </s-stack>
        </s-section>
      ) : null}

      <s-section slot="aside" heading="Store">
        <s-paragraph>{shopDomain}</s-paragraph>
        <s-paragraph>
          <s-text>
            {syncedAt ? `Last synced ${formatWhen(syncedAt, timeZone)}` : "Not yet synced"}
          </s-text>
        </s-paragraph>
      </s-section>

      {!neverSynced && recent.length > 0 ? (
        <s-section slot="aside" heading="Recent activity">
          {recent.map((entry) => (
            <s-paragraph key={entry.id}>
              <s-text>
                {entry.action} · {entry.actor ?? "Scheduler"} ·{" "}
                {formatWhen(entry.at, timeZone)}
              </s-text>
            </s-paragraph>
          ))}
          <s-link href="/app/activity">See everything</s-link>
        </s-section>
      ) : null}

      {!neverSynced ? (
        <s-section slot="aside" heading="Baselines">
          <s-paragraph>
            <s-text>
              {health.oldestCapturedAt
                ? `Oldest captured ${formatDay(health.oldestCapturedAt, timeZone)}`
                : "None captured"}
            </s-text>
          </s-paragraph>
          <s-paragraph>
            <s-text>
              Recapturing replaces baselines with today&rsquo;s live prices. Done while a
              sale is running it makes the sale price the new normal, permanently — so it
              has its own page, which shows you which campaigns your scope would catch
              before anything is replaced.
            </s-text>
          </s-paragraph>
          {/* A link, not a button. One click from the dashboard was not enough ceremony
              for the most destructive operation in the app. */}
          <s-link href="/app/baselines/recapture">Recapture baselines…</s-link>
        </s-section>
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
