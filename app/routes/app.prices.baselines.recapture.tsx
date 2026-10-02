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

import { useEffect, useRef, useState, type ElementRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { planRecapture, recapture } from "../services/recapture.server";
import { recaptureScopeFrom, STALE_SCOPE } from "../lib/baselines/recapture-scope";
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
    planRecapture(shop.id, recaptureScopeFrom(segmentId)),
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

  // The count the page showed next to the button (#716). Absent only on a request this
  // page did not build, which is refused rather than recapturing a scope nobody looked at.
  const shown = String(form.get("scope") ?? "");
  if (!/^\d+$/.test(shown)) {
    return {
      ok: false,
      message:
        "Nothing was recaptured: the request did not say which scope it was checked against. Check the scope on this page, then recapture.",
    };
  }

  try {
    const result = await recapture(shop.id, {
      ...recaptureScopeFrom(String(form.get("segment") ?? "")),
      confirmation: String(form.get("confirmation") ?? ""),
      actor: actorFor(sessionToken, session.shop),
      expectedScope: Number(shown),
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

  // What the Scope field shows, against the scope the page has assessed. They differ
  // between picking a segment and pressing "Check this scope" -- and in that gap the count,
  // the on-sale warning and the button all describe the *assessed* scope, so pressing
  // Replace rewrote baselines the field said were not selected (#780). Listened to
  // natively: React 18 never delivers `onChange` from a Polaris field (#863).
  const scopeField = useRef<ElementRef<"s-select">>(null);
  const [picked, setPicked] = useState<{ against: string; value: string } | null>(null);
  useEffect(() => {
    const field = scopeField.current;
    if (!field) return;
    const changed = () => setPicked({ against: segmentId, value: String((field as { value?: string }).value ?? "") });
    field.addEventListener("change", changed);
    field.addEventListener("input", changed);
    return () => {
      field.removeEventListener("change", changed);
      field.removeEventListener("input", changed);
    };
  }, [segmentId]);
  // A pick made against an earlier assessment is forgotten once the page assesses anew.
  const unchecked = picked !== null && picked.against === segmentId && picked.value !== segmentId;

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

        {/* A navigation, not a fetcher (#716). A GET fetcher loads into `fetcher.data`,
            which nothing here reads -- the count, the overlaps and the scope posted with
            Recapture all come from the loader -- so picking a segment changed nothing on
            screen and "Replace" still rewrote every baseline in the store. */}
        <Form method="get">
          <s-stack gap={SPACE.section}>
            <Field width="medium">
            <s-select ref={scopeField} name="segment" label="Scope">
              <s-option value="" defaultSelected={!segmentId}>
                The whole catalogue
              </s-option>
              {/* The baselines What's live calls out of date: prices changed outside the
                  app while no campaign was running on them (#745). */}
              <s-option value={STALE_SCOPE} defaultSelected={segmentId === STALE_SCOPE}>
                Prices changed outside a campaign
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
        </Form>

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
          <input type="hidden" name="scope" value={assessment.scope} />
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

            {unchecked ? (
              <s-banner tone="warning">
                <s-paragraph>
                  The scope you picked has not been checked yet. Press Check this scope first:
                  the count, the warning and this button still describe the scope checked
                  before, and recapturing now would replace those baselines instead.
                </s-paragraph>
              </s-banner>
            ) : null}

            <s-button
              type="submit"
              tone="critical"
              variant="primary"
              loading={busy || undefined}
              disabled={assessment.scope === 0 || unchecked || undefined}
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
