import { formatAgo, formatCount, formatDay } from "../lib/format/display";
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
import { ActionRow } from "../components/ActionRow";
import { ActivityFeed } from "../components/ActivityFeed";
import { CountsRow } from "../components/CountsRow";
import { LastRunSummary } from "../components/LastRunSummary";
import { UpcomingCampaigns } from "../components/UpcomingCampaigns";
import { RouteBoundary } from "../components/RouteBoundary";
import { onboarding } from "../lib/onboarding/steps";
import { homeSections } from "../lib/dashboard/home";
import { nextMoments } from "../lib/scheduling/upcoming";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { SPACE } from "../lib/ui/spacing";

export const loader = withGuard("/app", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  // Counted in parallel and as aggregates, never by loading rows. This is the landing
  // page and it has a sub-second budget; a card that costs a table scan is a card that
  // makes the whole app feel slow.
  const [health, campaigns, live, upcoming, driftOpen, lastRun, recent, scheduled] =
    await Promise.all([
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
    // Campaigns with a start or an end still ahead of them. Which of the two is next
    // depends on where the clock is, so the rows are narrowed here and ordered in
    // `nextMoments` — the database can sort by a column, not by "whichever of these two
    // has not happened yet". A handful more than the four shown, because a campaign
    // matching this filter may still have both its moments behind it.
    prisma.campaign.findMany({
      where: {
        shopId: shop.id,
        status: { in: ["SCHEDULED", "APPLYING", "ACTIVE"] },
        OR: [{ startAt: { gt: new Date() } }, { endAt: { gt: new Date() } }],
      },
      orderBy: { startAt: "asc" },
      take: 8,
      select: { id: true, name: true, status: true, startAt: true, endAt: true },
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
    // The page's clock, sent with the page. Relative times ("2 hours ago") are computed
    // from this rather than from `Date.now()` at render, so the server's HTML and the
    // browser's hydration agree instead of straddling a minute boundary.
    now: new Date().toISOString(),
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
    upcomingMoments: nextMoments(
      scheduled.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        status: campaign.status,
        startAt: campaign.startAt?.toISOString() ?? null,
        endAt: campaign.endAt?.toISOString() ?? null,
      })),
      new Date().toISOString(),
    ),
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
      data: {
        timezone: basics.timezone,
        // Recorded at sync, because it is the answer to "which plan applies" and the
        // exemption for it was unreachable until now: `billingFrom` grants a development
        // store the top tier, and nothing ever set the flag, so every dev store fell to
        // Free and its 500-variant cap. Shopify's own reviewers evaluate on development
        // stores, so the first campaign they tried would have been refused.
        developerStore: basics.developerStore,
      },
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
    now,
    shopDomain,
    syncedAt,
    health,
    campaigns,
    onboarding: guide,
    live,
    upcoming,
    upcomingMoments,
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
  // Which sections this page shows, decided in one tested place rather than in four
  // conditionals spread through the markup below. Each of those rules exists because of
  // a specific way this page used to embarrass itself; see `homeSections`.
  const sections = homeSections({
    neverSynced,
    campaigns,
    hasRun: lastRun !== null,
    onboardingComplete: guide.complete,
  });

  return (
    <PageShell heading="Home">
      {result ? (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.errors.map((error) => (
            <s-paragraph key={error}>{error}</s-paragraph>
          ))}
        </s-banner>
      ) : null}

      {/* Everything that wants the merchant, at the top and together.

          These four used to be filed inside whichever section they were about — two in
          Catalogue, two in what-is-live — which meant "2 campaigns did not finish
          cleanly" was reachable by scrolling and reading the section headings to work out
          where it would have been put. Grouping them is not decoration: a dashboard's
          first job is to say whether anything needs doing, and it cannot do that while
          the answer is distributed. */}
      {needsAttention > 0 ? (
        <s-banner tone="warning" heading="Some campaigns did not finish cleanly">
          <s-paragraph>
            {formatCount(needsAttention)} campaign{needsAttention === 1 ? "" : "s"} stopped part
            way. Every row that did not complete has a reason recorded, and resuming retries only
            those.
          </s-paragraph>
          <ActionRow>
            <s-button href="/app/campaigns">Review campaigns</s-button>
          </ActionRow>
        </s-banner>
      ) : null}

      {notices.length > 0 ? (
        <s-banner tone="warning" heading="Your markets changed">
          {notices.map((notice) => (
            <s-stack key={notice.id} gap={SPACE.item}>
              <s-paragraph>{notice.detail}</s-paragraph>
              <ActionRow>
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
              </ActionRow>
            </s-stack>
          ))}
        </s-banner>
      ) : null}

      {health.missing > 0 ? (
        <s-banner tone="warning" heading="Some variants have no baseline">
          <s-paragraph>
            {formatCount(health.missing)} variants cannot be included in a campaign until they have
            one. Re-syncing captures them.
          </s-paragraph>
        </s-banner>
      ) : null}

      {driftOpen > 0 ? (
        <s-banner tone="info" heading="Prices changed outside Anchor">
          <s-paragraph>
            {formatCount(driftOpen)} price{driftOpen === 1 ? " was" : "s were"} changed somewhere
            else while a campaign was running. Those edits were deliberate, so nothing has been
            overwritten — each is waiting on your decision.
          </s-paragraph>
          <ActionRow>
            <s-button href="/app/prices/drift">Open the drift queue</s-button>
          </ActionRow>
        </s-banner>
      ) : null}

      {/* Before the numbers while it is unfinished, and gone once it is. The card
          retires itself, so this ordering says "your next step first" to a new shop and
          "your storefront first" to an established one without a conditional. */}
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
      ) : null}

      {/* Only when there is something live to report.

          It used to render unconditionally, so a shop that had synced and not yet made a
          campaign got four tiles reading 0, 0, 0, 0 and two paragraphs explaining that
          nothing had happened — the largest block on the page, spent saying "nothing".
          The checklist above is already answering "what now", and answering it with an
          action rather than with four zeroes. */}
      {sections.live ? (
        <s-section heading="What is live right now">
          <CountsRow
            items={[
              { label: "Campaigns running", value: live },
              { label: "Scheduled", value: upcoming },
              { label: "Need attention", value: needsAttention },
              // Two words. "Prices changed outside the app" wrapped to three lines in
              // this column and "Changed outside Anchor" to two, either of which makes
              // its tile taller than the three beside it.
              { label: "Changed elsewhere", value: driftOpen },
            ]}
          />

          {lastRun ? (
            <s-stack gap={SPACE.item}>
              <s-text color="subdued">Last run</s-text>
              <LastRunSummary run={lastRun} now={now} timeZone={timeZone} />
            </s-stack>
          ) : null}

          {/* The page's forward action, and the only one that survives the checklist
              retiring itself. Black only once the checklist has gone: while it is still
              up, its own next step is what the page is pointing at, and two black buttons
              point at nothing. */}
          <ActionRow>
            <s-button
              variant={sections.createIsPrimary ? "primary" : "secondary"}
              href="/app/campaigns/new"
            >
              Create campaign
            </s-button>
            <s-button variant="tertiary" href="/app/campaigns">Campaigns</s-button>
            <s-button variant="tertiary" href="/app/prices/drift">Drift queue</s-button>
            <s-button variant="tertiary" href="/app/activity">Activity log</s-button>
          </ActionRow>
        </s-section>
      ) : null}

      {/* What is about to happen, which "Scheduled: 1" could not say. Only when there is
          something ahead — an empty "nothing is scheduled" card is the same mistake as the
          four zeroes this page used to open with. */}
      {upcomingMoments.length > 0 ? (
        <s-section heading="Next up">
          <UpcomingCampaigns
            moments={upcomingMoments}
            now={now}
            timeZone={timeZone}
          />
        </s-section>
      ) : null}

      {/* The one case the checklist does not cover: everything on it is done, and the
          campaigns it was done with have since been deleted. */}
      {sections.emptyState ? (
        <s-section heading="What is live right now">
          <s-paragraph>
            <s-text>
              Nothing is running. A <strong>campaign</strong> is a rule — “20% off
              everything tagged Summer” — plus when it should run. Anchor computes each
              price from that variant&rsquo;s baseline, so running it twice changes
              nothing the second time, and ending it puts prices back exactly.
            </s-text>
          </s-paragraph>
          <ActionRow>
            <s-button variant="primary" href="/app/campaigns/new">
              Create a campaign
            </s-button>
          </ActionRow>
        </s-section>
      ) : null}

      {sections.catalogue ? (
        <s-section heading="Catalogue">
          {/* The shared component, not a second copy of its markup. This page had
              hand-rolled the same four tiles, so it kept the old flat look after the
              real one gained borders and equal columns -- and it is the first screen
              after installing, which is the worst place to be a version behind.

              Three tiles, not four. "Campaigns" was the fourth and it is a fact about
              campaigns, which the section above is entirely about. */}
          <CountsRow
            items={[
              { label: "Variants", value: health.variants },
              { label: "With a baseline", value: health.withBaseline },
              { label: "Not at baseline", value: health.drifted },
            ]}
          />

          {/* The coverage bar that used to sit here is gone. Every background token a
              box can take is a near-white grey, so at 100% — which is where a healthy
              shop lives — a full bar and an empty one were the same picture. The two
              tiles above are the same fact, unambiguously. */}
          <s-stack gap={SPACE.tight}>
            <s-text color="subdued">Oldest baseline captured</s-text>
            <s-text>
              {health.oldestCapturedAt
                ? formatDay(health.oldestCapturedAt, timeZone)
                : "None captured"}
            </s-text>
          </s-stack>

          {health.withBaseline > health.variants ? (
            <s-paragraph>
              <s-text color="subdued">
                More baselines than variants is expected: baselines are kept for products
                you have deleted, so a campaign that priced them can still be explained
                and reverted.
              </s-text>
            </s-paragraph>
          ) : null}

          <ActionRow>
            <s-button variant="tertiary" href="/app/prices">
              Browse variants and baselines
            </s-button>
            {/* Tertiary, and the only action on this page deliberately kept quiet. One
                click was not enough ceremony for the most destructive operation in the
                app, and a bordered button next to the coverage figure would read as the
                thing to do about it. */}
            <s-button variant="tertiary" href="/app/imports/recapture">
              Recapture baselines…
            </s-button>
          </ActionRow>
        </s-section>
      ) : null}

      <s-section slot="aside" heading="Store">
        <s-stack gap={SPACE.section}>
          <s-grid gridTemplateColumns="auto 1fr" gap={SPACE.item} alignItems="center">
            <s-icon type="store" color="subdued" />
            <s-text type="strong">{shopDomain}</s-text>
          </s-grid>

          {/* Label above value, the same shape as a stat tile without the box. Two loose
              paragraphs said the same words and left the reader to work out which of them
              was the label. */}
          <s-stack gap={SPACE.tight}>
            <s-text color="subdued">Last synced</s-text>
            <s-text>{syncedAt ? formatAgo(syncedAt, now, timeZone) : "Not yet synced"}</s-text>
          </s-stack>

          {/* The action belongs with the fact it acts on. It used to sit in the catalogue
              card, two columns away from the sentence saying how stale the catalogue
              was. */}
          {!neverSynced ? (
            <ActionRow>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="sync" />
                <s-button type="submit" loading={busy || undefined}>
                  Re-sync catalogue
                </s-button>
              </fetcher.Form>
            </ActionRow>
          ) : null}
        </s-stack>
      </s-section>

      {!neverSynced && recent.length > 0 ? (
        <s-section slot="aside" heading="Recent activity">
          <s-stack gap={SPACE.section}>
            <ActivityFeed entries={recent} now={now} timeZone={timeZone} />
            <ActionRow>
              <s-button variant="tertiary" icon="arrow-right" href="/app/activity">
                See everything
              </s-button>
            </ActionRow>
          </s-stack>
        </s-section>
      ) : null}
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
