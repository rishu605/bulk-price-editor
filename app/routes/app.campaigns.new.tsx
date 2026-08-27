import { useCallback, useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { facets, previewMatches } from "../services/segments.server";
import { createCampaign } from "../services/campaigns/index.server";
import { joinDateAndTime, localInputToUtc, type Schedule } from "../lib/scheduling/window";
import { presetStartFor } from "../lib/scheduling/calendar";
import { describeAdjustment } from "../lib/markets/describe";
import {
  profileNameFor,
  readRoundingPolicy,
  ROUNDING_LABELS,
} from "../lib/money/rounding-policy";
import { ActionRow } from "../components/ActionRow";
import { FilterForm } from "../components/FilterForm";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { readSettings, shopCurrency } from "../services/settings.server";
import { billingFrom } from "../services/billing.server";
import { canUseSurface } from "../lib/billing/plans";
import prisma from "../db.server";
import { segmentToAst } from "../services/segments.server";
import { astFrom, compareAtFrom, readerFor, ruleFrom } from "../lib/campaigns/draft-form";
import { PageShell } from "../components/PageShell";
import { DraftPreview } from "../components/DraftPreview";
import { RuleValueField } from "../components/RuleValueField";
import { FieldGrid, FullRow } from "../components/FieldGrid";
import type { DraftPreview as Preview } from "../services/campaigns/draft-preview.server";

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
    : astFrom(readerFor(url.searchParams));

  const [available, preview, segments, priceLists, settings, currency, shopRecord] =
    await Promise.all([
    facets(shop.id),
    previewMatches(shop.id, ast),
    prisma.segment.findMany({
      where: { shopId: shop.id },
      select: { id: true, name: true, kind: true },
      orderBy: { name: "asc" },
    }),
    // Markets the shop actually has. Offered rather than assumed: a single-market
    // store sees no market section at all, which is most stores.
    // Markets and B2B catalogues alike. B2B is listed rather than hidden: a wholesale
    // price list is a surface a campaign can price, and a merchant who has one is
    // usually the merchant who most needs to know whether this sale reaches it.
    prisma.priceListRecord.findMany({
      where: { shopId: shop.id },
      select: {
        priceListGid: true,
        name: true,
        currency: true,
        adjustmentBps: true,
        surfaceKind: true,
      },
      orderBy: [{ surfaceKind: "asc" }, { name: "asc" }],
    }),
    readSettings(shop.id),
    shopCurrency(shop.id),
    prisma.shop.findUniqueOrThrow({
      where: { id: shop.id },
      select: {
        planTier: true,
        subscriptionStatus: true,
        trialEndsAt: true,
        developerStore: true,
      },
    }),
  ]);

  const billing = billingFrom(shopRecord);

  // Every currency this campaign could price in. Only these are offered: a list of all
  // 180 world currencies would bury the two or three that matter.
  const currencies = [
    ...new Set([currency, ...priceLists.map((list) => list.currency)].filter(Boolean)),
  ].sort();

  return {
    timeZone: shop.timezone,
    priceLists,
    currencies,
    // Gated surfaces are listed with an upgrade prompt rather than hidden. Hiding a
    // feature a merchant is paying a competitor for is how you lose them without ever
    // finding out why.
    gates: {
      market: canUseSurface(billing.plan, "market"),
      b2b: canUseSurface(billing.plan, "b2b"),
    },
    planName: billing.plan.name,
    storeRounding: settings.rounding,
    roundingOptions: Object.entries(ROUNDING_LABELS).map(([value, label]) => ({ value, label })),
    facets: available,
    preview,
    segments,
    usingSegment: segment ? { id: segment.id, name: segment.name, kind: segment.kind } : null,
    practice,
    guided,
    // Set when the merchant arrived by clicking a day on the calendar.
    presetStart: presetStartFor(url.searchParams.get("startAt")),
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

export const action = withGuard("/app/campaigns/new", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const params = new URLSearchParams();
  for (const field of ["collection", "tag", "vendor", "title"]) {
    const value = form.get(field);
    if (typeof value === "string" && value.trim()) params.set(field, value.trim());
  }

  // The shop's own currency, not a form field. The form never had one, so this used to
  // fall back to "USD" on every store -- and the conversion to minor units used a
  // literal 100, so a JPY amount came out a hundred times too large as well (#343).
  const read = readerFor(form);
  const currency = await shopCurrency(shop.id);
  const rule = ruleFrom(read, currency);
  const compareAtPolicy = compareAtFrom(read);

  const startLocal = joinDateAndTime(
    String(form.get("startDate") ?? ""),
    String(form.get("startTime") ?? ""),
    "09:00",
  );
  const endLocal = joinDateAndTime(
    String(form.get("endDate") ?? ""),
    String(form.get("endTime") ?? ""),
    "23:59",
  );
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
    ast: astFrom(readerFor(params)),
    ...(segmentId ? { segmentId } : {}),
    ...(practice ? { practice: true } : {}),
    rule,
    compareAtPolicy,
    rounding: readRoundingPolicy(form.entries()),
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
    currencies,
    storeRounding,
    roundingOptions,
    presetStart,
    gates,
    planName,
  } = useLoaderData<typeof loader>();

  // The live price preview. Debounced, because it plans the whole scope on every call
  // and a merchant typing "-20" would otherwise ask three times on the way there.
  const previewFetcher = useFetcher<Preview>();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const requestPreview = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const form = formRef.current;
      if (!form) return;
      previewFetcher.submit(new FormData(form), {
        method: "post",
        action: "/app/preview-draft",
      });
    }, 400);
  }, [previewFetcher]);

  // Clear the pending call on unmount, so navigating away mid-type does not fire a
  // request against a page that is gone.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);


  return (
    <PageShell heading={practice ? "Practice campaign" : guided ? "Your first campaign" : "New campaign"}>
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
          <FieldGrid>
            <FullRow>
            <s-select name="segment" label="Saved segment">
              <s-option value="" defaultSelected={!selected.segment}>
                Build a filter below instead
              </s-option>
              {segments.map((segment) => (
                <s-option
                  key={segment.id}
                  value={segment.id}
                  defaultSelected={selected.segment === segment.id}
                >
                  {segment.name} ({segment.kind === "DYNAMIC" ? "dynamic" : "frozen"})
                </s-option>
              ))}
            </s-select>
            </FullRow>

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

            <s-select name="collection" label="Collection">
              <s-option value="" defaultSelected={!selected.collection}>
                Any collection
              </s-option>
              {available.collections.map((c) => (
                <s-option key={c} value={c} defaultSelected={selected.collection === c}>
                  {c}
                </s-option>
              ))}
            </s-select>
            <s-select name="vendor" label="Vendor">
              <s-option value="" defaultSelected={!selected.vendor}>
                Any vendor
              </s-option>
              {available.vendors.map((v) => (
                <s-option key={v} value={v} defaultSelected={selected.vendor === v}>
                  {v}
                </s-option>
              ))}
            </s-select>
            <s-select name="tag" label="Tag">
              <s-option value="" defaultSelected={!selected.tag}>
                Any tag
              </s-option>
              {available.tags.map((t) => (
                <s-option key={t} value={t} defaultSelected={selected.tag === t}>
                  {t}
                </s-option>
              ))}
            </s-select>
            <s-text-field name="title" label="Title contains" value={selected.title} />
          </FieldGrid>

          <s-stack direction="inline" gap="base">
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
        <Form method="post" ref={formRef} onChange={requestPreview}>
          {/* The scope form and the create form are separate elements, so the chosen
              segment has to travel with the submission that actually creates. */}
          <input type="hidden" name="segment" value={selected.segment} />
          <input type="hidden" name="practice" value={practice ? "1" : ""} />
          <input type="hidden" name="collection" value={selected.collection} />
          <input type="hidden" name="tag" value={selected.tag} />
          <input type="hidden" name="vendor" value={selected.vendor} />
          <input type="hidden" name="title" value={selected.title} />

          <s-stack gap="base">
            <s-text-field name="name" label="Campaign name" value="Sale" required />

            <RuleValueField currency={currencies[0] ?? "USD"} />

            <s-select name="compareAt" label="Compare-at price">
              <s-option value="set-to-baseline" defaultSelected>
                Set to baseline (shows a strike-through)
              </s-option>
              <s-option value="leave">Leave unchanged</s-option>
              <s-option value="clear">Clear it</s-option>
            </s-select>

            <s-select name="rounding.default" label="Rounding">
              {roundingOptions.map((option) => (
                <s-option
                  key={option.value}
                  value={option.value}
                  defaultSelected={option.value === storeRounding.default}
                >
                  {option.label}
                </s-option>
              ))}
            </s-select>
            <s-paragraph>
              <s-text>
                Starts from your store setting. Change it here to round this campaign
                differently.
              </s-text>
            </s-paragraph>

            {/* What this rule does to prices, from the same resolver the run uses --
                not an estimate of it. Sits with the rule rather than at the bottom of
                the page, because it exists to answer "did I mean -20% or x0.20?" while
                the merchant is still deciding. */}
            <s-divider />
            <s-heading>What this would do</s-heading>
            <DraftPreview preview={previewFetcher.data ?? null} />

            <s-number-field
              name="priority"
              label="Priority"
              value="100"
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
              checked
              details="A product you add to the sale later is priced from its own normal price, not the sale price."
            />

            {priceLists.length > 0 ? (
              <>
                <s-divider />

                <s-heading>Markets and catalogues</s-heading>
                <s-paragraph>
                  <s-text>
                    Your base price always changes. Tick a market to run this campaign
                    there too &mdash; each is priced from{" "}
                    <s-text>its own normal price in its own currency</s-text>, not
                    converted from the base sale price.
                  </s-text>
                </s-paragraph>

                {priceLists.map((list) => {
                  const gate = list.surfaceKind === "B2B" ? gates.b2b : gates.market;

                  return (
                    <s-checkbox
                      key={list.priceListGid}
                      name="priceList"
                      value={list.priceListGid}
                      disabled={!gate.allowed || undefined}
                      label={`${list.name} (${list.currency})${
                        list.surfaceKind === "B2B" ? " · wholesale" : ""
                      }`}
                      details={
                        !gate.allowed
                          ? gate.message
                          : list.adjustmentBps === null
                            ? "Prices set per product here."
                            : `Normally ${describeAdjustment(list.adjustmentBps)} the base price.`
                      }
                    />
                  );
                })}

                {!gates.market.allowed || !gates.b2b.allowed ? (
                  <s-banner tone="info">
                    <s-paragraph>
                      Some of these need a different plan than {planName}. Everything
                      already running keeps running, and reverts always work whatever
                      plan you are on.
                    </s-paragraph>
                    <ActionRow>
                      <s-button href="/app/settings/plan">See the plans</s-button>
                    </ActionRow>
                  </s-banner>
                ) : null}

                <s-paragraph>
                  <s-text>
                    A price ending that looks considered in one currency can look like a
                    mistake in another, and some currencies have no cents to end in.
                  </s-text>
                </s-paragraph>

                {currencies.map((code) => (
                  <s-select key={code} name={`rounding.${code}`} label={`Rounding for ${code}`}>
                    <s-option
                      value="inherit"
                      defaultSelected={!storeRounding.byCurrency[code]}
                    >
                      Same as this campaign&rsquo;s rounding (
                      {ROUNDING_LABELS[profileNameFor(storeRounding, code)].toLowerCase()})
                    </s-option>
                    {roundingOptions.map((option) => (
                      <s-option
                        key={option.value}
                        value={option.value}
                        defaultSelected={storeRounding.byCurrency[code] === option.value}
                      >
                        {option.label}
                      </s-option>
                    ))}
                  </s-select>
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

            {/* Date and time as two fields, because Polaris has no datetime component:
                `s-date-field` is date-only. Two Polaris fields beat one native
                datetime-local that would style itself differently from everything
                around it, and the two are recombined server-side. */}
            <s-stack direction="inline" gap="base">
              <s-date-field
                name="startDate"
                label="Start"
                value={presetStart.slice(0, 10)}
              />
              <s-text-field
                name="startTime"
                label="Start time"
                placeholder="09:00"
                value={presetStart.slice(11)}
                details="24-hour, in your store's zone."
              />
            </s-stack>

            <s-stack direction="inline" gap="base">
              <s-date-field name="endDate" label="End (optional)" />
              <s-text-field
                name="endTime"
                label="End time"
                placeholder="23:59"
                details="Defaults to the end of that day."
              />
            </s-stack>

            <s-number-field
              name="revertBuffer"
              label="Revert this many minutes early"
              value="5"
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
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
