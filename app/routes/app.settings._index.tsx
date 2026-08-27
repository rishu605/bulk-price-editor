import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useRef } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { readSettings, shopCurrency, writeSettings } from "../services/settings.server";
import { readPreferences, writePreferences } from "../services/notifications.server";
import { actorFor } from "../lib/audit/actor";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import {
  profileNameFor,
  readRoundingPolicy,
  ROUNDING_LABELS,
} from "../lib/money/rounding-policy";
import { PageShell } from "../components/PageShell";
import { SettingsSaveBar } from "../components/SettingsSaveBar";

export const loader = withGuard("/app/settings", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [settings, currency, withCost, variants, notifications, marketCurrencies] =
    await Promise.all([
      readSettings(shop.id),
      shopCurrency(shop.id),
      prisma.variantIndex.count({ where: { shopId: shop.id, cost: { not: null } } }),
      prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } }),
      readPreferences(shop.id),
      prisma.priceListRecord.findMany({
        where: { shopId: shop.id },
        select: { currency: true },
        distinct: ["currency"],
      }),
    ]);

  // Every currency this store actually prices in. Only these are offered: a list of
  // all 180 world currencies would bury the two or three that matter.
  const currencies = [
    ...new Set([currency, ...marketCurrencies.map((row) => row.currency)].filter(Boolean)),
  ].sort();

  return {
    settings,
    currency,
    currencies,
    roundingOptions: Object.entries(ROUNDING_LABELS).map(([value, label]) => ({ value, label })),
    withCost,
    variants,
    notifications,
    // Whether the deployment can actually send. Shown rather than hidden: a merchant
    // ticking boxes that silently do nothing is worse than being told why.
    mailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL),
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

  const saved = await writeSettings(
    shop.id,
    {
      ...existing,
      neverBelowCost: form.get("neverBelowCost") === "on",
      approvalThreshold: emptyToNull(form.get("approvalThreshold")),
      minMarginPercent: emptyToNull(form.get("minMarginPercent")),
      minPrice: emptyToNull(form.get("minPrice")),
      violationPolicy: asPolicy(form.get("violationPolicy")),
      missingCostPolicy: form.get("missingCostPolicy") === "error" ? "error" : "skip",
      rounding: readRoundingPolicy(form.entries()),
    },
    actor,
  );

  await writePreferences(shop.id, {
    email: String(form.get("email") ?? ""),
    onCompletion: form.get("onCompletion") === "on",
    onPartialOrFailure: form.get("onPartialOrFailure") === "on",
    onDrift: form.get("onDrift") === "on",
    onRevert: form.get("onRevert") === "on",
    weeklyDigest: form.get("weeklyDigest") === "on",
  });

  return { ok: true, message: "Settings saved.", saved };
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
  const {
    settings,
    currency,
    currencies,
    roundingOptions,
    withCost,
    variants,
    notifications,
    mailConfigured,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const formRef = useRef<HTMLFormElement>(null);
  const busy = fetcher.state !== "idle";

  const costCoverage = variants === 0 ? 0 : Math.round((withCost / variants) * 100);

  return (
    <PageShell heading="Settings">
      {fetcher.data ? (
        <s-banner tone="success">
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <fetcher.Form method="post" ref={formRef}>
      {/* Three long sections in one page, so a merchant who came here to change one
          number does not scroll past the other two hunting for it. In-page anchors
          rather than more routes: these settings are read together — a rounding rule
          that pushes a price under a floor is a conversation between two of them —
          and splitting them across pages is what made the nav sixteen items long. */}
      <s-section>
        <s-stack direction="inline" gap="base">
          <s-text tone="neutral">Jump to</s-text>
          <s-link href="#guardrails">Guardrails</s-link>
          <s-link href="#rounding">Rounding</s-link>
          <s-link href="#notifications">Alerts</s-link>
        </s-stack>
      </s-section>

      <s-section id="guardrails" heading="Guardrails">
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

          <s-stack gap="base">
            <s-checkbox
              name="neverBelowCost"
              label="Never price at or below cost"
              checked={settings.neverBelowCost || undefined}
            />

            <s-number-field
              name="minMarginPercent"
              label="Minimum margin (%)"
              value={settings.minMarginPercent?.toString() ?? ""}
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
              details="An absolute floor, whatever the rule computes. Leave blank for none."
            />

            <s-select name="violationPolicy" label="When a price would breach a floor">
              <s-option value="clamp" defaultSelected={settings.violationPolicy === "clamp"}>
                Clamp it to the floor and carry on
              </s-option>
              <s-option value="skip" defaultSelected={settings.violationPolicy === "skip"}>
                Skip that variant, price the rest
              </s-option>
              <s-option value="block" defaultSelected={settings.violationPolicy === "block"}>
                Block the whole campaign
              </s-option>
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
          </s-stack>
      </s-section>

      <s-section id="rounding" heading="Rounding">
        <s-paragraph>
          <s-text>
            How campaign prices are tidied up after the discount is calculated. Set
            once here; each campaign can override it.
          </s-text>
        </s-paragraph>

          <s-stack gap="base">
            <s-select name="rounding.default" label="Everywhere, unless overridden">
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
                    <s-select
                      key={code}
                      name={`rounding.${code}`}
                      label={`${code}${code === currency ? " (your store's currency)" : ""}`}
                    >
                      <s-option
                        value="inherit"
                        defaultSelected={!settings.rounding.byCurrency[code]}
                      >
                        Use the setting above ({ROUNDING_LABELS[effective].toLowerCase()})
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
                  );
                })}
              </>
            ) : null}
          </s-stack>
      </s-section>

      <s-section id="notifications" heading="Notifications">
        <s-paragraph>
          <s-text>
            A campaign over a large catalogue runs for a while. These let you close the
            tab and still find out what happened.
          </s-text>
        </s-paragraph>

        {!mailConfigured ? (
          <s-banner tone="warning">
            <s-paragraph>
              Email is not configured on this deployment, so nothing is sent yet. Your
              preferences are saved and take effect once it is.
            </s-paragraph>
          </s-banner>
        ) : null}

          <s-stack gap="base">
            <s-text-field
              name="email"
              label="Send to"
              placeholder="ops@yourshop.com"
              value={notifications.email ?? ""}
              details="Leave blank to turn notifications off entirely."
            />

            <s-checkbox
              name="onPartialOrFailure"
              label="A run did not finish cleanly"
              details="Something needs you: rows failed, or the run stopped early."
              checked={notifications.onPartialOrFailure || undefined}
            />
            <s-checkbox
              name="onDrift"
              label="Someone changed a price outside the app"
              details="Those edits are held for your decision rather than overwritten."
              checked={notifications.onDrift || undefined}
            />
            <s-checkbox
              name="onRevert"
              label="A campaign was reverted"
              checked={notifications.onRevert || undefined}
            />
            <s-checkbox
              name="onCompletion"
              label="A run finished cleanly"
              details="Off by default. Being emailed about every success is how the one email that mattered gets skimmed past."
              checked={notifications.onCompletion || undefined}
            />
            <s-checkbox
              name="weeklyDigest"
              label="Weekly summary"
              checked={notifications.weeklyDigest || undefined}
            />
          </s-stack>

        <s-paragraph>
          <s-text>
            Emails carry counts only — how many variants changed, failed or were
            skipped. No prices are ever included, because email is not a place your
            pricing should end up.
          </s-text>
        </s-paragraph>
      </s-section>

      </fetcher.Form>

      <SettingsSaveBar form={formRef} saving={busy} />

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
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
