import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { readSettings, shopCurrency, writeSettings } from "../services/settings.server";
import { keepingOtherPolicies } from "../services/campaigns/model.server";
import { BREACH_POLICY_LABELS, BREACH_POLICY_REACH } from "../lib/campaigns/breach-policy";
import {
  APPROVAL_THRESHOLD_LABEL,
  approvalThresholdFrom,
  CONFIRM_CHANGE_LABEL,
  CONFIRM_VARIANTS_LABEL,
  confirmPercentFrom,
  confirmVariantsFrom,
  guardrailInputProblems,
} from "../lib/settings/guardrail-input";
import {
  mailConfigured,
  readPreferences,
  recentDeliveries,
  writePreferences,
} from "../services/notifications.server";
import { notificationEmailFrom, notificationInputProblems, SEND_TO_LABEL } from "../lib/settings/notification-input";
import { NOTIFICATION_CHOICES } from "../lib/notifications/choices";
import { lastEmailLines, savedAddressLine } from "../lib/notifications/delivery";
import { showToast } from "../lib/ui/toast";
import { actorFor } from "../lib/audit/actor";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import {
  profileNameFor,
  readRoundingPolicy,
  roundingLabel,
} from "../lib/money/rounding-policy";
import { roundingChoices, sampleLine } from "../lib/money/rounding-example";
import { PageSections, PageShell } from "../components/PageShell";
import { SettingsSaveBar } from "../components/SettingsSaveBar";
import { Field, FieldGrid, FullRow } from "../components/FieldGrid";
import { HelpNote } from "../components/HelpNote";
import { formatCount } from "../lib/format/display";
import {
  DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT,
  DEFAULT_CONFIRM_ABOVE_VARIANTS,
  MINIMUM_PRICE_HANDFUL,
} from "../lib/campaigns/blast-radius";
import { SPACE } from "../lib/ui/spacing";
import { Secondary } from "../components/Type";
import { Card } from "../components/Card";

export const loader = withGuard("/app/settings", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [settings, currency, withCost, variants, notifications, marketCurrencies, deliveries] =
    await Promise.all([
      readSettings(shop.id),
      shopCurrency(shop.id),
      // Deleted variants out of both counts (#728): counted in this one only, coverage read
      // over 100% and switched off the warning beneath it.
      prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null, cost: { not: null } } }),
      prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } }),
      readPreferences(shop.id),
      prisma.priceListRecord.findMany({
        where: { shopId: shop.id },
        select: { currency: true },
        distinct: ["currency"],
      }),
      recentDeliveries(shop.id),
    ]);

  // Every currency this store actually prices in. Only these are offered: a list of
  // all 180 world currencies would bury the two or three that matter.
  const currencies = [
    ...new Set([currency, ...marketCurrencies.map((row) => row.currency)].filter(Boolean)),
  ].sort();

  return {
    settings,
    // Running campaigns the breach policy does not reach, named beside it (#789).
    keepingOther: await keepingOtherPolicies(shop.id, settings.violationPolicy),
    currency,
    currencies,
    // Currency-aware: a step is in minor units, so "Nearest 10" means ten cents on a USD
    // store and ten yen on a JPY one, and the option list itself differs (#489).
    roundingOptions: roundingChoices(currency),
    sample: sampleLine(currency),
    withCost,
    variants,
    notifications,
    // Whether this install can actually send, asked of the same function `notify` asks.
    // Shown rather than hidden: a merchant ticking boxes that silently do nothing is worse
    // than being told why.
    mailConfigured: mailConfigured(),
    // What happened to the last email, so a saved address can be seen to work (#1121).
    lastEmail: lastEmailLines(deliveries, shop.timezone),
  };
});

export const action = withGuard("/app/settings", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const actor = actorFor(sessionToken, session.shop);
  const form = await request.formData();

  // One form, one save. It used to be three forms with three intents, each doing
  // `{ ...existing, its own fields }` so the other two survived. That worked and it is
  // also how a bug once switched notification preferences off while saving a guardrail:
  // every write had to remember what it was not touching.
  //
  // With one form every field is present on every save, so nothing depends on being
  // remembered. `{ ...existing }` stays only for fields no control on this page owns.
  const existing = await readSettings(shop.id);

  // Checked before anything is written, settings or notifications, so a refused save
  // changes nothing and the form keeps every edit for the merchant to correct (#739). The
  // address too (#1120): "ops" used to be saved as no address under "Settings saved."
  const read = (name: string) => form.get(name);
  const problems = [
    ...guardrailInputProblems(read, await shopCurrency(shop.id)),
    ...notificationInputProblems(read),
  ];
  if (problems.length > 0) {
    return {
      ok: false,
      message: "Nothing was saved. Correct this and save again:",
      problems: problems.map((problem) => problem.message),
      // Each refusal beside its own field too. The banner is at the top of a long page,
      // and the field may be the last one on it.
      fieldErrors: Object.fromEntries(problems.map((problem) => [problem.field, problem.message])),
    };
  }

  const saved = await writeSettings(
    shop.id,
    {
      ...existing,
      neverBelowCost: form.get("neverBelowCost") === "on",
      // Blank switches approvals off (#788). Missing is not blank: a post without the
      // field -- a tab opened before it existed, a script -- is not the merchant clearing
      // it. Reading it unconditionally once set it to null on every save, which switched
      // approvals off.
      approvalThreshold: form.has("approvalThreshold")
        ? (approvalThresholdFrom(form.get("approvalThreshold")) ?? null)
        : existing.approvalThreshold,
      // The typed confirmation's thresholds (#818), kept the same way when the post does
      // not carry them. A blank one never gets here: it was refused above.
      confirmAboveVariants: confirmVariantsFrom(form.get("confirmAboveVariants")) ?? existing.confirmAboveVariants,
      confirmAboveChangePercent:
        confirmPercentFrom(form.get("confirmAboveChangePercent")) ?? existing.confirmAboveChangePercent,
      minMarginPercent: emptyToNull(form.get("minMarginPercent")),
      minPrice: emptyToNull(form.get("minPrice")),
      violationPolicy: asPolicy(form.get("violationPolicy")),
      missingCostPolicy: form.get("missingCostPolicy") === "error" ? "error" : "skip",
      rounding: readRoundingPolicy(form.entries()),
    },
    actor,
  );

  // Only from a form that showed the Notifications card, which carries the address field.
  // The card is not shown while this deployment cannot send email, and its checkboxes read as
  // "off" when they are not posted: saving a guardrail then would switch every notification
  // off, and they would stay off once sending is set up.
  if (form.has("email")) {
    await writePreferences(
      shop.id,
      {
        // Anything other than one address was refused above.
        email: notificationEmailFrom(form.get("email")) ?? null,
        onCompletion: form.get("onCompletion") === "on",
        onPartialOrFailure: form.get("onPartialOrFailure") === "on",
        onDrift: form.get("onDrift") === "on",
        onRevert: form.get("onRevert") === "on",
        weeklyDigest: form.get("weeklyDigest") === "on",
      },
      actor,
    );
  }

  return {
    ok: true,
    message: "Settings saved.",
    saved,
    problems: [] as string[],
    fieldErrors: {} as Record<string, string>,
  };
});

function emptyToNull(value: FormDataEntryValue | null): number | null {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

function asPolicy(value: FormDataEntryValue | null): "clamp" | "skip" | "block" {
  const text = String(value ?? "");
  return text === "skip" || text === "block" ? text : "clamp";
}

type ActionData = {
  ok: boolean;
  message: string;
  problems?: string[];
  /** A refusal by field name, shown on the field it is about. */
  fieldErrors?: Record<string, string>;
};

type TestResult = { ok: boolean; message: string };

export default function Settings() {
  const {
    settings,
    keepingOther,
    currency,
    currencies,
    roundingOptions,
    sample,
    withCost,
    variants,
    notifications,
    mailConfigured,
    lastEmail,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const tester = useFetcher<TestResult>();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = fetcher.state !== "idle";
  const errors = fetcher.data && !fetcher.data.ok ? (fetcher.data.fieldErrors ?? {}) : {};

  // Said where the merchant is looking (#1119). The banner below is at the top of the page;
  // the save bar is pressed from anywhere on it, often while reading the last card.
  useEffect(() => {
    if (!fetcher.data) return;
    const count = fetcher.data.problems?.length ?? 0;
    showToast(
      fetcher.data.ok
        ? "Settings saved"
        : `Nothing was saved. ${count === 1 ? "One setting needs" : `${count} settings need`} correcting.`,
      !fetcher.data.ok,
    );
  }, [fetcher.data]);

  // A test goes to the saved address, never to one still being typed (#1122): a test that
  // reached an unsaved address would prove nothing about where real emails go.
  const [testNote, setTestNote] = useState<string | null>(null);
  const sendTest = () => {
    const typed = formRef.current ? String(new FormData(formRef.current).get("email") ?? "").trim() : "";
    if (typed !== (notifications.email ?? "")) {
      setTestNote("Save first. A test goes to the saved address, and the one above has changed.");
      return;
    }
    setTestNote(null);
    tester.submit({}, { method: "post", action: "/app/settings/email-check" });
  };
  const testing = tester.state !== "idle";
  const testResult: TestResult | null = testNote
    ? { ok: false, message: testNote }
    : !testing && tester.data
      ? tester.data
      : null;

  const costCoverage = variants === 0 ? 0 : Math.round((withCost / variants) * 100);

  return (
    <PageShell heading="Settings">
      {fetcher.data ? (
        <s-banner tone={fetcher.data.ok ? "success" : "critical"}>
          <s-paragraph>{fetcher.data.message}</s-paragraph>
          {(fetcher.data.problems ?? []).map((problem) => (
            <s-paragraph key={problem}>{problem}</s-paragraph>
          ))}
        </s-banner>
      ) : null}

      <fetcher.Form method="post" ref={formRef}>
      <PageSections>
        {/* Three long sections in one page, so a merchant who came here to change one
            number does not scroll past the other two hunting for it. In-page anchors
            rather than more routes: these settings are read together — a rounding rule
            that pushes a price under a floor is a conversation between two of them —
            and splitting them across pages is what made the nav sixteen items long. */}

        {/* Coverage sits with the fields it qualifies, not in a sidebar card of its own.
            Two of the controls below — "never price at or below cost" and what to do when a
            cost-based floor meets a variant without one — mean nothing until you know how
            many variants that second case actually is. As the card's `secondary` it is
            tight against the lede, which is the point: the two are one thought. */}
        <Card
          heading="Guardrails"
          lede="Floors that no campaign may price below. They are checked after rounding, so a rounding rule cannot push a price under them."
          secondary={
            <>
              {formatCount(withCost)} of {formatCount(variants)} variants have a cost
              ({costCoverage}%). Cost-based floors only constrain those; the last setting
              in this section decides the rest.
            </>
          }
        >

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

            <FieldGrid>
              <FullRow>
              <s-checkbox
                name="neverBelowCost"
                label="Never price at or below cost"
                checked={settings.neverBelowCost || undefined}
              />
              </FullRow>

              <s-number-field
                name="minMarginPercent"
                label="Minimum margin (%)"
                value={settings.minMarginPercent?.toString() ?? ""}
                error={errors.minMarginPercent}
                details="Share of the selling price. 25 means a price of at least cost ÷ 0.75. Leave blank for none."
              />

              {/* A money field, not a number field. This is a price, and the two differ
                  in how they handle the decimal separator a merchant's locale uses and
                  how many places the currency actually has — a generic number input is
                  where a ¥1,000 floor becomes ¥1,000.00 and then something else. */}
              <s-money-field
                name="minPrice"
                label={`Minimum price (${currency})`}
                value={settings.minPrice?.toString() ?? ""}
                error={errors.minPrice}
                details="An absolute floor, whatever the rule computes. Leave blank for none."
              />

              {/* What it reaches, said on the field (#789): it read as store-wide, and every
                  campaign that existed when it was saved went on with the policy it was made with. */}
              <s-select name="violationPolicy" label="When a price would breach a floor" details={BREACH_POLICY_REACH}>
                {(["clamp", "skip", "block"] as const).map((policy) => (
                  <s-option key={policy} value={policy} defaultSelected={settings.violationPolicy === policy}>
                    {BREACH_POLICY_LABELS[policy]}
                  </s-option>
                ))}
              </s-select>

              <s-select
                name="missingCostPolicy"
                label="When a cost-based floor meets a variant with no cost"
              >
                <s-option value="skip" defaultSelected={settings.missingCostPolicy === "skip"}>
                  Skip that variant
                </s-option>
                <s-option value="error" defaultSelected={settings.missingCostPolicy === "error"}>
                  Fail the campaign
                </s-option>
              </s-select>
            </FieldGrid>

            {/* The running campaigns the saved policy does not reach, by name (#789). */}
            {keepingOther.total > 0 ? (
              <s-stack gap={SPACE.tight}>
                <s-text>
                  These are running, so they keep the policy they started with until they end, not the one saved above:
                </s-text>
                <s-unordered-list>
                  {keepingOther.campaigns.map((campaign) => (
                    <s-list-item key={campaign.id}>
                      <s-link href={`/app/campaigns/${campaign.id}`}>{campaign.name}</s-link>:{" "}
                      {BREACH_POLICY_LABELS[campaign.policy].toLowerCase()}
                    </s-list-item>
                  ))}
                </s-unordered-list>
                {keepingOther.total > keepingOther.campaigns.length ? (
                  <Secondary>And {formatCount(keepingOther.total - keepingOther.campaigns.length)} more.</Secondary>
                ) : null}
              </s-stack>
            ) : null}
        </Card>

        {/* The typed confirmation's two thresholds (A-3.11, #818). Beside the guardrails
            because they answer the same worry -- a campaign that is wrong -- and their own
            card because they bound a campaign, not a price. Neither has an "off": the
            `secondary` says what still asks whatever these are set to. */}
        <Card
          heading="Typed confirmation"
          lede="A campaign over either number below cannot be applied until “apply” is typed in its confirmation. Reverting never asks."
          secondary={`A campaign that would take more than ${MINIMUM_PRICE_HANDFUL} prices to zero asks too, whatever these are set to.`}
        >
          <FieldGrid>
            <s-number-field
              name="confirmAboveVariants"
              label={CONFIRM_VARIANTS_LABEL}
              value={settings.confirmAboveVariants.toString()}
              error={errors.confirmAboveVariants}
              details={`A whole number. ${formatCount(DEFAULT_CONFIRM_ABOVE_VARIANTS)} means a campaign writing ${formatCount(DEFAULT_CONFIRM_ABOVE_VARIANTS + 1)} prices or more asks.`}
            />
            <s-number-field
              name="confirmAboveChangePercent"
              label={CONFIRM_CHANGE_LABEL}
              value={settings.confirmAboveChangePercent.toString()}
              error={errors.confirmAboveChangePercent}
              details={`1 to 100, from each price's baseline, or that far below its cost. ${DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT} means 60% off asks and 40% off does not.`}
            />
          </FieldGrid>
        </Card>

        {/* Its own card rather than one more guardrail (#788). A guardrail bounds a price;
            this decides whether a campaign may run at all, and the consequence in
            `secondary` -- nobody can approve their own request -- is what a merchant on a
            one-person store needs to read before typing a number here. */}
        <Card
          heading="Approvals"
          lede="A campaign changing more variants than the number below cannot run, by hand or on its schedule, until somebody other than the person who asked approves it."
          secondary="Nobody can approve their own request, so on a store with one staff account it stops those campaigns running at all."
        >
          <Field width="medium">
            <s-number-field
              name="approvalThreshold"
              label={APPROVAL_THRESHOLD_LABEL}
              value={settings.approvalThreshold?.toString() ?? ""}
              error={errors.approvalThreshold}
              details="A whole number: 500 means a campaign changing 501 variants or more waits for approval. Leave blank for off."
            />
          </Field>
        </Card>

        <Card heading="Rounding">      <s-paragraph>
            <s-text>
              How campaign prices are tidied up after the discount is calculated. Set
              once here; each campaign can override it.
            </s-text>
          </s-paragraph>

            <s-stack gap={SPACE.section}>
              {/* A rounding rule is half a dozen words. Unbounded it was a 970px bar, and
                  the per-currency selects below it were five more. */}
              <Field width="medium">
                <s-select
                  name="rounding.default"
                  label="Everywhere, unless overridden"
                  /* Said once, above six options that each show only their own result.
                     Repeating "$2,347.62 becomes" in all six is what made the longest of
                     them too long to read inside a closed select. */
                  details={sample}
                >
                  {roundingOptions.map((option) => (
                    <s-option
                      key={option.value}
                      value={option.value}
                      defaultSelected={option.value === settings.rounding.default}
                    >
                      {option.label}
                    </s-option>
                  ))}
                </s-select>
              </Field>

              {currencies.length > 1 ? (
                <>
                  <s-paragraph>
                    <s-text>
                      A price ending that looks considered in one currency can look like
                      a mistake in another, and some currencies have no cents to end in.
                    </s-text>
                  </s-paragraph>

                  {currencies.map((code) => {
                    // What this currency will actually do, which is not always what the
                    // default says: a .99 ending has nowhere to go in a currency with no
                    // decimal places, so it shows as the step rounding it becomes.
                    const effective = profileNameFor(settings.rounding, code);

                    return (
                      <Field key={code} width="medium">
                      <s-select
                        name={`rounding.${code}`}
                        label={`${code}${code === currency ? " (your store's currency)" : ""}`}
                      >
                        <s-option
                          value="inherit"
                          defaultSelected={!settings.rounding.byCurrency[code]}
                        >
                          Use the setting above ({roundingLabel(effective, code).toLowerCase()})
                        </s-option>
                        {roundingOptions.map((option) => (
                          <s-option
                            key={option.value}
                            value={option.value}
                            defaultSelected={settings.rounding.byCurrency[code] === option.value}
                          >
                            {option.label}
                          </s-option>
                        ))}
                      </s-select>
                      </Field>
                    );
                  })}
                </>
              ) : null}
            </s-stack>
        </Card>

        {/* Offered only where it can be kept (#1118): while this deployment cannot send
            email the card is not shown, rather than a card whose every choice leads nowhere.
            App Review saved an address here, reverted a campaign, and no email came (2.1.4).
            Preferences already saved are kept, and the card comes back once sending is set
            up. */}
        {mailConfigured ? (
        <Card heading="Notifications">      <s-paragraph>
            <s-text>
              A campaign over a large catalogue runs for a while. These let you close the
              tab and still find out what happened.
            </s-text>
          </s-paragraph>

            <s-stack gap={SPACE.section}>
              <Field width="medium">
                {/* An email field, for the keyboard and autofill a phone offers it (#1120). */}
                <s-email-field
                  name="email"
                  label={SEND_TO_LABEL}
                  placeholder="ops@yourshop.com"
                  value={notifications.email ?? ""}
                  error={errors.email}
                  details="One address. Leave blank to turn notifications off entirely."
                />
              </Field>

              {/* What is stored, read back after every save (#1119). The field shows what
                  was typed, which looks the same before a save and after one. */}
              <s-stack gap={SPACE.tight}>
                <s-text>{savedAddressLine(notifications.email)}</s-text>
                <Secondary>{lastEmail.sent}</Secondary>
                {lastEmail.problem ? <s-text tone="caution">{lastEmail.problem}</s-text> : null}
              </s-stack>

              {/* Checked without touching a price (#1122). App Review applied and reverted a
                  campaign on live prices to find out whether email worked. */}
              <s-stack direction="inline" gap={SPACE.item} alignItems="center">
                <s-button type="button" onClick={sendTest} loading={testing || undefined}>
                  Send test email
                </s-button>
                {testResult ? (
                  <s-text tone={testResult.ok ? "success" : "critical"}>{testResult.message}</s-text>
                ) : null}
              </s-stack>

              {NOTIFICATION_CHOICES.map((choice) => (
                <s-checkbox
                  key={choice.key}
                  name={choice.key}
                  label={choice.label}
                  details={choice.details}
                  checked={notifications[choice.key] || undefined}
                />
              ))}
            </s-stack>

          <s-paragraph>
            <s-text>
              Emails carry counts only — how many variants changed, failed or were
              skipped. No prices are ever included, because email is not a place your
              pricing should end up.
            </s-text>
          </s-paragraph>
        </Card>
        ) : null}

      </PageSections>
      </fetcher.Form>

      <SettingsSaveBar form={formRef} saving={busy} />

      <HelpNote label="Why floors are checked last">
        <s-paragraph>
          A campaign computes from the baseline, rounds, and only then checks the floor.
          Rounding down can push an otherwise-legal price under the line, so checking
          earlier would let it through.
        </s-paragraph>
        <Secondary>
          A price is never zero or negative, whatever these settings say.
        </Secondary>
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
