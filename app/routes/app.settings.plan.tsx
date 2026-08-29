/**
 * Plans, and what a downgrade will and will not do.
 *
 * The downgrade copy is the important part. A merchant deciding whether to drop a tier
 * needs to know, before they click, that their running campaigns will still revert and
 * their history will still be there — because the fear that they will not is what makes
 * people keep paying resentfully and then leave a one-star review about it.
 */

import { formatCount, formatDay } from "../lib/format/display";
import { Blank } from "../components/Blank";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { billingFrom, campaignsAffectedBy } from "../services/billing.server";
import { PLAN_ORDER, PLANS } from "../lib/billing/plans";
import { formatMinorUnits } from "../lib/money/format";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";

export const loader = withGuard("/app/settings/plan", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const record = await prisma.shop.findUniqueOrThrow({
    where: { id: shop.id },
    select: {
      planTier: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      developerStore: true,
    },
  });

  const billing = billingFrom(record);
  const variants = await prisma.variantIndex.count({
    where: { shopId: shop.id, deletedAt: null },
  });

  return {
    timeZone: shop.timezone,
    current: billing.plan.id,
    exempt: billing.exempt,
    trialing: billing.trialing,
    trialEndsAt: billing.trialEndsAt?.toISOString() ?? null,
    variants,
    // What would stop being startable on the free plan, so the downgrade copy is about
    // this merchant's campaigns rather than about plans in the abstract.
    affected: await campaignsAffectedBy(shop.id, PLANS.free),
    plans: PLAN_ORDER.map((id) => {
      const plan = PLANS[id];
      return {
        id,
        name: plan.name,
        price: plan.priceMinor === 0 ? "Free" : `${formatMinorUnits(BigInt(plan.priceMinor), "USD")}/month`,
        variantLimit: plan.variantLimit,
        markets: plan.markets,
        b2b: plan.b2b,
        trialDays: plan.trialDays,
      };
    }),
  };
});

export default function PlanPage() {
  const { current, exempt, trialing, trialEndsAt, variants, plans, affected, timeZone } =
    useLoaderData<typeof loader>();

  return (
    <PageShell heading="Plan">
      {exempt ? (
        <s-banner tone="info">
          <s-paragraph>
            This is a development store, so every feature is available and nothing is
            charged.
          </s-paragraph>
        </s-banner>
      ) : null}

      {trialing && trialEndsAt ? (
        <s-banner tone="info">
          <s-paragraph>
            Your trial runs until {formatDay(trialEndsAt, timeZone)}.
          </s-paragraph>
        </s-banner>
      ) : null}

      {/* Three cards, and this one answers "what am I on" before "what else is there".

          It was four. The first held a single line — a card, a heading and a border to
          carry eight words, with the table it is about in a different box. A card is a
          container for content; one sentence is not content, it is a lead, so it is the
          lead of the card it was describing.

          It was briefly two: "Every plan, including free" is a footnote to the table and
          was folded in as a sub-heading. That rendered the table as `s-table`'s stacked
          list — headers gone, one block per plan — and it is back in its own section
          because a table that reads correctly beats a card saved. The write-up is in
          `docs/polaris-notes.md`; **do not re-merge these two without loading the page.** */}

      <s-section heading="Plans">
        <s-paragraph>
          <s-text type="strong">
            You are on {PLANS[current as keyof typeof PLANS].name}
          </s-text>
          {" — "}
          <s-text color="subdued">
            {formatCount(variants)} variants in your catalogue.
          </s-text>
        </s-paragraph>

        <s-paragraph>
          <s-text>
            Pricing is by how much of your catalogue a campaign manages and which
            surfaces it reaches &mdash; never by how many changes you make. Charging per
            change would tax the thing the app is for.
          </s-text>
        </s-paragraph>

        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Plan</s-table-header>
            <s-table-header listSlot="secondary" format="currency">Price</s-table-header>
            {/* Numeric, and it holds "Unlimited" on the top plan. A ceiling and the
                absence of one belong in the same column, right-aligned together: the
                comparison a merchant is making down this column is how far each plan
                lets them go. */}
            <s-table-header listSlot="inline" format="numeric">Variants</s-table-header>
            <s-table-header listSlot="labeled">Markets</s-table-header>
            <s-table-header listSlot="labeled">Wholesale</s-table-header>
            <s-table-header listSlot="labeled">Trial</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {plans.map((plan) => (
              <s-table-row key={plan.id}>
                <s-table-cell>
                  {plan.name}
                  {plan.id === current ? " · yours" : ""}
                </s-table-cell>
                <s-table-cell>{plan.price}</s-table-cell>
                <s-table-cell>
                  {plan.variantLimit === null
                    ? "Unlimited"
                    : formatCount(plan.variantLimit)}
                </s-table-cell>
                <s-table-cell>{plan.markets ? "Yes" : <Blank />}</s-table-cell>
                <s-table-cell>{plan.b2b ? "Yes" : <Blank />}</s-table-cell>
                <s-table-cell>{plan.trialDays > 0 ? `${plan.trialDays} days` : <Blank />}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Every plan, including free">
        <s-paragraph>
          <s-text>
            Preview before applying. Guardrails that refuse to price below cost or
            margin. The full history of every change, kept indefinitely. One-click
            rollback of a campaign or a single product.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            None of that is ever paywalled. Charging for the ability to undo a mistake
            the app helped you make would be indefensible.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section heading="If you downgrade">
        <s-paragraph>
          <s-text>
            Running campaigns finish, including their scheduled reverts. Nothing is
            deleted, nothing is paused, and no price is left on sale because a plan
            changed. A smaller plan limits what you can <s-text>start</s-text> next.
          </s-text>
        </s-paragraph>

        {affected.length > 0 ? (
          <>
            <s-paragraph>
              <s-text>
                On the free plan these campaigns could not be started again as they are:
              </s-text>
            </s-paragraph>
            <s-unordered-list>
              {affected.map((campaign) => (
                <s-list-item key={campaign.id}>
                  {campaign.name} &mdash; {campaign.reason}
                </s-list-item>
              ))}
            </s-unordered-list>
          </>
        ) : null}
      </s-section>
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
