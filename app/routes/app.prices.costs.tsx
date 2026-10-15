/**
 * Editing costs in bulk, and the warning that follows.
 *
 * The editor is straightforward. The banner above it is the point: a cost change can put
 * a campaign that is already running below its own floor, and nothing about the storefront
 * changes to say so. No run fails, nothing alerts, and the merchant loses money on every
 * sale until somebody notices.
 *
 * We report it and stop there. Repricing a live campaign because a cost moved would be the
 * app changing prices on its own initiative — the one thing it must never do — and a
 * merchant may well decide to honour the sale and take the margin hit.
 */

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import { editCosts, newlyViolating, type CostEditResult } from "../services/cost-edit.server";
import { describeCostRule } from "../lib/pricing/cost-rules";
import {
  changedMessage,
  checkedMessage,
  costCount,
  costScopeOf,
  readCommit,
  readCostForm,
} from "../lib/pricing/cost-form";
import { format } from "../lib/money/format";
import { facetDetails } from "../lib/segments/facets";
import { facets, type FilterAst } from "../services/segments.server";
import { actorFor } from "../lib/audit/actor";
import { ActionRow } from "../components/ActionRow";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { FieldGrid, FullRow } from "../components/FieldGrid";
import { ImportForm, ImportReport, type ImportProblem } from "../components/imports/ImportForm";
import { importCosts, type CostImportResult } from "../services/cost-import.server";
import { costErrorCsv } from "../lib/reporting/cost-errors";
import { linesOf } from "../lib/reporting/lines";
import { isCommit } from "../lib/imports/intent";
import { importCheckKey, uncheckedCommit } from "../lib/imports/check-key.server";
import { reportError } from "../services/error-report.server";
import { SPACE } from "../lib/ui/spacing";
import { Card } from "../components/Card";
import { Secondary } from "../components/Type";
import {
  COST_CHANGE_MODAL_ID,
  CostChangeConfirmation,
  type CostCheck,
} from "../components/prices/CostChangeConfirmation";

export const loader = withGuard("/app/prices/costs", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const [available, currency, withCost, variants, violations] = await Promise.all([
    facets(shop.id),
    shopCurrency(shop.id),
    prisma.variantIndex.count({ where: { shopId: shop.id, cost: { not: null }, deletedAt: null } }),
    prisma.variantIndex.count({ where: { shopId: shop.id, deletedAt: null } }),
    newlyViolating(shop.id),
  ]);

  return {
    currency,
    withCost,
    variants,
    vendors: available.vendors,
    vendorTotal: available.totals.vendors,
    violations: violations.slice(0, 25).map((violation) => ({
      campaignId: violation.campaignId,
      campaignName: violation.campaignName,
      title: violation.title,
      live: format(violation.live),
      floor: format(violation.floor),
    })),
    violationCount: violations.length,
  };
});

type ActionData = {
  ok: boolean;
  message: string;
  /** The form field a refusal is about, so the field can say so as well as the banner. */
  field?: "value";
  result?: CostEditResult;
  /** What a dry run of the bulk editor counted. Absent after a commit, which spends it. */
  check?: CostCheck;
  /** Set on every answer to the import, so its banner shows by the import, not the editor. */
  from?: "import";
  imported?: CostImportResult;
  /** The key of the rows the import checked, posted back with its commit (#1059). */
  checkKey?: string;
  errorId?: string | null;
};

/**
 * The two things a merchant can do to costs in bulk, on one route.
 *
 * Importing costs was `/app/imports/costs` — a tab called "Costs" in a nav section named
 * after a verb, beside a tab called "Costs" in Prices. Two right answers to "where do I
 * set costs", which is the collision that made Imports worth dissolving.
 *
 * They share a route, so they cannot share an `intent`. The import's pair is namespaced
 * and dispatched first; the bulk editor keeps the bare pair it always had. Both read it
 * through `isCommit`, so the property that matters — a missing or misspelled intent
 * writes nothing — is one function with a test rather than two string comparisons.
 */
export const IMPORT_INTENT = { check: "import-dry-run", commit: "import-commit" } as const;

export const action = withGuard("/app/prices/costs", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const currency = await shopCurrency(shop.id);
  const intent = form.get("intent");

  if (intent === IMPORT_INTENT.check || intent === IMPORT_INTENT.commit) {
    const dryRun = !isCommit(intent, IMPORT_INTENT.commit);
    const csv = String(form.get("csv") ?? "");

    // A commit of rows nobody checked is refused before anything is read (#1059).
    const unchecked = dryRun
      ? null
      : uncheckedCommit(form.get("checked"), csv, {
          outcome: "no costs were written",
          next: "import what the check shows",
        });
    if (unchecked) return { ...unchecked, from: "import" as const };

    try {
      const imported = await importCosts(shop.id, linesOf(csv), currency, {
        dryRun,
        actor: actorFor(sessionToken, session.shop),
      });

      return {
        ok: true,
        from: "import" as const,
        imported,
        // The rows a commit may write; a commit's answer has none, so it spends the check.
        checkKey: dryRun ? importCheckKey(csv) : undefined,
        message: imported.dryRun
          ? `${imported.ready} of ${imported.total} rows would be imported. Nothing has been written.`
          : `Imported ${imported.written} costs.` +
            (imported.unchanged > 0
              ? ` ${imported.unchanged} already matched and were left alone.`
              : ""),
      };
    } catch (error) {
      const reported = await reportError(error, {
        shopId: shop.id,
        shop: session.shop,
        route: "/app/prices/costs",
      });
      return { ok: false, from: "import" as const, message: reported.userMessage, errorId: reported.errorId };
    }
  }

  // The bulk editor. Read through `readCostForm`, which the page reads its own fields with
  // too, so "the values that were checked" means one thing on both sides (#754).
  const read = readCostForm(form, currency);
  if (!read.ok) return { ok: false, field: read.field, message: read.message };

  const { vendor, rule, key } = read;
  const ast: FilterAst = vendor ? { groups: [{ conditions: [{ field: "vendor", value: vendor }] }] } : { groups: [] };

  const dryRun = !isCommit(intent);

  // A commit carries the check it follows: the key of what was counted, and the count the
  // confirmation named. Without both, or with a form that has moved since, nothing is
  // written — this button committed straight from the form once, on an amount the page
  // had typed for the merchant.
  const commit = dryRun ? null : readCommit(key, form);
  if (commit && !commit.ok) return { ok: false, message: commit.message };

  try {
    const result = await editCosts(shop.id, ast, rule, {
      dryRun,
      actor: actorFor(sessionToken, session.shop),
      expectedChanged: commit?.ok ? commit.expected : undefined,
    });

    const check: CostCheck | undefined = dryRun
      ? {
          key,
          changed: result.changed,
          matched: result.matched,
          skipped: result.skipped.length,
          rule: describeCostRule(rule),
          scope: costScopeOf(vendor),
        }
      : undefined;

    return {
      ok: true,
      result,
      check,
      message: dryRun ? checkedMessage(rule, result) : changedMessage(result.changed),
    };
  } catch (error) {
    const reported = await reportError(error, {
      shopId: shop.id,
      shop: session.shop,
      route: "/app/prices/costs",
    });
    return { ok: false, message: reported.userMessage, errorId: reported.errorId };
  }
});

export default function Costs() {
  const { currency, withCost, variants, vendors, vendorTotal, violations, violationCount } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  const form = useRef<HTMLFormElement>(null);
  const intent = useRef<HTMLInputElement>(null);

  const submitWith = (value: string) => {
    if (intent.current) intent.current.value = value;
    form.current?.requestSubmit();
  };

  // What the last check counted, while it is still the answer on screen. A commit's own
  // response has none, so committing spends the check and the next change needs another.
  const check = fetcher.data?.check ?? null;

  // The form as it stands now, keyed the way the check was. Listened to natively: React 18
  // never delivers `onChange` from a Polaris field (#863). Read again whenever an answer
  // arrives as well, so a field that settles its value after its event cannot leave the
  // button comparing against a keystroke ago.
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const element = form.current;
    if (!element) return;
    const read = () => {
      const now = readCostForm(new FormData(element), currency);
      setCurrent(now.ok ? now.key : null);
    };
    read();
    element.addEventListener("input", read);
    element.addEventListener("change", read);
    return () => {
      element.removeEventListener("input", read);
      element.removeEventListener("change", read);
    };
  }, [currency, fetcher.data]);

  // Committing needs a check of exactly these values that found something to change.
  // The action holds the same line; this is the page not offering what it would refuse.
  const ready = check !== null && check.changed > 0 && current === check.key;
  const stale = check !== null && current !== check.key;

  const coverage = variants === 0 ? 0 : Math.round((withCost / variants) * 100);
  // One fetcher, two forms: each answer is said beside the form that asked (#1059).
  const editorAnswer = fetcher.data?.from === "import" ? undefined : fetcher.data;
  const importAnswer = fetcher.data?.from === "import" ? fetcher.data : undefined;
  const imported = importAnswer?.imported;

  const problems: ImportProblem[] = imported
    ? [
        ...imported.invalid.map((problem) => ({ ...problem, kind: "Will not parse" })),
        ...imported.unmatched.map((problem) => ({ ...problem, kind: "No match" })),
        ...imported.ambiguous.map((problem) => ({ ...problem, kind: "Matches several" })),
        ...imported.duplicates.map((problem) => ({ ...problem, kind: "Listed twice" })),
      ].sort((a, b) => a.line - b.line)
    : [];

  return (
    <PageShell heading="Costs">
      {violationCount > 0 ? (
        <s-banner tone="critical">
          <s-heading>A cost change has put live prices below your floor</s-heading>
          <s-paragraph>
            {violationCount} {violationCount === 1 ? "product is" : "products are"} selling
            below what your guardrails allow. Nothing on your storefront changed — the cost
            did, and these prices were set before it.
          </s-paragraph>
          <s-unordered-list>
            {violations.map((violation) => (
              <s-list-item key={`${violation.campaignId}-${violation.title}`}>
                {violation.title} — selling at {violation.live}, floor is {violation.floor} (
                {violation.campaignName})
              </s-list-item>
            ))}
          </s-unordered-list>
          <s-paragraph>
            <s-text>
              Re-preview the campaign to reprice these, or leave them if you would rather
              honour the sale. We will not change them on our own.
            </s-text>
          </s-paragraph>
        </s-banner>
      ) : null}


      <Card heading="What your cost floors can protect">    <s-paragraph>
          <s-text>
            {withCost} of {variants} variants have a cost ({coverage}%). Cost-based
            guardrails skip the rest entirely, so a low number here means &ldquo;never
            price below cost&rdquo; is doing less than it looks.
          </s-text>
        </s-paragraph>
      </Card>

      <Card heading="Change costs in bulk">    {editorAnswer ? (
          <s-banner tone={editorAnswer.ok ? "success" : "critical"}>
            <s-paragraph>{editorAnswer.message}</s-paragraph>
          </s-banner>
        ) : null}

        <fetcher.Form method="post" ref={form}>
          {/* `s-button` takes no name/value, so the intent rides in a hidden field the
              buttons set before submitting. One form, because both actions read the same
              rule and duplicating the fields would let them drift apart. */}
          <input type="hidden" name="intent" ref={intent} value="dry-run" readOnly />
          {/* The check a commit follows, posted back so the action can refuse one whose
              form has moved since — and the count the confirmation named, so it can
              refuse one whose catalogue has. */}
          <input type="hidden" name="checked" value={check?.key ?? ""} readOnly />
          <input type="hidden" name="expected" value={check?.changed ?? ""} readOnly />
          {/* A grid, not a stack.

              Stacked, each of these took the full width of the card: a "Which products"
              select holding the words "Every product" rendered nine hundred and seventy
              pixels wide, and so did a two-digit percentage. `FieldGrid`'s own doc
              comment calls that "the single most unstyled-looking thing in this app" —
              and this page was one of the four still doing it. */}
          <s-stack gap={SPACE.section}>
            <FieldGrid>
            <s-select
              name="vendor"
              label="Which products"
              details={facetDetails(vendorTotal, "vendors")}
            >
              <s-option value="" defaultSelected>
                Every product
              </s-option>
              {vendors.map((vendor) => (
                <s-option key={vendor} value={vendor}>
                  {vendor}
                </s-option>
              ))}
            </s-select>

            <s-select name="ruleKind" label="Change">
              <s-option value="percent-change" defaultSelected>
                Adjust the existing cost by a percentage
              </s-option>
              <s-option value="fixed-change">Add or subtract a fixed amount</s-option>
              <s-option value="set-exact">Set an exact cost</s-option>
              <s-option value="share-of-price">
                Set cost to a percentage of the normal price
              </s-option>
            </s-select>

            <FullRow>
              {/* Empty, and required. It opened at 4, which nobody typed: one click of the
                  button beside the check raised 2,699 costs by it on a real store (#754).
                  An amount is the merchant's to give, and the action refuses a form
                  without one rather than reading the gap as zero. */}
              <s-number-field
                name="value"
                label={`Amount (percent, or ${currency})`}
                required
                error={fetcher.data?.field === "value" ? fetcher.data.message : undefined}
                details="Products with no cost are skipped by the first two rules rather than treated as zero."
              />
            </FullRow>
            </FieldGrid>

            <ActionRow>
              <s-button
                type="button"
                variant="primary"
                loading={busy || undefined}
                onClick={() => submitWith("dry-run")}
              >
                Check without changing
              </s-button>
              {/* Opens the confirmation; it does not commit. Disabled until a check of
                  these exact values has found something to change, and named for what
                  it found, the way the import's "Import 12 costs" is. */}
              <s-button
                type="button"
                tone="critical"
                loading={busy || undefined}
                disabled={!ready || undefined}
                commandFor={COST_CHANGE_MODAL_ID}
                command="--show"
              >
                {ready && check ? `Change ${costCount(check.changed)}` : "Change these costs"}
              </s-button>
            </ActionRow>

            {stale ? (
              <Secondary>
                The form has changed since it was checked. Check it again to see what these
                values would change.
              </Secondary>
            ) : null}
          </s-stack>
        </fetcher.Form>

        {fetcher.data?.result && fetcher.data.result.skipped.length > 0 ? (
          <s-unordered-list>
            {fetcher.data.result.skipped.slice(0, 10).map((entry) => (
              <s-list-item key={entry.variantGid}>{entry.reason}</s-list-item>
            ))}
          </s-unordered-list>
        ) : null}
      </Card>

      {/* Outside the card: a dialog is not one of the card's actions, and its primary
          button is the dialog's, not a second black button on the form. */}
      {check && check.changed > 0 ? (
        <CostChangeConfirmation check={check} busy={busy} onConfirm={() => submitWith("commit")} />
      ) : null}

      <ImportForm
        heading="Import costs from a spreadsheet"
        fetcher={fetcher}
        busy={busy}
        intent={IMPORT_INTENT}
        ready={imported?.ready ?? null}
        checkKey={importAnswer?.checkKey}
        checkLabel="Check the file"
        commitLabel={(ready) => `Import ${ready} costs`}
        placeholder={"Variant SKU,Variant Cost\nCH-1,12.50\nCH-2,14.00"}
        description={
          <s-paragraph>
            <s-text>
              One row per variant: a SKU, barcode or variant ID, then the cost. Costs are
              in {currency} and must be plain numbers — 12.50, not $12.50. A row in another
              currency is refused rather than converted. A file exported from Matrixify
              works as it is.
            </s-text>
          </s-paragraph>
        }
      />

      {/* Here, not in the editor's card: a refused commit has no report, and a banner up
          there was off screen from the button that caused it. */}
      {importAnswer ? (
        <s-banner tone={importAnswer.ok ? "success" : "critical"}>
          <s-paragraph>{importAnswer.message}</s-paragraph>
          {importAnswer.errorId ? <s-paragraph>Reference {importAnswer.errorId}</s-paragraph> : null}
        </s-banner>
      ) : null}

      {imported ? (
        <ImportReport
          heading={imported.dryRun ? "What would happen" : "What the file did"}
          // Rows read = Ready + Unchanged + Need attention (#767). Unchanged rows were in
          // none of the tiles, so a file of 10 with 4 already right read 10 / 6 / 6 / 0.
          counts={[
            { label: "Rows read", value: imported.total },
            { label: "Ready", value: imported.ready },
            { label: "Unchanged", value: imported.unchanged },
            { label: "Written", value: imported.written },
            { label: "Need attention", value: imported.problems },
          ]}
          problems={problems}
          problemCount={imported.problems}
          download={{
            filename: "cost-import-errors.csv",
            csv: () => costErrorCsv(imported),
          }}
        />
      ) : null}
    </PageShell>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return <RouteBoundary />;
}
