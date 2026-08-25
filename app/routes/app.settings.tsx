import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { readSettings, shopCurrency, writeSettings } from "../services/settings.server";
import { readPreferences, writePreferences } from "../services/notifications.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";

export const loader = withGuard("/app/settings", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [settings, currency, withCost, variants, notifications] = await Promise.all([
    readSettings(shop.id),
    shopCurrency(shop.id),
    prisma.variantIndex.count({ where: { shopId: shop.id, cost: { not: null } } }),
    prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } }),
    readPreferences(shop.id),
  ]);

  return {
    settings,
    currency,
    withCost,
    variants,
    notifications,
    // Whether the deployment can actually send. Shown rather than hidden: a merchant
    // ticking boxes that silently do nothing is worse than being told why.
    mailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.NOTIFICATION_FROM_EMAIL),
  };
});

export const action = withGuard("/app/settings", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  if (String(form.get("intent")) === "notifications") {
    await writePreferences(shop.id, {
      email: String(form.get("email") ?? ""),
      onCompletion: form.get("onCompletion") === "on",
      onPartialOrFailure: form.get("onPartialOrFailure") === "on",
      onDrift: form.get("onDrift") === "on",
      onRevert: form.get("onRevert") === "on",
      weeklyDigest: form.get("weeklyDigest") === "on",
    });
    return { ok: true, message: "Notification preferences saved." };
  }

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
  const { settings, currency, withCost, variants, notifications, mailConfigured } =
    useLoaderData<typeof loader>();
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

      <s-section heading="Notifications">
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

        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="notifications" />
          <s-stack gap="base">
            <s-text-field
              name="email"
              label="Send to"
              placeholder="ops@yourshop.com"
              defaultValue={notifications.email ?? ""}
              details="Leave blank to turn notifications off entirely."
            />

            <s-checkbox
              name="onPartialOrFailure"
              label="A run did not finish cleanly"
              details="Something needs you: rows failed, or the run stopped early."
              defaultChecked={notifications.onPartialOrFailure || undefined}
            />
            <s-checkbox
              name="onDrift"
              label="Someone changed a price outside the app"
              details="Those edits are held for your decision rather than overwritten."
              defaultChecked={notifications.onDrift || undefined}
            />
            <s-checkbox
              name="onRevert"
              label="A campaign was reverted"
              defaultChecked={notifications.onRevert || undefined}
            />
            <s-checkbox
              name="onCompletion"
              label="A run finished cleanly"
              details="Off by default. Being emailed about every success is how the one email that mattered gets skimmed past."
              defaultChecked={notifications.onCompletion || undefined}
            />
            <s-checkbox
              name="weeklyDigest"
              label="Weekly summary"
              defaultChecked={notifications.weeklyDigest || undefined}
            />

            <s-button type="submit" variant="primary" loading={busy || undefined}>
              Save notification preferences
            </s-button>
          </s-stack>
        </fetcher.Form>

        <s-paragraph>
          <s-text>
            Emails carry counts only — how many variants changed, failed or were
            skipped. No prices are ever included, because email is not a place your
            pricing should end up.
          </s-text>
        </s-paragraph>
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
