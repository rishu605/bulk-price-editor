/**
 * What reverting this campaign would actually do — and which rows somebody has
 * touched since.
 *
 * Revert is `resolve(without C)`, which is the right computation but says nothing
 * about whether it is the right *action* for every row. If a variant's live price no
 * longer matches what the campaign wrote, a person changed it on purpose while the
 * sale was running. Reverting it silently overwrites that decision, and a merchant
 * who watches the app undo their manual correction has learned not to trust it with
 * their prices.
 *
 * So a revert with drift in it is a conversation, not a command. This builds the two
 * lists that conversation needs: rows that will revert cleanly, and rows where
 * somebody else got there first.
 *
 * Deleted variants are their own category rather than an error. A merchant removing a
 * product mid-sale is ordinary; reporting it as a problem to resolve trains people to
 * click past the list, which is how the rows that do matter get missed (E4).
 */

import prisma from "../../db.server";
import { format } from "../../lib/money/format";
import { money } from "../../lib/money/money";
import { planRun } from "../../lib/planning/plan";
import { loadCandidates, titleMapFor } from "./candidates.server";
import { loadCampaignContext } from "./model.server";
import { guardrailsFor } from "../settings.server";

export type RollbackRowKind =
  /** Live value matches what we applied. Reverting is uncontroversial. */
  | "clean"
  /** Live value differs from what we applied — somebody edited it. */
  | "drifted"
  /** Variant no longer exists in Shopify. Nothing to revert. */
  | "deleted";

export interface RollbackRow {
  variantGid: string;
  title: string;
  kind: RollbackRowKind;
  /** What this campaign last wrote, from the ledger. */
  applied: string | null;
  /** What the storefront shows now, from the mirror. */
  live: string | null;
  /** What `resolve(without this campaign)` would write. */
  revertsTo: string | null;
}

export interface RollbackReport {
  campaignId: string;
  campaignName: string;
  rows: RollbackRow[];
  counts: { total: number; clean: number; drifted: number; deleted: number };
  /** True when nothing needs a decision and the revert can just run. */
  straightforward: boolean;
}

/**
 * Which of the three states a row is in.
 *
 * Pure, so the boundaries are testable without a database — and they need to be,
 * because the default matters. An unknown comparison resolves to `clean`, meaning the
 * revert proceeds. That is the right way round: `drifted` asks a person a question,
 * and a report that invents questions about rows nobody touched is a report people
 * learn to click through, which is how the real ones get missed.
 */
export function classifyRollbackRow(input: {
  deleted: boolean;
  /** What the campaign wrote, in minor units. */
  applied: number | null;
  /** What the mirror says is live, in minor units. */
  live: number | null;
}): RollbackRowKind {
  if (input.deleted) return "deleted";
  if (input.applied === null || input.live === null) return "clean";
  return input.live === input.applied ? "clean" : "drifted";
}

export async function rollbackReport(
  shopId: string,
  campaignId: string,
): Promise<RollbackReport> {
  const { campaign, resolvable, ast } = await loadCampaignContext(shopId, campaignId);

  const [candidates, storeGuardrails, applied] = await Promise.all([
    loadCandidates(shopId, ast),
    guardrailsFor(shopId),
    appliedValues(campaignId),
  ]);

  // The report is a list of what this campaign wrote, so the ledger defines the rows
  // -- not the campaign's current filter. Those are different sets, and the
  // difference is exactly where the interesting rows live: `loadCandidates` drops
  // tombstoned variants by design, so a product deleted mid-sale would vanish from a
  // filter-driven report rather than being reported as deleted (E4).
  const appliedGids = [...applied.keys()];

  // The same planner the revert itself will use, so the "reverts to" column cannot
  // disagree with what happens when the merchant clicks the button.
  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails,
    excludeCampaignId: campaignId,
  });

  const [titles, mirror] = await Promise.all([
    titleMapFor(shopId, appliedGids),
    mirrorState(shopId, appliedGids),
  ]);

  const revertsTo = new Map(
    outcome.kind === "ok"
      ? outcome.rows.map((row) => [
          row.ref.variantGid,
          row.intendedPrice ? format(row.intendedPrice) : null,
        ])
      : [],
  );

  // Where the planner found no row, the variant is already where the revert would put
  // it -- so it reverts to what it currently shows, not to nothing.
  const inScope = new Map(candidates.map((c) => [c.ref.variantGid, c]));

  const rows: RollbackRow[] = [];

  for (const [gid, wrote] of applied) {
    const state = mirror.get(gid);
    const currency = state?.currency ?? inScope.get(gid)?.ref.currency ?? "USD";
    const live = state?.livePrice ?? null;

    const kind = classifyRollbackRow({
      // Absent from the mirror entirely counts as gone, not as unchanged: we have no
      // basis to claim anything about a variant we can no longer see.
      deleted: state === undefined || state.deleted,
      applied: wrote === null ? null : Number(wrote),
      live: live === null ? null : Number(live),
    });

    rows.push({
      variantGid: gid,
      title: titles.get(gid) ?? gid,
      kind,
      applied: wrote === null ? null : format(money(Number(wrote), currency)),
      live: live === null ? null : format(money(Number(live), currency)),
      // A deleted variant has nowhere to revert to, and claiming otherwise implies a
      // write that cannot happen.
      revertsTo:
        kind === "deleted"
          ? null
          : (revertsTo.get(gid) ??
            (live === null ? null : format(money(Number(live), currency)))),
    });
  }

  // Rows needing a decision first: this is a list people skim, and the ones that
  // matter must not be below the fold.
  const order: Record<RollbackRowKind, number> = { drifted: 0, deleted: 1, clean: 2 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));

  const counts = {
    total: rows.length,
    clean: rows.filter((r) => r.kind === "clean").length,
    drifted: rows.filter((r) => r.kind === "drifted").length,
    deleted: rows.filter((r) => r.kind === "deleted").length,
  };

  return {
    campaignId,
    campaignName: campaign.name,
    rows,
    counts,
    straightforward: counts.drifted === 0,
  };
}

/** Live value, currency and tombstone state for the variants a campaign wrote. */
async function mirrorState(
  shopId: string,
  variantGids: string[],
): Promise<Map<string, { livePrice: bigint | null; currency: string; deleted: boolean }>> {
  if (variantGids.length === 0) return new Map();

  const [entries, index] = await Promise.all([
    prisma.priceSurfaceEntry.findMany({
      where: { shopId, variantGid: { in: variantGids }, surfaceKind: "BASE", priceListGid: "" },
      select: { variantGid: true, livePrice: true, currency: true },
    }),
    prisma.variantIndex.findMany({
      where: { shopId, variantGid: { in: variantGids } },
      select: { variantGid: true, deletedAt: true, currency: true },
    }),
  ]);

  const tombstones = new Map(index.map((row) => [row.variantGid, row.deletedAt !== null]));
  const state = new Map<
    string,
    { livePrice: bigint | null; currency: string; deleted: boolean }
  >();

  for (const entry of entries) {
    state.set(entry.variantGid, {
      livePrice: entry.livePrice,
      currency: entry.currency,
      // Absent from variant_index at all is treated as gone, for the same reason as
      // an explicit tombstone: we cannot say anything about a variant we cannot see.
      deleted: tombstones.get(entry.variantGid) ?? true,
    });
  }

  return state;
}

/**
 * What this campaign last wrote for each variant, from the ledger.
 *
 * The ledger, not the mirror: the mirror holds what is live, which is precisely the
 * value being compared against. Reading both from the same place would compare a
 * number to itself and report that nothing ever drifts.
 *
 * Only settled rows count. A row that failed was never written, so a live value
 * differing from its intent is not drift — it is the failure, and the run already
 * reports that.
 */
async function appliedValues(campaignId: string): Promise<Map<string, bigint | null>> {
  const runs = await prisma.campaignRun.findMany({
    where: { campaignId, kind: "APPLY" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
    take: 20,
  });
  if (runs.length === 0) return new Map();

  const changes = await prisma.variantChange.findMany({
    where: {
      runId: { in: runs.map((r) => r.id) },
      status: { in: ["VERIFIED", "APPLIED"] },
    },
    orderBy: { id: "desc" },
    select: { variantGid: true, intendedPrice: true },
  });

  // Newest wins. A recurring campaign writes the same variant on every occurrence,
  // and only the most recent value is the one drift is measured against.
  const latest = new Map<string, bigint | null>();
  for (const change of changes) {
    if (!latest.has(change.variantGid)) latest.set(change.variantGid, change.intendedPrice);
  }
  return latest;
}

/**
 * The report as CSV.
 *
 * Exportable because this is the artefact somebody forwards to whoever made the edit,
 * or keeps as the record of a decision about a few thousand prices. Values are
 * quoted and internal quotes doubled: product titles contain commas and inches
 * routinely, and a report that corrupts itself on a 24" monitor is not a record.
 */
export function rollbackReportCsv(report: RollbackReport): string {
  const header = ["variant_gid", "title", "state", "applied", "live_now", "reverts_to"];
  const lines = [header.join(",")];

  for (const row of report.rows) {
    lines.push(
      [row.variantGid, row.title, row.kind, row.applied ?? "", row.live ?? "", row.revertsTo ?? ""]
        .map(csvCell)
        .join(","),
    );
  }

  return `${lines.join("\n")}\n`;
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
