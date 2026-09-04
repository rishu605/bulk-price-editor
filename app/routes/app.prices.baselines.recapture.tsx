/**
 * Recapture: replacing baselines with today's live prices.
 *
 * Its own page rather than a button on the dashboard, because it is the most
 * destructive thing this app can do and a button next to a paragraph is not enough
 * ceremony for it. Recapturing during a sale makes the sale prices the merchant's
 * normal prices, permanently, for every campaign afterwards — and nothing undoes that
 * except reading superseded history and typing the old numbers back.
 *
 * The page's job is to make the merchant see which running campaigns their scope would
 * enshrine, by name and by count, before they can proceed.
 *
 * It sits under Baselines now rather than under an "Imports" nav item, because that is
 * the thing it rewrites. It stayed a page of its own when the baseline *import* folded
 * into the browser beside it, for two reasons that both still hold: the ceremony above,
 * and `planRecapture` — which counts a scope that can be half a million variants and
 * cross-references every running campaign. Paying for that on every visit to a page a
 * merchant opens to look something up is not a trade worth making for one fewer URL.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { planRecapture, recapture } from "../services/recapture.server";
import { actorFor } from "../lib/audit/actor";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { reportError } from "../services/error-report.server";
import { PageShell } from "../components/PageShell";
import { HelpNote } from "../components/HelpNote";
import { Field } from "../components/FieldGrid";
import { ActionRow } from "../components/ActionRow";
import { SPACE } from "../lib/ui/spacing";
import { Card } from "../components/Card";

export const loader = withGuard("/app/prices/baselines/recapture", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const segmentId = new URL(request.url).searchParams.get("segment") ?? undefined;
  const [plan, segments] = await Promise.all([
    planRecapture(shop.id, { segmentId }),
    prisma.segment.findMany({
      where: { shopId: shop.id },
      select: { id: true, name: true, kind: true },
      orderBy: { name: "asc" },
    }),
  ]);

  // The variant list itself never reaches the browser — it is up to half a million ids
  // and the page only needs the count.
  const assessment = {
    risk: plan.risk,
    scope: plan.scope,
    overlaps: plan.overlaps,
    confirmationPhrase: plan.confirmationPhrase,
    warning: plan.warning,
  };
  return { assessment, segments, segmentId: segmentId ?? "" };
});

type ActionData = { ok: boolean; message: string; errorId?: string };

export const action = withGuard("/app/prices/baselines/recapture", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  try {
    const result = await recapture(shop.id, {
      segmentId: String(form.get("segment") ?? "") || undefined,
      confirmation: String(form.get("confirmation") ?? ""),
      actor: actorFor(sessionToken, session.shop),
    });

    return {
      ok: true,
      message:
        `Recaptured ${result.captured} baselines across ${result.scope} variants` +
        (result.superseded > 0 ? `, superseding ${result.superseded}` : "") +
        (result.alreadyCurrent > 0 ? `. ${result.alreadyCurrent} were already correct` : "") +
        ".",
    };
  } catch (error) {
    const reported = await reportError(error, {
      shopId: shop.id,
      shop: session.shop,
      route: "/app/prices/baselines/recapture",
    });
    return { ok: false, message: reported.userMessage, errorId: reported.errorId };
  }
});

export default function Recapture() {
  const { assessment, segments, segmentId } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const data = fetcher.data;

  return (
    <PageShell
      heading="Recapture baselines"
      backTo={{ href: "/app/prices/baselines", label: "Baselines" }}
    >
      {data ? (
        <s-banner tone={data.ok ? "success" : "critical"}>
          <s-paragraph>{data.message}</s-paragraph>
          {data.errorId ? <s-paragraph>Reference {data.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      <Card heading="What this does">    <s-paragraph>
          <s-text>
            Recapturing replaces the reference price of every variant in scope with the
            price its storefront shows right now. Every campaign from then on computes
            its discount from the new number.
          </s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Do it when your real prices have genuinely changed — a supplier increase, a
            new season. Do not do it while a sale is running, or the sale price becomes
            the price you discount from next time.
          </s-text>
        </s-paragraph>

        <fetcher.Form method="get">
          <s-stack gap={SPACE.section}>
            <Field width="medium">
            <s-select name="segment" label="Scope">
              <s-option value="" defaultSelected={!segmentId}>
                The whole catalogue
              </s-option>
              {segments.map((segment) => (
                <s-option
                  key={segment.id}
                  value={segment.id}
                  defaultSelected={segmentId === segment.id}
                >
                  {segment.name} ({segment.kind === "DYNAMIC" ? "dynamic" : "frozen"})
                </s-option>
              ))}
            </s-select>
            </Field>
            <ActionRow>
              <s-button type="submit">Check this scope</s-button>
            </ActionRow>
          </s-stack>
        </fetcher.Form>

        <s-paragraph>
          <s-text>
            {assessment.scope} variant{assessment.scope === 1 ? "" : "s"} in scope.
          </s-text>
        </s-paragraph>
      </Card>

      {assessment.risk === "overlaps-active-campaign" ? (
        <Card heading="These are on sale right now">      <s-banner tone="critical">
            <s-paragraph>{assessment.warning}</s-paragraph>
          </s-banner>

          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Campaign</s-table-header>
              <s-table-header listSlot="inline" format="numeric">
                Variants in this scope
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {assessment.overlaps.map((overlap) => (
                <s-table-row key={overlap.campaignId}>
                  <s-table-cell>{overlap.campaignName}</s-table-cell>
                  <s-table-cell>{overlap.variants}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </Card>
      ) : null}

      <Card heading="Recapture">    <fetcher.Form method="post">
          <input type="hidden" name="segment" value={segmentId} />
          <s-stack gap={SPACE.section}>
            {assessment.confirmationPhrase ? (
              <Field width="medium">
                <s-text-field
                  name="confirmation"
                  label={`Type “${assessment.confirmationPhrase}” to confirm`}
                  details="Typed rather than clicked, because a button is muscle memory by the third time."
                />
              </Field>
            ) : null}

            <s-button
              type="submit"
              tone="critical"
              variant="primary"
              loading={busy || undefined}
              disabled={assessment.scope === 0 || undefined}
            >
              Replace {assessment.scope} baseline{assessment.scope === 1 ? "" : "s"}
            </s-button>
          </s-stack>
        </fetcher.Form>
      </Card>

      <HelpNote label="If you get this wrong">
        <s-paragraph>
          Baselines are append-only: the old one is kept and marked superseded. Nothing is
          destroyed.
        </s-paragraph>
        <s-paragraph>
          Putting it back means reading that history and setting the old numbers again —
          on a large catalogue, a bad afternoon. Every version is on the Baselines page.
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
