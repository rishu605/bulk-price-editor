import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { readSettings, shopCurrency, writeSettings } from "../services/settings.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

export const loader = withGuard("/app/settings", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [settings, currency, withCost, variants] = await Promise.all([
    readSettings(shop.id),
    shopCurrency(shop.id),
    prisma.variantIndex.count({ where: { shopId: shop.id, cost: { not: null } } }),
    prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } }),
  ]);

  return { settings, currency, withCost, variants };
});

export const action = withGuard("/app/settings", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const saved = await writeSettings(shop.id, {
    neverBelowCost: form.get("neverBelowCost") === "on",
    minMarginPercent: emptyToNull(form.get("minMarginPercent")),
    minPrice: emptyToNull(form.get("minPrice")),
    violationPolicy: asPolicy(form.get("violationPolicy")),
    missingCostPolicy: form.get("missingCostPolicy") === "error" ? "error" : "skip",
  });

  return { ok: true, message: "Guardrails saved. They apply to every campaign.", saved };
});

function emptyToNull(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

function asPolicy(value: FormDataEntryValue | null): "clamp" | "skip" | "block" {
  const text = String(value ?? "");
  return text === "skip" || text === "block" ? text : "clamp";
}

type ActionData = { ok: boolean; message: string };

export default function Settings() {
  const { settings, currency, withCost, variants } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  const costCoverage = variants === 0 ? 0 : Math.round((withCost / variants) * 100);

  return (
    <s-page heading="Settings">
      {fetcher.data ? (
        <s-banner tone="success">
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="Guardrails">
        <s-paragraph>
          Floors that no campaign may price below. They are checked after rounding,
          so a rounding rule cannot push a price under them.
        </s-paragraph>

        {settings.neverBelowCost && costCoverage < 100 ? (
          <s-banner tone="warning">
            <s-paragraph>
              Only {costCoverage}% of your variants have a cost recorded. With
              &ldquo;never below cost&rdquo; on, the rest are skipped rather than
              priced unguarded — they will not be included in any campaign.
              Variants added since the last catalogue sync have no cost yet, because
              Shopify&rsquo;s product webhooks do not carry one; a re-sync from the
              dashboard fills them in.
            </s-paragraph>
          </s-banner>
        ) : null}

        <fetcher.Form method="post">
          <s-stack gap="base">
            <label>
              <input
                type="checkbox"
                name="neverBelowCost"
                defaultChecked={settings.neverBelowCost}
              />{" "}
              Never price at or below cost
            </label>

            <s-number-field
              name="minMarginPercent"
              label="Minimum margin (%)"
              defaultValue={settings.minMarginPercent?.toString() ?? ""}
              details="Share of the selling price. 25 means a price of at least cost ÷ 0.75. Leave blank for none."
            />

            <s-number-field
              name="minPrice"
              label={`Minimum price (${currency})`}
              defaultValue={settings.minPrice?.toString() ?? ""}
              details="An absolute floor, whatever the rule computes. Leave blank for none."
            />

            <label htmlFor="violationPolicy">When a price would breach a floor</label>
            <select
              id="violationPolicy"
              name="violationPolicy"
              defaultValue={settings.violationPolicy}
            >
              <option value="clamp">Clamp it to the floor and carry on</option>
              <option value="skip">Skip that variant, price the rest</option>
              <option value="block">Block the whole campaign</option>
            </select>

            <label htmlFor="missingCostPolicy">
              When a cost-based floor meets a variant with no cost
            </label>
            <select
              id="missingCostPolicy"
              name="missingCostPolicy"
              defaultValue={settings.missingCostPolicy}
            >
              <option value="skip">Skip that variant</option>
              <option value="error">Fail the campaign</option>
            </select>

            <s-button type="submit" variant="primary" loading={busy || undefined}>
              Save guardrails
            </s-button>
          </s-stack>
        </fetcher.Form>
      </s-section>

      <s-section slot="aside" heading="Why floors are checked last">
        <s-paragraph>
          A campaign computes a price from the baseline, rounds it, and only then
          checks the floor. Rounding down can push an otherwise-legal price under the
          line, so checking earlier would let it through.
        </s-paragraph>
        <s-paragraph>
          <s-text>
            A price is never zero or negative regardless of these settings — that
            floor is always on.
          </s-text>
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Cost data">
        <s-paragraph>
          {withCost} of {variants} variants have a cost ({costCoverage}%).
        </s-paragraph>
        <s-paragraph>
          <s-text>
            Cost-based floors only constrain variants that have one. The policy above
            decides what happens to the others.
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
