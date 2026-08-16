import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { facets, previewMatches, type FilterAst } from "../services/segments.server";
import { createCampaign } from "../services/campaigns.server";
import type { AdjustmentRule, CompareAtPolicy } from "../lib/pricing/types";
import { money } from "../lib/money/money";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const ast = astFromParams(url.searchParams);
  const [available, preview] = await Promise.all([
    facets(shop.id),
    previewMatches(shop.id, ast),
  ]);

  return {
    facets: available,
    preview,
    selected: {
      collection: url.searchParams.get("collection") ?? "",
      tag: url.searchParams.get("tag") ?? "",
      vendor: url.searchParams.get("vendor") ?? "",
      title: url.searchParams.get("title") ?? "",
    },
  };
};

/** Builds an AST from the simple scope form: all provided conditions ANDed. */
function astFromParams(params: URLSearchParams): FilterAst {
  const conditions = (
    [
      ["collection", params.get("collection")],
      ["tag", params.get("tag")],
      ["vendor", params.get("vendor")],
      ["title", params.get("title")],
    ] as const
  )
    .filter(([, value]) => value && value.trim().length > 0)
    .map(([field, value]) => ({ field, value: value!.trim() }));

  return conditions.length > 0 ? { groups: [{ conditions }] } : { groups: [] };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const field of ["collection", "tag", "vendor", "title"]) {
    const value = form.get(field);
    if (typeof value === "string" && value.trim()) params.set(field, value.trim());
  }

  const kind = String(form.get("ruleKind") ?? "percent-change");
  const amount = Number(form.get("ruleValue") ?? 0);
  const currency = String(form.get("currency") ?? "USD");

  let rule: AdjustmentRule;
  if (kind === "fixed-change") {
    rule = { kind: "fixed-change", amount: money(Math.round(amount * 100), currency) };
  } else if (kind === "set-exact") {
    rule = { kind: "set-exact", amount: money(Math.round(amount * 100), currency) };
  } else {
    rule = { kind: "percent-change", percent: amount };
  }

  const compareAt = String(form.get("compareAt") ?? "leave");
  const compareAtPolicy: CompareAtPolicy =
    compareAt === "set-to-baseline"
      ? { kind: "set-to-baseline" }
      : compareAt === "clear"
        ? { kind: "clear" }
        : { kind: "leave" };

  const campaign = await createCampaign(shop.id, {
    name: String(form.get("name") ?? "Untitled campaign").trim() || "Untitled campaign",
    ast: astFromParams(params),
    rule,
    compareAtPolicy,
    rounding: String(form.get("rounding") ?? "none") === "charm99" ? "charm99" : "none",
    priority: Number(form.get("priority") ?? 100) || 100,
  });

  return redirect(`/app/campaigns/${campaign.id}`);
};

export default function NewCampaign() {
  const { facets: available, preview, selected } = useLoaderData<typeof loader>();

  return (
    <s-page heading="New campaign">
      <s-section heading="1 · Scope">
        <s-paragraph>
          Leave everything blank to target the whole catalogue. Conditions combine
          with AND.
        </s-paragraph>
        <form method="get">
          <s-stack gap="base">
            <label htmlFor="collection">Collection</label>
            <select id="collection" name="collection" defaultValue={selected.collection}>
              <option value="">Any collection</option>
              {available.collections.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label htmlFor="vendor">Vendor</label>
            <select id="vendor" name="vendor" defaultValue={selected.vendor}>
              <option value="">Any vendor</option>
              {available.vendors.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <label htmlFor="tag">Tag</label>
            <select id="tag" name="tag" defaultValue={selected.tag}>
              <option value="">Any tag</option>
              {available.tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <s-text-field name="title" label="Title contains" defaultValue={selected.title} />
            <s-button type="submit">Update match count</s-button>
          </s-stack>
        </form>

        <s-paragraph>
          <strong>{preview.count}</strong> variants match.
        </s-paragraph>
        {preview.sample.length > 0 ? (
          <s-unordered-list>
            {preview.sample.slice(0, 5).map((v) => (
              <s-list-item key={v.variantGid}>
                {v.title} {v.price ? `· ${v.price}` : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
        ) : null}
      </s-section>

      <s-section heading="2 · Rule">
        <form method="post">
          <input type="hidden" name="collection" value={selected.collection} />
          <input type="hidden" name="tag" value={selected.tag} />
          <input type="hidden" name="vendor" value={selected.vendor} />
          <input type="hidden" name="title" value={selected.title} />

          <s-stack gap="base">
            <s-text-field name="name" label="Campaign name" defaultValue="Sale" required />

            <label htmlFor="ruleKind">Adjustment</label>
            <select id="ruleKind" name="ruleKind" defaultValue="percent-change">
              <option value="percent-change">Percent change from baseline</option>
              <option value="fixed-change">Fixed change from baseline</option>
              <option value="set-exact">Set an exact price</option>
            </select>

            <s-number-field
              name="ruleValue"
              label="Value"
              defaultValue="-20"
              details="Negative discounts. -20 means 20% off the baseline."
            />

            <label htmlFor="compareAt">Compare-at price</label>
            <select id="compareAt" name="compareAt" defaultValue="set-to-baseline">
              <option value="set-to-baseline">
                Set to baseline (shows a strike-through)
              </option>
              <option value="leave">Leave unchanged</option>
              <option value="clear">Clear it</option>
            </select>

            <label htmlFor="rounding">Rounding</label>
            <select id="rounding" name="rounding" defaultValue="none">
              <option value="none">None</option>
              <option value="charm99">Charm endings (.99)</option>
            </select>

            <s-number-field
              name="priority"
              label="Priority"
              defaultValue="100"
              details="Higher wins when two campaigns cover the same variant. They never stack."
            />

            <s-button type="submit" variant="primary">
              Create and preview
            </s-button>
          </s-stack>
        </form>
      </s-section>

      <s-section slot="aside" heading="Nothing is written yet">
        <s-paragraph>
          Creating a campaign only records the rule. The next screen shows exactly
          which prices would change, before anything touches your storefront.
        </s-paragraph>
        <s-paragraph>
          Every change is computed from each variant&rsquo;s <strong>baseline</strong>,
          not its current price — so applying twice gives the same result rather than
          discounting the discount.
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
