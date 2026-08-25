/**
 * The rollback report as a CSV download.
 *
 * Exportable because this is the artefact somebody forwards to whoever made the
 * edits, or keeps as the record of a decision about a few thousand prices. A report
 * you can only look at is not a record of anything.
 */

import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { rollbackReport, rollbackReportCsv } from "../services/campaigns/index.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const report = await rollbackReport(shop.id, String(params.id));

  // The campaign name, not the id: this file lands in somebody's downloads folder
  // next to eleven others, and `rollback-cmt8ro02a000q.csv` tells them nothing.
  const slug = report.campaignName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  return new Response(rollbackReportCsv(report), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rollback-${slug || "campaign"}.csv"`,
    },
  });
}
