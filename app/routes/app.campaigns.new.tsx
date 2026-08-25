import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { facets, previewMatches, type FilterAst } from "../services/segments.server";
import { createCampaign } from "../services/campaigns/index.server";
import type { AdjustmentRule, CompareAtPolicy } from "../lib/pricing/types";
import { money } from "../lib/money/money";
import { localInputToUtc, type Schedule } from "../lib/scheduling/window";
import { describeAdjustment } from "../lib/markets/describe";
import { FilterForm } from "../components/FilterForm";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import prisma from "../db.server";
import { segmentToAst } from "../services/segments.server";

export const loader = withGuard("/app/campaigns/new", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const url = new URL(request.url);
  const segmentId = url.searchParams.get("segment") ?? "";
  const practice = url.searchParams.get("practice") === "1";
  const guided = url.searchParams.get("guided") === "1";

  // A chosen segment replaces the inline filter rather than narrowing it. Combining
  // the two would mean a campaign whose scope no longer matches the segment the
  // merchant thinks it targets, which is exactly the confusion segments exist to end.
  const segment = segmentId
    ? await prisma.segment.findFirst({
        where: { id: segmentId, shopId: shop.id },
        select: { id: true, name: true, kind: true, filterAst: true, frozenVariantGids: true },
      })
    : null;

  const ast = segment
    ? segmentToAst({
        kind: segment.kind as "DYNAMIC" | "FROZEN",
        filterAst: segment.filterAst,
        frozenVariantGids: segment.frozenVariantGids,
      })
    : astFromParams(url.searchParams);

  const [available, preview, segments, priceLists] = await Promise.all([
    facets(shop.id),
    previewMatches(shop.id, ast),
    prisma.segment.findMany({
      where: { shopId: shop.id },
      select: { id: true, name: true, kind: true },
      orderBy: { name: "asc" },
    }),
    // Markets the shop actually has. Offered rather than assumed: a single-market
    // store sees no market section at all, which is most stores.
    prisma.priceListRecord.findMany({
      where: { shopId: shop.id, surfaceKind: "MARKET" },
      select: { priceListGid: true, name: true, currency: true, adjustmentBps: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return {
    timeZone: shop.timezone,
    priceLists,
    facets: available,
    preview,
    segments,
    usingSegment: segment ? { id: segment.id, name: segment.name, kind: segment.kind } : null,
    practice,
    guided,
    selected: {
      collection: url.searchParams.get("collection") ?? "",
      tag: url.searchParams.get("tag") ?? "",
      vendor: url.searchParams.get("vendor") ?? "",
      title: url.searchParams.get("title") ?? "",
      segment: segmentId,
    },
  };
});

/**
 * The scope form's fields.
 *
 * Named once and shared with the form, so a field added to one and forgotten in the
 * other cannot silently stop being filterable.
 */
export const SCOPE_FIELDS = ["collection", "tag", "vendor", "title", "segment"] as const;

/** Builds an AST from the simple scope form: all provided conditions ANDed. */
function astFromParams(params: URLSearchParams): FilterAst {
  // `segment` rides in the same form but is a reference, not a condition -- the
  // loader resolves it into a whole AST rather than adding a clause to one.
  const conditions = SCOPE_FIELDS.filter((field) => field !== "segment")
    .map((field) => [field, params.get(field)] as const)
    .filter(([, value]) => value && value.trim().length > 0)
    .map(([field, value]) => ({ field, value: value!.trim() }));

  return conditions.length > 0 ? { groups: [{ conditions }] } : { groups: [] };
}

export const action = withGuard("/app/campaigns/new", async ({ request }: ActionFunctionArgs) => {
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

  const startLocal = String(form.get("startAt") ?? "").trim();
  const endLocal = String(form.get("endAt") ?? "").trim();
  const startUtc = startLocal ? localInputToUtc(startLocal, shop.timezone) : null;

  // A schedule needs a valid start. Anything else stays manual rather than being
  // half-scheduled, which would leave the merchant unsure whether it will fire.
  const schedule: Schedule | undefined = startUtc
    ? {
        kind: "window",
        startAt: startUtc,
        endAt: endLocal ? localInputToUtc(endLocal, shop.timezone) ?? undefined : undefined,
        revertBufferMinutes: Number(form.get("revertBuffer") ?? 5) || 5,
      }
    : undefined;

  // Every checked market. `getAll` rather than `get`, because a campaign priced into
  // three markets sends the field three times and `get` would keep only the first.
  const priceLists = form
    .getAll("priceList")
    .map((value) => String(value))
    .filter(Boolean);

  const segmentId = String(form.get("segment") ?? "").trim();
  const practice = String(form.get("practice") ?? "") === "1";

  const campaign = await createCampaign(shop.id, {
    name: String(form.get("name") ?? "Untitled campaign").trim() || "Untitled campaign",
    ast: astFromParams(params),
    ...(segmentId ? { segmentId } : {}),
    ...(practice ? { practice: true } : {}),
    rule,
    compareAtPolicy,
    rounding: String(form.get("rounding") ?? "none") === "charm99" ? "charm99" : "none",
    priority: Number(form.get("priority") ?? 100) || 100,
    // An unchecked checkbox is simply absent from the form, so presence is the value.
    autoEnroll: form.get("autoEnroll") !== null,
    tagKit: String(form.get("tagKit") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    priceLists,
    schedule,
  });

  return redirect(`/app/campaigns/${campaign.id}`);
});

export default function NewCampaign() {
  const {
    facets: available,
    preview,
    selected,
    segments,
    usingSegment,
    practice,
    guided,
    timeZone,
    priceLists,
  } = useLoaderData<typeof loader>();

  return (
    <s-page heading={practice ? "Practice campaign" : guided ? "Your first campaign" : "New campaign"}>
      {practice ? (
        <s-banner tone="info">
          <s-paragraph>
            Practice mode. You will see exactly which prices would change and by how
            much, and nothing will be written to your storefront — not now, and not
            later. This campaign cannot be applied at all.
          </s-paragraph>
        </s-banner>
      ) : null}

      {guided ? (
        <s-banner tone="info">
          <s-paragraph>
            Start small. Narrow the scope below to a handful of products — five is
            plenty — so your first run is quick and easy to check. You will see every
            price that would change before anything is applied.
          </s-paragraph>
        </s-banner>
      ) : null}

      <s-section heading="1 · Scope">
        <s-paragraph>
          Leave everything blank to target the whole catalogue. Conditions combine
          with AND.
        </s-paragraph>
        <FilterForm fields={SCOPE_FIELDS}>
          <s-stack gap="base">
            <label htmlFor="segment">Saved segment</label>
            <select id="segment" name="segment" defaultValue={selected.segment}>
              <option value="">Build a filter below instead</option>
              {segments.map((segment) => (
                <option key={segment.id} value={segment.id}>
                  {segment.name} ({segment.kind === "DYNAMIC" ? "dynamic" : "frozen"})
                </option>
              ))}
            </select>

            {usingSegment ? (
              <s-banner tone="info">
                <s-paragraph>
                  Targeting the segment <s-text>{usingSegment.name}</s-text>. The filter
                  below is ignored.{" "}
                  {usingSegment.kind === "DYNAMIC"
                    ? "It re-checks its filter on every run, so products added later join this campaign."
                    : "Its product list is pinned, so this campaign hits exactly those products and nothing added later."}
                </s-paragraph>
              </s-banner>
            ) : null}

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
        </FilterForm>

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
        <Form method="post">
          {/* The scope form and the create form are separate elements, so the chosen
              segment has to travel with the submission that actually creates. */}
          <input type="hidden" name="segment" value={selected.segment} />
          <input type="hidden" name="practice" value={practice ? "1" : ""} />
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

            <s-text-field
              name="tagKit"
              label="Storefront tags (optional)"
              placeholder="SALE, SUMMER"
              details="Comma separated. Added to each product while the campaign runs and removed when it ends, so your theme can badge sale items. Tags a product already has are never removed."
            />

            <s-checkbox
              name="autoEnroll"
              label="Price products that join this campaign while it runs"
              defaultChecked
              details="A product you add to the sale later is priced from its own normal price, not the sale price."
            />

            {priceLists.length > 0 ? (
              <>
                <s-divider />

                <s-heading>Markets</s-heading>
                <s-paragraph>
                  <s-text>
                    Your base price always changes. Tick a market to run this campaign
                    there too &mdash; each market is priced from{" "}
                    <s-text>its own normal price in its own currency</s-text>, not
                    converted from the base sale price.
                  </s-text>
                </s-paragraph>

                {priceLists.map((list) => (
                  <s-checkbox
                    key={list.priceListGid}
                    name="priceList"
                    value={list.priceListGid}
                    label={`${list.name} (${list.currency})`}
                    details={
                      list.adjustmentBps === null
                        ? "Prices set per product on this market."
                        : `Normally ${describeAdjustment(list.adjustmentBps)} the base price.`
                    }
                  />
                ))}
              </>
            ) : null}

            <s-divider />

            <s-heading>Schedule (optional)</s-heading>
            <s-paragraph>
              <s-text>
                Times are in your store&rsquo;s zone, {timeZone}. Leave the start
                blank to run the campaign only when you apply it by hand.
              </s-text>
            </s-paragraph>

            <label htmlFor="startAt">Start</label>
            <input id="startAt" type="datetime-local" name="startAt" />

            <label htmlFor="endAt">End (optional)</label>
            <input id="endAt" type="datetime-local" name="endAt" />

            <s-number-field
              name="revertBuffer"
              label="Revert this many minutes early"
              defaultValue="5"
              details="A busy bulk queue takes time; starting early means prices are back before the window closes."
            />

            <s-button type="submit" variant="primary">
              {practice ? "Preview it — nothing will be written" : "Create and preview"}
            </s-button>
          </s-stack>
        </Form>
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
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
