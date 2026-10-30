/**
 * Every row an export button names, as CSV (#819).
 *
 * Each export was built in the browser from the rows already on screen, so "Export this
 * ledger" on a 3,666-row run downloaded about 60 rows, under a card saying the ledger keeps
 * every row we wrote. This reads the whole scope on the server: one run's ledger, one
 * campaign's plan, or what a Prices or Activity page's filters select. The page that links
 * here passes its own query, and the filters are parsed by the same functions the page
 * uses (`export-filters.ts`), so an export is always what the page describes.
 *
 * A resource route: no component. The button fetches it, which App Bridge signs with the
 * session token, and saves the text as a file.
 */

import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { toAdminClient } from "../services/admin-client.server";
import { runLedger } from "../services/campaigns/history.server";
import { pagePreview, writingText } from "../services/campaigns/preview.server";
import { currentRollback } from "../services/campaigns/plan-summary.server";
import { rollbackReportCsv } from "../lib/reporting/rollback";
import { reconcile } from "../services/reconciliation.server";
import { browseBaselines } from "../services/baseline-browser.server";
import { activity } from "../services/activity.server";
import { withGuard } from "../lib/errors/guard.server";
import { ledgerCsv } from "../lib/reporting/ledger-csv";
import { previewCsv } from "../lib/reporting/preview-csv";
import { reconciliationCsv } from "../lib/reporting/reconciliation-csv";
import { baselinesCsv } from "../lib/reporting/baselines-csv";
import { activityCsv } from "../lib/reporting/activity-csv";
import { driftCsv } from "../lib/reporting/drift-csv";
import { driftFiltersFrom } from "../lib/drift/batch";
import { driftPage } from "../services/drift-queue.server";
import { filenameSlug } from "../lib/reporting/csv";
import { formatCount } from "../lib/format/display";
import { activityFiltersFrom, baselineFiltersFrom, reconciliationFiltersFrom } from "../lib/reporting/export-filters";

/** Rows read a query. Large enough to be few queries on a 100k-variant store. */
export const EXPORT_PAGE = 2_000;

/**
 * Past this, the export is refused with what to narrow, rather than held open long enough
 * for the request to be cut off. Running it as a background job is #807's.
 */
export const EXPORT_ROW_LIMIT = 250_000;

export const loader = withGuard("/app/export/$kind", async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const query = new URL(request.url).searchParams;

  switch (params.kind) {
    case "ledger": {
      const run = await prisma.campaignRun.findFirst({
        where: { id: query.get("run") ?? "", shopId: shop.id },
        select: { id: true, campaign: { select: { name: true } } },
      });
      if (!run) return refuse(404, "That run isn't in this store's history. Reload the campaign page and export again.");
      const total = await prisma.variantChange.count({ where: { shopId: shop.id, runId: run.id } });
      if (total > EXPORT_ROW_LIMIT) return tooLarge(total);
      return csv(`ledger-${filenameSlug(run.campaign.name) || "campaign"}.csv`, ledgerCsv(await runLedger(shop.id, run.id, null)));
    }

    case "preview": {
      const campaignId = query.get("campaign") ?? "";
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId: shop.id }, select: { id: true } });
      if (!campaign) return refuse(404, "That campaign isn't in this store. Reload the page and export again.");
      const preview = await pagePreview(shop.id, campaign.id, { client: toAdminClient(admin), limit: EXPORT_ROW_LIMIT + 1 });
      if (preview.writing) return refuse(409, `${preview.writing} Export the preview once it has finished.`);
      if (preview.rows.length > EXPORT_ROW_LIMIT) return tooLarge(preview.counts.planned);
      return csv(`preview-${filenameSlug(preview.name) || "campaign"}.csv`, previewCsv(preview.rows, preview.markets));
    }

    // Every row of the rollback report (#812): the campaign page carries only those its
    // Revert tab renders. The stored report when it is current, worked out again when not --
    // an export is the merchant's record of what reverting does, so never a stale one.
    case "rollback": {
      const campaignId = query.get("campaign") ?? "";
      const campaign = await prisma.campaign.findFirst({ where: { id: campaignId, shopId: shop.id }, select: { id: true, name: true, status: true } });
      if (!campaign) return refuse(404, "That campaign isn't in this store. Reload the page and export again.");
      if (campaign.status === "APPLYING" || campaign.status === "REVERTING") {
        return refuse(409, `${writingText(campaign.status)} Export the rollback report once it has finished.`);
      }
      const report = await currentRollback(shop.id, campaign.id);
      if (report.rows.length > EXPORT_ROW_LIMIT) return tooLarge(report.rows.length);
      return csv(`rollback-${filenameSlug(campaign.name) || "campaign"}.csv`, rollbackReportCsv(report));
    }

    case "live":
      return paged(
        "anchor-reconciliation.csv",
        (page) => reconcile(shop.id, shop.domain, reconciliationFiltersFrom(query), page, EXPORT_PAGE),
        reconciliationCsv,
      );

    case "baselines":
      return paged(
        "anchor-baselines.csv",
        (page) => browseBaselines(shop.id, shop.domain, baselineFiltersFrom(query), page, EXPORT_PAGE),
        baselinesCsv,
      );

    case "activity":
      return paged(
        "anchor-activity.csv",
        async (page) => {
          const result = await activity(shop.id, activityFiltersFrom(query, shop.timezone), page, EXPORT_PAGE);
          return { rows: result.entries, total: result.total };
        },
        activityCsv,
      );

    // Every drifted price the queue's filters match (#822): the page shows fifteen at a time.
    case "drift":
      return paged(
        "anchor-price-drift.csv",
        (page) => driftPage(shop.id, driftFiltersFrom(query), page, EXPORT_PAGE),
        driftCsv,
      );

    default:
      return refuse(404, "There's no export by that name.");
  }
});

/** Reads every page of a paged listing, then renders it. */
async function paged<Row>(
  filename: string,
  read: (page: number) => Promise<{ rows: Row[]; total: number }>,
  render: (rows: readonly Row[]) => string,
): Promise<Response> {
  const first = await read(1);
  if (first.total > EXPORT_ROW_LIMIT) return tooLarge(first.total);

  const rows = [...first.rows];
  for (let page = 2; rows.length < first.total; page++) {
    const next = await read(page);
    if (next.rows.length === 0) break;
    rows.push(...next.rows);
  }
  return csv(filename, render(rows));
}

function csv(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

function refuse(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function tooLarge(total: number): Response {
  return refuse(
    413,
    `This export would be ${formatCount(total)} rows, more than the ${formatCount(EXPORT_ROW_LIMIT)} one file can hold. Narrow the filters and export again.`,
  );
}
