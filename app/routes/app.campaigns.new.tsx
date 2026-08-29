import { useCallback, useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { facets } from "../services/segments.server";
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
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { readSettings, shopCurrency } from "../services/settings.server";
import { billingFrom } from "../services/billing.server";
import { canUseSurface } from "../lib/billing/plans";
import prisma from "../db.server";
import { astFrom, compareAtFrom, readerFor, ruleFrom } from "../lib/campaigns/draft-form";
import { draftDefaultParams } from "../lib/campaigns/draft-defaults";
import { draftCampaignFrom } from "../services/campaigns/draft-input.server";
import { previewDraft } from "../services/campaigns/draft-preview.server";
import { PageSections, PageShell } from "../components/PageShell";
import { UnsavedChanges } from "../components/UnsavedChanges";
import { DraftPreview } from "../components/DraftPreview";
import { RuleValueField } from "../components/RuleValueField";
import { FieldGrid, FullRow } from "../components/FieldGrid";
import { HelpNote } from "../components/HelpNote";
import { SPACE } from "../lib/ui/spacing";
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

  const [available, segments, priceLists, settings, currency, shopRecord] =
    await Promise.all([
    facets(shop.id),
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

  // The preview the merchant would get if they changed nothing, computed here so the
  // panel arrives populated rather than saying "set a rule" next to a rule that is
  // already set. The scope comes from the URL — a merchant who arrived from a segment or
  // from the calendar has already made that choice — and the rule from the same defaults
  // the fields render, so this and the first keystroke agree.
  const seeded = draftDefaultParams();
  // Rounding is the shop's, not a default of its own: the select renders the store
  // setting as its chosen option, so a preview built without it would round differently
  // from the form sitting next to it. `readRoundingPolicy` falls back to "none" when the
  // field is absent, which is precisely the disagreement to avoid.
  seeded.set("rounding.default", settings.rounding.default);
  for (const [code, profile] of Object.entries(settings.rounding.byCurrency)) {
    seeded.set(`rounding.${code}`, profile);
  }
  for (const [key, value] of url.searchParams) if (value) seeded.set(key, value);
  const preview = await previewDraft(
    shop.id,
    await draftCampaignFrom(shop.id, seeded, currency),
  );

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
    <PageShell
      heading={practice ? "Practice campaign" : guided ? "Your first campaign" : "New campaign"}
      backTo={{ href: "/app/campaigns", label: "Campaigns" }}
      asideWidth="wide"
    >
      {/* Before anything else on the page, because it is the answer to a click that has
          already happened. Nothing here is persisted until the campaign is created, so
          any navigation away is a discard. */}
      <UnsavedChanges form={formRef} describe="this campaign" />
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

      {/* One form, not two.

          The scope used to be its own GET form with an "Update match count" submit, so
          reading the count meant a navigation — which reset every uncontrolled field in
          the rule form below it. Two forms also meant the scope had to be mirrored into
          the create form as six hidden inputs, and a field added to one and forgotten in
          the other would silently stop scoping the campaign.

          One form removes both. It is also what makes the preview live: the fetcher
          already posts `new FormData(form)`, so with the scope inside that form a change
          to a filter reprices exactly as a change to the rule does. */}
      <Form method="post" ref={formRef} onChange={requestPreview}>
        <input type="hidden" name="practice" value={practice ? "1" : ""} />

        {/* `s-page` spaces its direct children, and these are no longer direct children
            — they are inside a form. `PageSections` is the page rhythm, available for
            exactly this case. Without it two cards touch and read as one card with a
            line through it. */}
        <PageSections>
      <s-section heading="1 · Scope">
        <s-paragraph>
          Leave everything blank to target the whole catalogue. Conditions combine
          with AND.
        </s-paragraph>

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
            <FullRow>
              <s-banner tone="info">
                <s-paragraph>
                  Targeting the segment <s-text>{usingSegment.name}</s-text>. The filter
                  below is ignored.{" "}
                  {usingSegment.kind === "DYNAMIC"
                    ? "It re-checks its filter on every run, so products added later join this campaign."
                    : "Its product list is pinned, so this campaign hits exactly those products and nothing added later."}
                </s-paragraph>
              </s-banner>
            </FullRow>
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
      </s-section>

      <s-section heading="2 · Rule">
          <s-stack gap={SPACE.section}>
            {/* The rule, and nothing else, first.

                This block was one flat stack of about fifteen full-width controls -- name,
                rule, compare-at, rounding, priority, tags, auto-enrol, a checkbox per
                market, a select per currency, four schedule fields and a revert buffer.
                `FieldGrid` exists for exactly that failure and its doc comment names it:
                a select holding one word rendered twelve hundred pixels wide is "the
                single most unstyled-looking thing in this app". Step 1 above already used
                it; the longer form, the one a merchant actually fills in, did not. */}
            <FieldGrid>
              {/* The one field that keeps the whole row. It names the thing being made,
                  and a title above the settings that describe it is the shape every form
                  of this kind takes. */}
              <FullRow>
                <s-text-field name="name" label="Campaign name" value="Sale" required />
              </FullRow>

              {/* Not wrapped in a `FullRow`, deliberately. This renders *two* fields — the
                  adjustment and its amount — as a fragment, so as bare grid children they
                  land side by side, which is the pair a merchant reads as one decision.
                  Inside a `FullRow` they would both go in one cell and stack. */}
              <RuleValueField currency={currencies[0] ?? "USD"} />

              <s-select name="compareAt" label="Compare-at price">
                <s-option value="set-to-baseline" defaultSelected>
                  Set to baseline (shows a strike-through)
                </s-option>
                <s-option value="leave">Leave unchanged</s-option>
                <s-option value="clear">Clear it</s-option>
              </s-select>

              <s-select
                name="rounding.default"
                label="Rounding"
                details="Starts from your store setting. Change it here to round this campaign differently."
              >
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
            </FieldGrid>

            {/* What this rule does to prices, from the same resolver the run uses --
                not an estimate of it. Sits with the rule rather than at the bottom of
                the page, because it exists to answer "did I mean -20% or x0.20?" while
                the merchant is still deciding. With the rarely-touched settings moved to
                the end, it now lands directly under the rule it is previewing. */}

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

                {/* One select per currency, in columns. A store selling in six currencies
                    rendered six full-width bars each holding the phrase "Ends in .99". */}
                <FieldGrid>
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
                </FieldGrid>
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
                around it, and the two are recombined server-side.

                The grid rather than an inline stack, so the two pairs line up with each
                other: a stack sizes each child to its content, so End sat a few pixels
                left of Start and the four fields read as four rather than as two pairs. */}
            <FieldGrid>
              <s-date-field name="startDate" label="Start" value={presetStart.slice(0, 10)} />
              <s-text-field
                name="startTime"
                label="Start time"
                placeholder="09:00"
                value={presetStart.slice(11)}
                details="24-hour, in your store's zone."
              />
              <s-date-field name="endDate" label="End (optional)" />
              <s-text-field
                name="endTime"
                label="End time"
                placeholder="23:59"
                details="Defaults to the end of that day."
              />
            </FieldGrid>

            <s-divider />

            {/* The pressure valve.

                Four controls a first campaign never touches, all with defaults that are
                right for almost everybody: priority only matters once two campaigns
                overlap, tags only matter if the theme reads them, auto-enrol is on, and
                the revert buffer is meaningless without an end date. They were sitting
                between the rule and the schedule, so the merchant read four settings they
                had no opinion about before reaching the one thing they came to set.

                Named "optional" rather than hidden: Polaris has no disclosure element —
                all 57 tags checked, there is no `s-details` and no accordion — so a
                collapsible here would be hand-rolled chrome in an app that has none. A
                heading that says a block can be skipped does the same job honestly. */}
            <s-heading>Advanced (optional)</s-heading>
            <s-paragraph>
              <s-text color="subdued">
                Every one of these has a default that suits most campaigns. Skip them
                unless you have a reason.
              </s-text>
            </s-paragraph>

            <FieldGrid>
              <s-number-field
                name="priority"
                label="Priority"
                value="100"
                details="Higher wins when two campaigns cover the same variant. They never stack."
              />

              <s-number-field
                name="revertBuffer"
                label="Revert this many minutes early"
                value="5"
                details="A busy bulk queue takes time; starting early means prices are back before the window closes."
              />

              <FullRow>
                <s-text-field
                  name="tagKit"
                  label="Storefront tags (optional)"
                  placeholder="SALE, SUMMER"
                  details="Comma separated. Added to each product while the campaign runs and removed when it ends, so your theme can badge sale items. Tags a product already has are never removed."
                />
              </FullRow>

              <FullRow>
                <s-checkbox
                  name="autoEnroll"
                  label="Price products that join this campaign while it runs"
                  checked
                  details="A product you add to the sale later is priced from its own normal price, not the sale price."
                />
              </FullRow>
            </FieldGrid>

            <s-divider />

            <ActionRow>
              <s-button type="submit" variant="primary">
                {practice ? "Preview it — nothing will be written" : "Create and preview"}
              </s-button>
            </ActionRow>
          </s-stack>
      </s-section>
        </PageSections>
      </Form>

      {/* Beside the rule, not below it.

          This is the panel a merchant came to read, and it lived at the foot of the rule
          section behind a `What this would do` heading — so on a form of this length it
          was reliably off screen while the rule was being typed. Competitors that compute
          a far weaker preview than this one all put it next to the control.

          It is `resolve()`, not an estimate of it: the same planner, the same baselines,
          the draft resolved alongside the shop's other ACTIVE campaigns. The loader
          primes it so the panel arrives populated, and the fetcher replaces it from the
          first keystroke onward. */}
      <s-section slot="aside" heading="What this would do">
        <DraftPreview preview={previewFetcher.data ?? preview} />
      </s-section>

      <HelpNote label="Nothing is written yet">
        <s-paragraph>
          Creating a campaign records the rule. The next screen shows exactly which prices
          would change, before anything touches your storefront.
        </s-paragraph>
        <s-paragraph>
          Every change computes from the variant&rsquo;s <strong>baseline</strong>, not its
          current price — so applying twice gives the same result.
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
