import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const campaigns = await prisma.campaign.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    include: {
      runs: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  return {
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      priority: c.priority,
      createdAt: c.createdAt.toISOString(),
      lastRun: c.runs[0]
        ? {
            kind: c.runs[0].kind,
            status: c.runs[0].status,
            verified: c.runs[0].verifiedRows,
            failed: c.runs[0].failedRows,
          }
        : null,
    })),
  };
};

type Tone = "info" | "success" | "critical" | "neutral" | "warning" | "caution" | "auto";

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: "neutral",
  ACTIVE: "success",
  PARTIAL: "warning",
  COMPLETED: "info",
  HELD: "warning",
};

export default function CampaignList() {
  const { campaigns } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Campaigns">
      <s-section>
        <s-stack direction="inline" gap="base">
          <s-link href="/app/campaigns/new">
            <s-button variant="primary">Create campaign</s-button>
          </s-link>
        </s-stack>

        {campaigns.length === 0 ? (
          <s-paragraph>
            No campaigns yet. A campaign is a rule (&ldquo;20% off this collection&rdquo;)
            plus the set of variants it applies to. Nothing is written to your
            storefront until you apply it, and you can preview the exact result first.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Campaign</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Priority</s-table-header>
              <s-table-header>Last run</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {campaigns.map((campaign) => (
                <s-table-row key={campaign.id}>
                  <s-table-cell>{campaign.name}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[campaign.status] ?? "neutral"}>
                      {campaign.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{campaign.priority}</s-table-cell>
                  <s-table-cell>
                    {campaign.lastRun
                      ? `${campaign.lastRun.kind} · ${campaign.lastRun.status} · ${campaign.lastRun.verified} verified${
                          campaign.lastRun.failed > 0
                            ? `, ${campaign.lastRun.failed} failed`
                            : ""
                        }`
                      : "—"}
                  </s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/campaigns/${campaign.id}`}>Open</s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="How campaigns resolve">
        <s-paragraph>
          When two campaigns cover the same variant, exactly one wins — the higher
          priority, then the more recent. They never stack, so a variant cannot end
          up discounted twice.
        </s-paragraph>
        <s-paragraph>
          Reverting recomputes rather than restoring saved numbers. If another
          campaign still covers a variant, that campaign&rsquo;s price stays in place.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
