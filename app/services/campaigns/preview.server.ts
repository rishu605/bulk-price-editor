/**
 * Computing what a campaign would do, without writing anything.
 *
 * Preview and execution call the same planner, so a preview cannot disagree with the
 * run that follows.
 */

import { format } from "../../lib/money/format";
import type { Money } from "../../lib/money/money";
import { planRun } from "../../lib/planning/plan";
import { selectWritePath } from "../../lib/planning/write-path";
import { loadCandidates, titleMapFor } from "./candidates.server";
import { loadCampaignContext } from "./model.server";
import { guardrailsFor } from "../settings.server";
import { BLAST_RADIUS_THRESHOLD, type CampaignPreview } from "./types";

export interface PreviewOptions {
  /** Preview the revert instead of the apply. */
  revert?: boolean;
  /** Rows returned to the UI. The counts always reflect the whole plan. */
  limit?: number;
}

export async function previewCampaign(
  shopId: string,
  campaignId: string,
  options: PreviewOptions = {},
): Promise<CampaignPreview> {
  const { campaign, resolvable, ast } = await loadCampaignContext(shopId, campaignId);
  const [candidates, storeGuardrails] = await Promise.all([
    loadCandidates(shopId, ast),
    guardrailsFor(shopId),
  ]);

  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails,
    excludeCampaignId: options.revert ? campaignId : undefined,
  });

  if (outcome.kind === "blocked") {
    return {
      campaignId,
      name: campaign.name,
      status: campaign.status,
      counts: outcome.counts,
      rows: [],
      blocked: { reason: outcome.reason, variantGid: outcome.ref.variantGid },
      writePath: "none",
      writePathReason: "Blocked before planning completed.",
      blastRadius: false,
    };
  }

  const limit = options.limit ?? 100;
  const shown = outcome.rows.slice(0, limit);
  const titles = await titleMapFor(shopId, shown.map((row) => row.ref.variantGid));

  const fmt = (value?: Money | null) => (value ? format(value) : null);
  const decision = selectWritePath(outcome.rows.length);

  return {
    campaignId,
    name: campaign.name,
    status: campaign.status,
    counts: outcome.counts,
    rows: shown.map((row) => ({
      variantGid: row.ref.variantGid,
      title: titles.get(row.ref.variantGid) ?? row.ref.variantGid,
      before: fmt(row.beforePrice),
      after: fmt(row.intendedPrice),
      compareAt: row.intendedCompareAtSet ? fmt(row.intendedCompareAt) : null,
      status: row.status,
      reason: row.reason,
    })),
    writePath: decision.path,
    writePathReason: decision.reason,
    blastRadius: outcome.counts.planned > BLAST_RADIUS_THRESHOLD,
  };
}
