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
 * A variant a higher-priority campaign took over is neither. Its live price is already
 * what the revert leaves there, so there is no edit to ask about (#836).
 *
 * Deleted variants are their own category rather than an error. A merchant removing a
 * product mid-sale is ordinary; reporting it as a problem to resolve trains people to
 * click past the list, which is how the rows that do matter get missed (E4).
 */

import prisma from "../../db.server";
import { inChunks } from "../../lib/db/chunk";
import { format } from "../../lib/money/format";
import { money } from "../../lib/money/money";
import { planRun } from "../../lib/planning/plan";
import { loadCandidates, pricesWrittenBy, titleMapFor, withWritten } from "./candidates.server";
import { loadCampaignContext, importIdsOf} from "./model.server";
import { inheritedBy } from "./handover.server";
import { guardrailsFor } from "../settings.server";
import {
  classifyRollbackRow,
  type RollbackReport,
  type RollbackRow,
  type RollbackRowKind,
} from "../../lib/reporting/rollback";
import { LANDED } from "../../lib/execution/landed";
import { priceBeforeStint, sinceItEnded, stintOf } from "../../lib/campaigns/recaptured";
import { labelled } from "../../lib/markets/display-name";
import { recapturedBaselines, type RecapturedBaseline } from "./recaptured.server";

export {
  classifyRollbackRow,
  rollbackReportCsv,
  type RollbackReport,
  type RollbackRow,
  type RollbackRowKind,
} from "../../lib/reporting/rollback";

export async function rollbackReport(
  shopId: string,
  campaignId: string,
): Promise<RollbackReport> {
  const { campaign, resolvable, heldEdits, ast } = await loadCampaignContext(shopId, campaignId);

  const [scoped, storeGuardrails, ledger, written, inherited] = await Promise.all([
    loadCandidates(shopId, ast, undefined, importIdsOf(resolvable)),
    guardrailsFor(shopId),
    appliedValues(campaignId, campaign.excludedVariantGids),
    pricesWrittenBy(shopId, campaignId),
    inheritedBy(shopId, campaignId),
  ]);
  // Planned over what the revert plans over: the scope, what the campaign wrote that has
  // left it (#751, #828), and what another campaign's revert handed it (#998). From the
  // scope alone, a product archived mid-sale "reverted to" its sale price here while the
  // revert put its baseline back.
  const candidates = await withWritten(
    shopId,
    scoped,
    [...new Set([...written, ...inherited.keys()])],
    importIdsOf(resolvable),
  );

  // The same planner the revert itself will use, so the "reverts to" column cannot
  // disagree with what happens when the merchant clicks the button.
  const outcome = planRun({
    campaigns: resolvable,
    candidates,
    storeGuardrails,
    excludeCampaignId: campaignId,
    heldEdits,
  });

  // The report is a list of what this campaign wrote, so the ledger defines the rows
  // -- not the campaign's current filter. Those are different sets, and the
  // difference is exactly where the interesting rows live: `loadCandidates` drops
  // tombstoned variants by design, so a product deleted mid-sale would vanish from a
  // filter-driven report rather than being reported as deleted (E4).
  //
  // Plus what it prices without having written it (#837). A higher-priority sale's revert
  // hands its variants to this one, and that write is ledgered under the revert that made
  // it -- so this campaign's ledger never learns it prices them, and its Revert dialog said
  // "0 variants are priced by this campaign" before rewriting every one. Who prices them is
  // the planner's answer, as an apply sees it: already at this campaign's price, with this
  // campaign the resolver's winner.
  //
  // Handed over by a revert, the price that revert wrote is what this campaign "applied"
  // (#998): newer than anything it wrote there itself, and what a hand edit since is
  // measured against. Without it, an edited one was in neither list -- not this campaign's
  // write, no longer at its price -- and the revert rewrote the edit without asking.
  const inScope = new Map(candidates.map((c) => [c.ref.variantGid, c]));
  const owned = new Map<string, bigint | null>([...ledger.latest, ...inherited]);
  const current = planRun({ campaigns: resolvable, candidates, storeGuardrails, heldEdits });
  for (const { ref, campaignId: winner } of current.kind === "ok" ? current.unchanged : []) {
    const price = inScope.get(ref.variantGid)?.livePrice;
    if (winner !== campaignId || ref.priceListGid !== "" || owned.has(ref.variantGid) || !price) continue;
    owned.set(ref.variantGid, BigInt(price.amount));
  }
  const appliedGids = [...owned.keys()];

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

  // What the revert writes, in minor units, for the classification (#836): the price of
  // each row it plans, and for a variant already at its answer, that answer -- the live
  // price. A row it skips has no answer, and is compared with what was applied alone.
  const writes = new Map<string, number>();
  if (outcome.kind === "ok") {
    for (const row of outcome.rows) if (row.intendedPrice) writes.set(row.ref.variantGid, row.intendedPrice.amount);
  }
  const alreadyThere = new Set(outcome.kind === "ok" ? outcome.unchanged.map((row) => row.ref.variantGid) : []);
  // The variants the revert leaves with another campaign's price, which explains a price that
  // is not the one from before this campaign (#781). The rest go back to their baseline.
  const keptBy = new Set(
    outcome.kind === "ok"
      ? [...outcome.rows, ...outcome.unchanged]
          .filter((row) => row.campaignId && row.ref.priceListGid === "")
          .map((row) => row.ref.variantGid)
      : [],
  );

  const rows: RollbackRow[] = [];

  for (const [gid, wrote] of owned) {
    const state = mirror.get(gid);
    const currency = state?.currency ?? inScope.get(gid)?.ref.currency ?? "USD";
    const live = state?.livePrice ?? null;

    const answer = writes.get(gid) ?? (alreadyThere.has(gid) && live !== null ? Number(live) : null);
    const kind = classifyRollbackRow({
      // Absent from the mirror entirely counts as gone, not as unchanged: we have no
      // basis to claim anything about a variant we can no longer see.
      deleted: state === undefined || state.deleted,
      applied: wrote === null ? null : Number(wrote),
      live: live === null ? null : Number(live),
      revertsTo: answer,
    });
    // The price before this campaign, where reverting puts back a baseline that is not it: one
    // recaptured at the sale price (#781), or changed outside the app before the sale (#745).
    const prior = ledger.before.get(gid);
    const notBefore = kind !== "deleted" && prior !== undefined && answer !== null && answer !== Number(prior) && !keptBy.has(gid);

    rows.push({
      variantGid: gid,
      title: titles.get(gid) ?? gid,
      kind,
      applied: wrote === null ? null : format(money(Number(wrote), currency)),
      live: live === null ? null : format(money(Number(live), currency)),
      // A deleted variant has nowhere to revert to, and claiming otherwise implies a
      // write that cannot happen. Where the planner found no row, the variant is already
      // where the revert would put it -- so it reverts to what it currently shows.
      revertsTo:
        kind === "deleted"
          ? null
          : (revertsTo.get(gid) ??
            (live === null ? null : format(money(Number(live), currency)))),
      before: notBefore ? format(money(Number(prior), currency)) : null,
    });
  }

  // Rows needing a decision first: this is a list people skim, and the ones that
  // matter must not be below the fold.
  const order: Record<RollbackRowKind, number> = { drifted: 0, deleted: 1, clean: 2, unaffected: 3 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || a.title.localeCompare(b.title));

  const counts = {
    total: rows.length,
    clean: rows.filter((r) => r.kind === "clean").length,
    drifted: rows.filter((r) => r.kind === "drifted").length,
    deleted: rows.filter((r) => r.kind === "deleted").length,
    unaffected: rows.filter((r) => r.kind === "unaffected").length,
  };

  // Said above the table, which shows some rows only: how many, a few by name, and why when the
  // baseline was recaptured at this campaign's own sale price (#781). Every price of its so
  // recaptured, a market's or wholesale price's for a sentence of its own (#1166).
  const differing = rows.filter((row) => row.before);
  const recaptured = await recapturedBaselines(shopId, campaignId);
  const markets = await marketsNotBefore(shopId, recaptured, keptBy, titles);

  return {
    campaignId,
    campaignName: campaign.name,
    rows,
    counts,
    straightforward: counts.drifted === 0,
    ...(differing.length > 0
      ? {
          notBefore: {
            count: differing.length,
            recaptured: differing.filter((row) => recaptured.has(row.variantGid)).length,
            examples: differing
              .slice(0, NOT_BEFORE_EXAMPLES)
              .map((row) => ({ title: row.title, before: row.before!, revertsTo: row.revertsTo ?? "" })),
          },
        }
      : {}),
    ...(markets ? { marketsNotBefore: markets } : {}),
  };
}

/** How many of the variants reverting does not put back at their price from before are named. */
const NOT_BEFORE_EXAMPLES = 3;

/**
 * The market and wholesale prices reverting puts back at this campaign's sale price, recaptured
 * as their baseline while it ran (#1166), or none.
 *
 * A revert writes a market's hand-set baseline back (#930), and a recapture records every fixed
 * price on a list as hand-set, the campaign's own among them: so a market price recaptured at
 * the sale price stays at it after the sale ends, and the report's rows, the base price's, said
 * nothing. Not where another campaign keeps the variant, whose price reverting gives it, nor a
 * baseline that follows the list, which reverting lets follow it again.
 */
async function marketsNotBefore(
  shopId: string,
  recaptured: ReadonlyMap<string, RecapturedBaseline>,
  keptBy: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
): Promise<RollbackReport["marketsNotBefore"]> {
  const back = [...recaptured.values()].filter((entry) => entry.priceListGid !== "" && entry.handSet && !keptBy.has(entry.variantGid));
  if (back.length === 0) return undefined;

  const shown = back.slice(0, NOT_BEFORE_EXAMPLES);
  const [lists, untitled] = await Promise.all([
    inChunks([...new Set(shown.map((entry) => entry.priceListGid))], (batch) =>
      prisma.priceListRecord
        .findMany({
          where: { shopId, priceListGid: { in: batch } },
          select: { priceListGid: true, name: true, catalogTitle: true, surfaceKind: true },
        })
        .then((rows) => rows.map(labelled)),
    ),
    titleMapFor(shopId, shown.map((entry) => entry.variantGid).filter((gid) => !titles.has(gid))),
  ]);
  const names = new Map(lists.map((list) => [list.priceListGid, list.name]));

  return {
    count: back.length,
    examples: shown.map((entry) => ({
      title: titles.get(entry.variantGid) ?? untitled.get(entry.variantGid) ?? entry.variantGid,
      market: names.get(entry.priceListGid) ?? entry.priceListGid,
      before: format(money(Number(entry.before), entry.currency)),
      revertsTo: format(money(Number(entry.baseline), entry.currency)),
    })),
  };
}

/**
 * The variants this report lists as edited: the ones the Revert tab asks about before it
 * reverts, and Shopify Flow's End campaign, which cannot ask, leaves as they are (#794).
 *
 * The report itself, not pending drift events. An edit the merchant chose to "Leave it for
 * now" in the drift queue has no pending event and is still an edit the Revert tab asks
 * about, so only the report can say Flow keeps exactly what the button would have asked.
 */
export async function editedVariants(shopId: string, campaignId: string): Promise<string[]> {
  const report = await rollbackReport(shopId, campaignId);
  return report.rows.filter((row) => row.kind === "drifted").map((row) => row.variantGid);
}

/** Live value, currency and tombstone state for the variants a campaign wrote. */
async function mirrorState(
  shopId: string,
  variantGids: string[],
): Promise<Map<string, { livePrice: bigint | null; currency: string; deleted: boolean }>> {
  if (variantGids.length === 0) return new Map();

  const [entries, index] = await Promise.all([
    inChunks(variantGids, (batch) =>
      prisma.priceSurfaceEntry.findMany({
        where: { shopId, variantGid: { in: batch }, surfaceKind: "BASE", priceListGid: "" },
        select: { variantGid: true, livePrice: true, currency: true },
      }),
    ),
    inChunks(variantGids, (batch) =>
      prisma.variantIndex.findMany({
        where: { shopId, variantGid: { in: batch } },
        select: { variantGid: true, deletedAt: true, currency: true },
      }),
    ),
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
 * What this campaign last wrote for each variant, from the ledger: its sale price, or the
 * price its own revert put back. And, for each variant it is pricing, the price the ledger
 * recorded before it (#781).
 *
 * The ledger, not the mirror: the mirror holds what is live, which is precisely the
 * value being compared against. Reading both from the same place would compare a
 * number to itself and report that nothing ever drifts.
 *
 * Only settled rows count. A row that failed was never written, so a live value
 * differing from its intent is not drift — it is the failure, and the run already
 * reports that.
 */
async function appliedValues(
  campaignId: string,
  /**
   * Variants this campaign has let go of -- "Revert this variant" -- whose live price is
   * Anchor's own recompute, not somebody's edit. Comparing them with the sale price the
   * campaign once wrote reported them as "changed since … someone edited those on
   * purpose" and took the plain Revert away (#886). They are no longer the campaign's.
   */
  excluded: readonly string[] = [],
): Promise<{ latest: Map<string, bigint | null>; before: Map<string, bigint> }> {
  // Reverts as well as applies (#910). A revert that stopped part-way has put some prices
  // back; measured against the sale price alone, every one of those read as "changed
  // since … someone edited those on purpose", and the header offered "Review 37 edited
  // before reverting" in place of Resume. Nobody edited them: the revert did, and its
  // landed row is the newest thing this campaign wrote there.
  const runs = await prisma.campaignRun.findMany({
    where: { campaignId, kind: { in: ["APPLY", "REVERT"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, kind: true, status: true, occurrenceKey: true },
    take: 20,
  });
  if (runs.length === 0) return { latest: new Map(), before: new Map() };
  // The price before is the current sale's (#1166): from the runs since it last ended, as
  // `recapturedBaselines` reads them. What it last wrote is still read from them all.
  const sale = new Set(sinceItEnded(runs).map((run) => run.id));

  const changes = await prisma.variantChange.findMany({
    where: {
      runId: { in: runs.map((r) => r.id) },
      status: { in: [...LANDED, "APPLIED"] },
      // The base price only, because that is what it is compared with: the mirror's base
      // live price. Market rows are written after base rows, so "newest wins" picked a
      // market price for every variant of a campaign with markets -- and every one of them
      // read as "changed since … someone edited those on purpose" the moment it was
      // applied (#777).
      surfaceKind: "BASE",
      priceListGid: "",
      ...(excluded.length > 0 ? { variantGid: { notIn: [...excluded] } } : {}),
    },
    // Newest by when it was written, so a revert's row outranks the apply before it and an
    // apply after the revert outranks both.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { variantGid: true, intendedPrice: true, beforePrice: true, runId: true },
  });

  // Newest wins. A recurring campaign writes the same variant on every occurrence,
  // and only the most recent value is the one drift is measured against.
  const latest = new Map<string, bigint | null>();
  // And each variant's rows newest first, for the price the ledger recorded before the
  // campaign: its first apply's since its last revert there (#781).
  const reverts = new Set(runs.filter((run) => run.kind === "REVERT").map((run) => run.id));
  const rowsOf = new Map<string, Array<{ revert: boolean; before: bigint | null }>>();
  for (const change of changes) {
    if (!latest.has(change.variantGid)) latest.set(change.variantGid, change.intendedPrice);
    if (!sale.has(change.runId)) continue;
    const row = { revert: reverts.has(change.runId), before: change.beforePrice };
    const list = rowsOf.get(change.variantGid);
    if (list) list.push(row);
    else rowsOf.set(change.variantGid, [row]);
  }

  const before = new Map<string, bigint>();
  for (const [variantGid, rows] of rowsOf) {
    const price = priceBeforeStint(stintOf(rows));
    if (price !== null) before.set(variantGid, price);
  }
  return { latest, before };
}
