import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { facets } from "../services/segments.server";
import { createCampaign } from "../services/campaigns/index.server";
import { joinDateAndTime, localInputToUtc, type Schedule } from "../lib/scheduling/window";
import { presetStartFor } from "../lib/scheduling/calendar";
import { formatClock, formatCount, formatDay, formatWhen } from "../lib/format/display";
import { PriceImportHistory } from "../components/imports/PriceImportHistory";
import { ROWS_PER_VIEW } from "../lib/ui/table-budget";
import { describeAdjustment } from "../lib/markets/describe";
import {
  profileNameFor,
  readRoundingPolicy,
  ROUNDING_LABELS,
  type RoundingProfileName,
} from "../lib/money/rounding-policy";
import { roundingExampleLine } from "../lib/money/rounding-example";
import { ActionRow } from "../components/ActionRow";
import { CampaignNameField } from "../components/campaign/CampaignNameField";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { readSettings, shopCurrency } from "../services/settings.server";
import { billingFrom } from "../services/billing.server";
import { canUseSurface } from "../lib/billing/plans";
import prisma from "../db.server";
import {
  astFrom,
  compareAtFrom,
  readerFor,
  ruleFrom,
  SCOPE_CONDITION_FIELDS,
} from "../lib/campaigns/draft-form";
import { PageSections, PageShell } from "../components/PageShell";
import { UnsavedChanges } from "../components/UnsavedChanges";
import { DraftPreview } from "../components/DraftPreview";
import { FROM_FILE, RuleValueField } from "../components/RuleValueField";
import { DRAFT_DEFAULTS } from "../lib/campaigns/draft-defaults";
import {
  ImportForm,
  ImportReport,
  type ImportProblem,
} from "../components/imports/ImportForm";
import type { PriceImportResult } from "../services/price-import.server";
import { FieldGrid, FullRow } from "../components/FieldGrid";
import { HelpNote } from "../components/HelpNote";
import { firstPreviewParams } from "../lib/campaigns/first-preview";
import { numberSections } from "../lib/ui/sections";
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

  const [available, segments, priceLists, settings, currency, shopRecord, priceImports] =
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
    // The files this shop has already imported, for the spreadsheet option. One indexed
    // read alongside six others — cheap enough not to be worth loading conditionally,
    // and loading it on demand would mean a table that appears a beat after the option
    // that reveals it.
    prisma.priceImport.findMany({
      where: { shopId: shop.id },
      orderBy: { createdAt: "desc" },
      take: ROWS_PER_VIEW,
      select: {
        id: true,
        name: true,
        currency: true,
        rowsRead: true,
        rowsMatched: true,
        createdBy: true,
        createdAt: true,
      },
    }),
  ]);

  const billing = billingFrom(shopRecord);

  // No preview here, deliberately, and this is load-bearing enough to be worth a
  // paragraph.
  //
  // #442 primed the panel from the loader so it arrived populated. `previewDraft` has to
  // load *every* candidate in scope and plan all of them — the counts are exact, so it
  // cannot sample — and only then keeps 25 rows to show. In front of first paint that is
  // a minute of blank page on a 3,669-variant store and worse on a hundred thousand
  // (#468). Blank is the bad part: nothing has rendered, so there is nothing to put a
  // spinner in, and the page is indistinguishable from the app being broken.
  //
  // The client asks for it instead, once, on mount. Same work, off the critical path,
  // with somewhere to say it is working.

  // Every currency this campaign could price in, for the per-currency rounding selects.
  //
  // Sorted, and therefore **not** a source of "the" currency: the first entry is whichever
  // code sorts first across the shop and its price lists. `baseCurrency` below is the one
  // the rule is actually built in, and anything labelling an amount has to use that
  // (#473).
  const currencies = [
    ...new Set([currency, ...priceLists.map((list) => list.currency)].filter(Boolean)),
  ].sort();

  return {
    // Prefilled, so naming a campaign is never the thing standing between a merchant and
    // a rule. Built here rather than in the component: a name containing today's date
    // computed during render is two different strings on the server and in the browser,
    // which is the hydration mismatch `formatAgo` carries a paragraph about avoiding.
    defaultName: `${practice ? "Practice" : "Sale"} · ${formatDay(new Date(), shop.timezone)}`,
    timeZone: shop.timezone,
    // The clock in that zone, so a merchant can check it against the one on their wall
    // rather than trying to remember what "Asia/Calcutta" means for them. Computed here
    // rather than in the browser — see `formatClock`.
    timeZoneNow: formatClock(new Date(), shop.timezone),
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
    // The currency `ruleFrom` builds the amount in, in both the action and the resource
    // route. Everything that labels or formats an amount reads this, never `currencies[0]`.
    baseCurrency: currency,
    storeRounding: settings.rounding,
    // What the untouched form describes, built here where it can be built reliably.
    // See the note on the mount effect: reading the form for the *first* request gets a
    // scope that matches nothing (#470).
    firstPreview: firstPreviewParams(settings.rounding, url.searchParams).toString(),
    // Each option carries a worked example on a real number, in the shop's own currency.
    // Sami and RUBIX both do this and it is the difference between a merchant guessing
    // what "Nearest 10" means and knowing — see `rounding-example.ts`, and #489 for what
    // the examples turned out to reveal about two of the labels.
    roundingOptions: Object.entries(ROUNDING_LABELS).map(([value, label]) => ({
      value,
      label,
      example: roundingExampleLine(value as RoundingProfileName, currency),
    })),
    facets: available,
    segments,
    usingSegment: segment ? { id: segment.id, name: segment.name, kind: segment.kind } : null,
    practice,
    guided,
    // Set when the merchant arrived by clicking a day on the calendar.
    presetStart: presetStartFor(url.searchParams.get("startAt")),
    // Which way prices change, when a link says so. Four old import URLs redirect here
    // with `ruleKind=from-file`, and a merchant following one of them should land on the
    // file, not on a percentage.
    initialRuleKind:
      url.searchParams.get("ruleKind") === FROM_FILE ? FROM_FILE : DRAFT_DEFAULTS.ruleKind,
    priceImports: priceImports.map((row) => ({
      ...row,
      // `formatWhen`, not a second call to toLocaleString: the locale is centralised
      // there, and a page that picks its own drifts from every other page's dates.
      createdAt: formatWhen(row.createdAt, shop.timezone),
    })),
    selected: {
      collection: url.searchParams.get("collection") ?? "",
      tag: url.searchParams.get("tag") ?? "",
      excludeTag: url.searchParams.get("excludeTag") ?? "",
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
export const SCOPE_FIELDS = [...SCOPE_CONDITION_FIELDS, "segment"] as const;


/** Builds an AST from the simple scope form: all provided conditions ANDed. */

export const action = withGuard("/app/campaigns/new", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const params = new URLSearchParams();
  // The same list the preview reads, not a copy of it. A field in one and not the other
  // is a scope a merchant sets, sees previewed, and does not get — or the reverse, which
  // is worse. Rule 4: preview and execution share one code path.
  for (const field of SCOPE_CONDITION_FIELDS) {
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
    selected,
    segments,
    usingSegment,
    practice,
    guided,
    timeZone,
    timeZoneNow,
    initialRuleKind,
    priceImports,
    priceLists,
    currencies,
    storeRounding,
    roundingOptions,
    presetStart,
    gates,
    planName,
    defaultName,
    firstPreview,
    baseCurrency,
  } = useLoaderData<typeof loader>();

  // The live price preview. Debounced, because it plans the whole scope on every call
  // and a merchant typing "-20" would otherwise ask three times on the way there.
  const previewFetcher = useFetcher<Preview>();
  const formRef = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askedForPreview = useRef(false);

  /**
   * Where "see all rows" points, kept in step with the panel it sits under.
   *
   * Rebuilt whenever a preview comes back rather than on every keystroke: the panel is
   * already debounced, and a link that changed faster than the numbers beside it would
   * send a merchant to a different campaign than the one they were reading about.
   */
  const [fullPreviewHref, setFullPreviewHref] = useState<string | undefined>(undefined);

  /**
   * Which way prices change, held here because two sections depend on the answer.
   *
   * A file carries every price it sets, so there is no scope to choose and no amount to
   * enter — and leaving those on screen inert would be worse than a second page, which is
   * what this replaced. #445.
   */
  const [ruleKind, setRuleKind] = useState<string>(initialRuleKind);
  const fromFile = ruleKind === FROM_FILE;

  // Its own fetcher, posting to the import route. Sharing the editor's would mean one
  // `state` for two very different submissions, so a dry run in flight would put the
  // create button into a loading state it never leaves.
  const importFetcher = useFetcher<{ result?: PriceImportResult }>();
  const importResult = importFetcher.data?.result;
  const importProblems = problemsFrom(importResult);

  const submitPreview = useCallback(() => {
    const form = formRef.current;
    if (!form) return;

    const fields = new FormData(form);
    previewFetcher.submit(fields, {
      method: "post",
      action: "/app/preview-draft",
    });

    // The same fields, as a link. Built from the same FormData the preview was asked
    // with, so the full list is by construction the campaign the panel is describing —
    // reading the form a second time could catch a keystroke in between.
    setFullPreviewHref(`/app/campaigns/preview?${queryFrom(fields)}`);
  }, [previewFetcher]);

  const requestPreview = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(submitPreview, 400);
  }, [submitPreview]);

  // Clear the pending call on unmount, so navigating away mid-type does not fire a
  // request against a page that is gone.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Once, on mount, undebounced, from a payload the loader built rather than from the
  // form.
  //
  // The loader used to price this itself, which put a minute of blank page in front of
  // first paint (#468). Asking from here is the same work with the page already drawn
  // around it — but reading `new FormData(form)` at mount describes something other than
  // what is on screen: an empty filter came back matching nothing (#470). The fields are
  // custom elements, and this is not a thing to bet a preview on. Every later request
  // reads the form, by which point it is trustworthy.
  //
  // A ref rather than an empty dependency array, so the dependencies can be honest. The
  // fetcher changes identity as it moves through its states, so listing it and firing
  // every time would loop; an empty array would mean lying about that in a comment. This
  // says what is meant — ask once — and survives StrictMode's double mount into the
  // bargain.
  useEffect(() => {
    if (askedForPreview.current) return;
    askedForPreview.current = true;

    previewFetcher.submit(new URLSearchParams(firstPreview), {
      method: "post",
      action: "/app/preview-draft",
    });
    setFullPreviewHref(`/app/campaigns/preview?${firstPreview}`);
  }, [firstPreview, previewFetcher]);


  // Numbered from what is actually rendered. Both sections apply today; #445 makes the
  // scope conditional, because a campaign priced from a file has no scope to choose, and
  // a form that jumps from "1 · Rule" to "3 · Schedule" reads as a step gone missing.
  const headings = numberSections([
    { key: "rule", title: "Rule" },
    { key: "scope", title: "Scope" },
  ]);

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
            Start small. Set your rule, then narrow the scope to a handful of
            products — five is plenty — so your first run is quick and easy to check.
            The panel beside it shows every price that would change, before anything is
            applied.
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
      <s-section heading={headings.rule}>
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
                <CampaignNameField defaultName={defaultName} />
              </FullRow>

              {/* Not wrapped in a `FullRow`, deliberately. This renders *two* fields — the
                  adjustment and its amount — as a fragment, so as bare grid children they
                  land side by side, which is the pair a merchant reads as one decision.
                  Inside a `FullRow` they would both go in one cell and stack. */}
              <RuleValueField
                currency={baseCurrency}
                kind={ruleKind}
                onKindChange={setRuleKind}
              />

              {/* Everything below is about arithmetic on a baseline, and a file has
                  none — it names a price per variant. Rendered inert they would be four
                  controls a merchant sets and the import ignores, which is exactly the
                  confusion having two pages caused. */}
              {fromFile ? null : (
                <>
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
                    {/* The example is in the option and not under the select, so all six
                        explain themselves while the merchant is comparing them. A single
                        line describing whichever is currently chosen answers the question
                        after the decision has been made. */}
                    {`${option.label} · ${option.example}`}
                  </s-option>
                ))}
              </s-select>
                </>
              )}
            </FieldGrid>

            {/* What "from the baseline" means, next to the field that says it.
                
                The words are the help centre's — "the price a product would be if no
                campaign were running" — because a merchant who reads one definition here
                and a different one in Help has been given two concepts. The second
                sentence is the consequence, which is the part that sells it: every
                competitor computes from the live price, which is why RUBIX's own FAQ has
                to explain that running two sales leaves a product wrong for ever. */}
            {fromFile ? (
              <s-paragraph>
                <s-text color="subdued">
                  A spreadsheet sets each price directly, so there is no baseline
                  arithmetic and no scope to choose — the file names the variants. It
                  still becomes a campaign, which is what gives it a preview, your
                  guardrails and a one-click revert.
                </s-text>
              </s-paragraph>
            ) : (
              <s-paragraph>
                <s-text color="subdued">
                  Changes are computed from each variant&rsquo;s{" "}
                  <s-text type="strong">baseline</s-text> — the price it would be if no
                  campaign were running — never from what the storefront shows today. So
                  running this campaign twice gives the same result as running it once.
                </s-text>
              </s-paragraph>
            )}

            {/* What this rule does to prices, from the same resolver the run uses --
                not an estimate of it. Sits with the rule rather than at the bottom of
                the page, because it exists to answer "did I mean -20% or x0.20?" while
                the merchant is still deciding. With the rarely-touched settings moved to
                the end, it now lands directly under the rule it is previewing. */}

            {!fromFile && priceLists.length > 0 ? (
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

            {/* Everything from here to the submit belongs to the rule path.
                
                A file import creates its campaign through its own two-phase flow — dry
                run, then commit — so a schedule, a priority and a tag kit set here would
                be silently discarded. The import block below has the submit for that
                path. */}
            {fromFile ? null : (
              <>
            <s-divider />

            <s-heading>Schedule (optional)</s-heading>
            <s-paragraph>
              <s-text>
                Times are in your store&rsquo;s zone, {timeZone}, where it is currently{" "}
                {timeZoneNow}. That comes from your Shopify store settings, so it matches
                your orders. Leave the start blank to run the campaign only when you apply
                it by hand.
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
              </>
            )}
          </s-stack>
      </s-section>
      {/* Not rendered at all, rather than rendered and ignored. A file names its own
          variants — a frozen list of exactly the rows it matched — so a scope here would
          be a control a merchant fills in and the import discards, which is the confusion
          the second page caused in the first place. */}
      {fromFile ? null : (
      <s-section heading={headings.scope}>
        <s-paragraph>
          Which variants the rule above applies to. Leave everything blank to target the
          whole catalogue; conditions combine with AND.
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

          {/* The exception, beside the conditions rather than in its own card.
              
              Sami gives "Exclude products" a card of its own next to "Apply to products";
              here it belongs in the same grid, because it is read as part of one sentence
              — "In Outerwear, tagged sale, except tagged no-sale" — and a second card
              would make the exception look like a second decision.

              A tag rather than a variant picker: a merchant who keeps a list of things
              never to discount already keeps it as a tag, and a picker would be a list
              that goes stale the moment they add a product. */}
          <FullRow>
            <s-select
              name="excludeTag"
              label="Except anything tagged"
              details="Leaves these out of this campaign. They stay eligible for your other campaigns."
            >
              <s-option value="" defaultSelected={!selected.excludeTag}>
                Nothing excluded
              </s-option>
              {available.tags.map((tag) => (
                <s-option
                  key={tag}
                  value={tag}
                  defaultSelected={selected.excludeTag === tag}
                >
                  {tag}
                </s-option>
              ))}
            </s-select>
          </FullRow>
        </FieldGrid>
      </s-section>
      )}

        </PageSections>
      </Form>

      {/* Outside the form, and that is not a detail.
          
          A form cannot contain a form, and the import has one of its own — its two-phase
          dry-run-then-commit is the guard that makes writing prices from a file safe, and
          it posts to `/app/campaigns/import`, whose action, parsing and error reporting
          are untouched by any of this. Rendering it here rather than reimplementing it is
          the whole point: one door for the merchant, one code path for the prices. */}
      {fromFile ? (
        <ImportForm
          heading="The file"
          fetcher={importFetcher}
          action="/app/price-import"
          busy={importFetcher.state !== "idle"}
          ready={importResult?.ready ?? null}
          commitLabel={(ready) => `Create a campaign from ${formatCount(ready)} rows`}
          template={{ href: "/app/campaigns/template.csv", label: "Get a template" }}
          placeholder={`Variant SKU,Variant Price\nCH-1,129.00\nCH-2,149.00`}
          description={
            <s-paragraph>
              <s-text>
                One row per variant: a SKU, barcode or variant ID, then the price. Prices
                are read in {baseCurrency} and must be plain numbers. A Matrixify export
                works as it is. Checking the file changes nothing — you see what would
                happen first.
              </s-text>
            </s-paragraph>
          }
        >
          {/* The campaign's name, again, because this form posts on its own and the one
              in the section above goes with the form it belongs to. */}
          <s-text-field name="name" label="Call this" value={defaultName} />
        </ImportForm>
      ) : null}

      {fromFile ? (
        <>
          <PriceImportHistory imports={priceImports} timeZone={timeZone} />

          {/* Moved here with the table it qualifies. Said out loud rather than papered
              over: the gap is real, and a merchant who imports a baseline file and then
              looks for it in a list is owed the reason it is not there. */}
          <HelpNote label="Only price files are listed">
            <s-paragraph>
              Baseline and cost imports do not record a file yet. Their results are shown
              when you run them, on the pages they belong to.
            </s-paragraph>
          </HelpNote>
        </>
      ) : null}

      {importResult ? (
        <ImportReport
          heading={importResult.dryRun ? "What would happen" : "What happened"}
          counts={[
            { label: "Rows read", value: importResult.total },
            { label: "Ready", value: importResult.ready },
            { label: "Need attention", value: importProblems.length },
          ]}
          problems={importProblems}
        />
      ) : null}

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
        <DraftPreview
          preview={previewFetcher.data ?? null}
          pending={previewFetcher.state !== "idle"}
          // Named only when there is something to distinguish it from. `previewDraft`
          // prices the base surface; on a shop with catalogues the merchant is reading a
          // card headed "on your storefront" and has more than one.
          surface={priceLists.length > 0 ? `base price · ${baseCurrency}` : undefined}
          // The draft, serialised. The campaign does not exist yet — that is what makes
          // it a draft — so there is no id to link by, and the URL is what lets the full
          // preview be reloaded, bookmarked, or opened in a second tab beside this form.
          fullPreviewHref={fullPreviewHref}
        />
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

/**
 * A form's fields as a query string, dropping what a preview has no use for.
 *
 * A file input serialises as a `File`, which stringifies to the useless `[object File]`,
 * and the campaign name would put whatever the merchant typed into a URL for no reason.
 * Everything the preview actually reads is a short scalar.
 */
function queryFrom(fields: FormData): string {
  const params = new URLSearchParams();
  for (const [key, value] of fields.entries()) {
    if (typeof value !== "string" || key === "name") continue;
    if (value !== "") params.append(key, value);
  }
  return params.toString();
}

/**
 * Every row the import could not use, in the order they appear in the file.
 *
 * Sorted by line rather than grouped by kind, because a merchant fixing a spreadsheet
 * works down it — and the four categories are already named on each row.
 */
function problemsFrom(result: PriceImportResult | undefined): ImportProblem[] {
  if (!result) return [];

  return [
    ...result.invalid.map((problem) => ({ ...problem, kind: "Will not parse" })),
    ...result.unmatched.map((problem) => ({ ...problem, kind: "No match" })),
    ...result.ambiguous.map((problem) => ({ ...problem, kind: "Matches several" })),
    ...result.duplicates.map((problem) => ({ ...problem, kind: "Listed twice" })),
  ].sort((a, b) => a.line - b.line);
}
