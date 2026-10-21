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
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import {
  activeSubscriptionIds,
  applySubscriptionUpdate,
  billingFrom,
  campaignsAffectedBy,
  isTestCharge,
  syncSubscription,
} from "../services/billing.server";
import { appHandle } from "../services/app-handle.server";
import { toAdminClient } from "../services/admin-client.server";
import { fetchShopBasics } from "../services/catalog-sync.server";
import { billingPlanName, planReturnUrl, trialDaysFor } from "../lib/billing/billing-api";
import { paysOn } from "../lib/billing/subscription-payload";
import { giftCardNote } from "../lib/billing/usage-line";
import { coverableCatalogue } from "../services/plan-usage.server";
import { ActionRow } from "../components/ActionRow";
import { isPlanId, PLAN_ORDER, PLANS, planFor, planPrice, type PlanId } from "../lib/billing/plans";
import { logger } from "../lib/logging/logger";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { Card } from "../components/Card";

export const loader = withGuard("/app/settings/plan", async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  // What Shopify says this shop pays on, before the row is read (#860). A merchant back
  // from approving a charge sees the plan they approved, whether or not the webhook has
  // landed yet.
  await syncSubscription(shop.id, toAdminClient(admin));

  const record = await prisma.shop.findUniqueOrThrow({
    where: { id: shop.id },
    select: {
      planTier: true,
      subscriptionGid: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      developerStore: true,
    },
  });

  const billing = billingFrom(record);
  // What a campaign could cover, as Home's meter counts it (#1075): gift cards were counted
  // here, so this page said 3,669 where a whole-catalogue campaign covered 3,665.
  const { variants, giftCards } = await coverableCatalogue(shop.id);

  // The plan this shop subscribes to. A development store has every feature whatever it
  // is on, but it still has a plan of its own, so a plan change made there -- App Review
  // trying the charge flow -- shows as one.
  const current: PlanId = record.developerStore ? planFor(record.planTier.toLowerCase()).id : billing.plan.id;
  const trialEndsAt = current !== "free" && record.trialEndsAt && record.trialEndsAt > new Date() ? record.trialEndsAt : null;

  // Shopify sends the merchant back with `charge_id` whether they approved or declined.
  // Approved is the charge the shop now pays on; anything else was not approved.
  const chargeId = new URL(request.url).searchParams.get("charge_id");
  const returned = chargeId
    ? record.subscriptionGid?.endsWith(`/${chargeId}`) && paysOn(record.subscriptionStatus)
      ? ("approved" as const)
      : ("declined" as const)
    : null;

  return {
    timeZone: shop.timezone,
    current,
    exempt: billing.exempt,
    testCharges: isTestCharge(record.developerStore),
    trialing: trialEndsAt !== null,
    trialEndsAt: trialEndsAt?.toISOString() ?? null,
    returned,
    variants,
    giftCards,
    // What would stop being startable on the free plan, so the downgrade copy is about
    // this merchant's campaigns rather than about plans in the abstract.
    affected: await campaignsAffectedBy(shop.id, PLANS.free),
    plans: PLAN_ORDER.map((id) => {
      const plan = PLANS[id];
      return {
        id,
        name: plan.name,
        // The amount alone. "/month" used to be glued on here, which put a unit in the
        // same text run as a number in a right-aligned column: "14.90/month" and
        // "Free" then aligned on the "h" of month rather than on the decimal, so the
        // one column a merchant compares down did not line up. The unit is a fact
        // about the column, so it is said once, in the header.
        price: planPrice(plan),
        variantLimit: plan.variantLimit,
        markets: plan.markets,
        b2b: plan.b2b,
        trialDays: plan.trialDays,
      };
    }),
  };
});

type ActionData = { ok: boolean; message: string };

/**
 * Changing plan (#860, App Store 1.2.3).
 *
 * A paid plan is a Billing API charge: `billing.request` creates it and sends the merchant
 * to Shopify's approval screen, which brings them back to this page. Free is the absence
 * of a subscription, so it cancels the one the shop has.
 */
export const action = withGuard("/app/settings/plan", async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { admin, session, billing } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const client = toAdminClient(admin);
  const form = await request.formData();
  const plan = String(form.get("plan") ?? "");
  if (!isPlanId(plan)) {
    return { ok: false, message: "That plan doesn't exist. Reload the page and choose one of the plans listed." };
  }

  // Asked of Shopify at the moment of charging, not read from the synced row: a reviewer
  // can open this page before the first catalogue sync has recorded what kind of store it is.
  const { developerStore } = await fetchShopBasics(admin);
  const isTest = isTestCharge(developerStore);

  if (plan === "free") {
    const ids = await activeSubscriptionIds(client);
    for (const subscriptionId of ids) {
      // Prorated, so the unused part of the month comes back to the merchant as a credit.
      await billing.cancel({ subscriptionId, isTest, prorate: true });
    }
    const last = ids.at(-1);
    if (last) await applySubscriptionUpdate(shop.id, { gid: last, status: "CANCELLED", planId: "free" });
    return {
      ok: true,
      message:
        ids.length > 0
          ? "Your subscription is cancelled and you're on Free. Running campaigns still finish, scheduled reverts included."
          : "You're on Free. There was no subscription to cancel.",
    };
  }

  const record = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id }, select: { trialEndsAt: true } });
  try {
    // Throws the redirect to Shopify's approval screen; nothing after it runs on success.
    await billing.request({
      plan: billingPlanName(plan),
      isTest,
      returnUrl: planReturnUrl(session.shop, await appHandle(client)),
      trialDays: trialDaysFor(plan, record.trialEndsAt),
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    const detail = (error as { errorData?: Array<{ message?: string }> })?.errorData?.[0]?.message;
    logger.error("billing request failed", { plan, reason: detail ?? (error instanceof Error ? error.message : "unknown") });
    return {
      ok: false,
      message:
        `Shopify didn't create the charge for ${PLANS[plan].name}${detail ? `: ${detail}` : ""}. ` +
        "Nothing was charged and your plan is unchanged. Try again, or contact support from Help if it keeps happening.",
    };
  }
  return { ok: false, message: "Shopify didn't return an approval page. Nothing was charged; try again." };
});

export default function PlanPage() {
  const { current, exempt, testCharges, trialing, trialEndsAt, returned, variants, giftCards, plans, affected, timeZone } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const choosing = fetcher.state !== "idle" ? String(fetcher.formData?.get("plan") ?? "") : "";
  const currentName = PLANS[current as keyof typeof PLANS].name;

  return (
    <PageShell heading="Plan">
      {exempt ? (
        <s-banner tone="info">
          <s-paragraph>
            This is a development store, so every feature is available and nothing is
            charged. Changing plan here creates a test charge: Shopify asks you to approve
            it, and no money moves.
          </s-paragraph>
        </s-banner>
      ) : testCharges ? (
        <s-banner tone="info">
          <s-paragraph>Plan changes on this deploy are test charges. No money moves.</s-paragraph>
        </s-banner>
      ) : null}

      {returned === "approved" ? (
        <s-banner tone="success">
          <s-paragraph>
            You&rsquo;re on {currentName}.{" "}
            {testCharges
              ? "It's a test charge, so nothing is billed."
              : `Shopify bills it with your store's invoice${trialing ? ", once the trial ends" : ""}.`}
          </s-paragraph>
        </s-banner>
      ) : returned === "declined" ? (
        <s-banner tone="warning">
          <s-paragraph>
            The charge wasn&rsquo;t approved, so nothing changed: you&rsquo;re still on {currentName}.
            Choose a plan again whenever you&rsquo;re ready.
          </s-paragraph>
        </s-banner>
      ) : null}

      {fetcher.data ? (
        <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
          <s-paragraph>{fetcher.data.message}</s-paragraph>
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

      <Card
        heading="Plans"
        lede={
          <>
            <s-text type="strong">
              You are on {currentName}
            </s-text>
            {" — "}
            {formatCount(variants)} variants in your catalogue.
            {giftCards > 0 ? ` ${giftCardNote(giftCards)}` : null}
          </>
        }
        secondary={
          <>
            Pricing is by how much of your catalogue a campaign manages and which
            surfaces it reaches &mdash; never by how many changes you make. Charging per
            change would tax the thing the app is for.
          </>
        }
      >

        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Plan</s-table-header>
            <s-table-header listSlot="secondary" format="currency">Price a month</s-table-header>
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

        {/* Every plan but the current one, each its own form. A paid plan goes to Shopify's
            approval screen and comes back here; Free cancels the subscription. The table
            above used to be the whole card, so "See plans" from Home led here and stopped
            -- and then to Shopify's 404, which is what App Review found (#860). */}
        <ActionRow>
          {plans
            .filter((plan) => plan.id !== current)
            .map((plan) => (
              <fetcher.Form method="post" key={plan.id}>
                <input type="hidden" name="plan" value={plan.id} />
                <s-button
                  type="submit"
                  variant={plan.id !== "free" && PLAN_ORDER.indexOf(plan.id) > PLAN_ORDER.indexOf(current) ? "primary" : "secondary"}
                  loading={choosing === plan.id || undefined}
                  disabled={(choosing !== "" && choosing !== plan.id) || undefined}
                >
                  {plan.id === "free" ? "Switch to Free" : `Switch to ${plan.name}`}
                </s-button>
              </fetcher.Form>
            ))}
        </ActionRow>
      </Card>

      <Card
        heading="Every plan, including free"
        lede={
          <>
            Preview before applying. Guardrails that refuse to price below cost or
            margin. The full history of every change, kept indefinitely. One-click
            rollback of a campaign or a single product.
          </>
        }
        secondary={
          <>
            None of that is ever paywalled. Charging for the ability to undo a mistake
            the app helped you make would be indefensible.
          </>
        }
      />

      <Card
        heading="If you downgrade"
        lede={
          <>
            Running campaigns finish, including their scheduled reverts. Nothing is
            deleted, nothing is paused, and no price is left on sale because a plan
            changed. A smaller plan limits what you can <s-text>start</s-text> next.
          </>
        }
      >

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
      </Card>
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
