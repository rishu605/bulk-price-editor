/**
 * Campaign persistence and rehydration.
 *
 * The stored row keeps its rule, policies and schedule as JSON so the shape can
 * evolve without a migration; `toResolvable` turns that back into the typed input
 * the pure resolver expects. Keeping the conversion in one place means the resolver
 * never sees a loosely-typed database row.
 *
 * What a campaign prices is the exception, since #884: its filter, segment, rounding and
 * practice flag are columns, read and written only here (`campaignDefinition`, `definitionData`).
 */

import { Prisma, type Campaign } from "@prisma/client";

import prisma from "../../db.server";
import { DEFINITION_KEYS } from "../../lib/campaigns/schedule-blob";
import { inChunks } from "../../lib/db/chunk";
import { AppError } from "../../lib/errors/app-error";
import {
  parseRoundingPolicy,
  resolvePolicy,
  type RoundingPolicy,
} from "../../lib/money/rounding-policy";
import type { AdjustmentRule,
  CompareAtPolicy,
  GuardrailViolationPolicy,
  Guardrails,
  ResolvableCampaign,
} from "../../lib/pricing/types";
import { PRICING_STATES } from "../../lib/lifecycle/transitions";
import { productStatusesOf, type ProductStatus } from "../../lib/campaigns/product-status";
import { START_CONFIRMED_KEY } from "../../lib/campaigns/start-confirmation";
import { parseSurfaces } from "../../lib/campaigns/surfaces";
import { astToWhere, segmentToAst, type FilterAst } from "../segments.server";
import { readSettings } from "../settings.server";
import type { CampaignInput } from "./types";

/**
 * Narrows a stored policy string to the union the resolver expects.
 *
 * The column is a plain `String` with a `"clamp"` default, so anything could be in it
 * -- an older row, a hand-edited record, a value from a future version rolled back.
 * Unknown values fall back to `clamp` rather than throwing: refusing to resolve a
 * campaign because its policy string is unfamiliar would take a merchant's live prices
 * out of our reach entirely, and clamp is the option that keeps a price valid.
 */
function asViolationPolicy(stored: string): GuardrailViolationPolicy {
  return stored === "skip" || stored === "block" ? stored : "clamp";
}

/** The shop's floor-violation setting, for a campaign being created now. */
async function violationPolicyFor(shopId: string): Promise<GuardrailViolationPolicy> {
  const settings = await readSettings(shopId);
  return settings.violationPolicy;
}

/**
 * Who made this campaign, for the log.
 *
 * Optional because the scheduler and the Flow actions create campaigns too, and a row
 * attributed to a person who was not there is worse than one attributed to nobody.
 */
export interface CreatedBy {
  actor?: string | null;
}

export async function createCampaign(
  shopId: string,
  input: CampaignInput,
  options: CreatedBy = {},
) {
  const row = await campaignRow(shopId, input);

  const campaign = await prisma.campaign.create({
    data: {
      shopId,
      ...row,
      // The declarative reference as well as the id in `segmentId`. The rule engine reads
      // the id; the delete guard reads the relation, and a segment that could be
      // deleted out from under a running campaign is the failure that matters.
      ...(input.segmentId ? { segments: { connect: { id: input.segmentId } } } : {}),
    },
  });

  // The log's job is to answer "who decided this", and a campaign appearing out of
  // nowhere was the largest hole in it: a merchant could make one, and Home's Recent
  // activity — which is where most of them will ever see the log — would still be
  // showing whatever the scheduler last did, days earlier. See #614.
  //
  // Written after the campaign rather than in the same transaction on purpose. A
  // campaign that exists with no log row is a gap in the record; a log row for a
  // campaign that does not exist is a lie about one, and the second is worse.
  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: options.actor ?? null,
      action: "campaign.created",
      entity: "Campaign",
      entityId: campaign.id,
      after: {
        name: campaign.name,
        status: campaign.status,
        practice: input.practice ?? false,
        // Who typed the word for its start, and what it covered (#1009).
        ...(input.startConfirmed ? { startConfirmed: input.startConfirmed } : {}),
      } as never,
    },
  });

  return campaign;
}

/**
 * The fields a campaign row is created with, from what the caller asked for.
 *
 * Apart from `createCampaign` so that a campaign can be checked as it would be stored before
 * it is (`unsavedCampaign`): the editor asks for the typed confirmation of a dated campaign at
 * save (#1009), planned by the same resolver over the same row the scheduler will read.
 */
async function campaignRow(shopId: string, input: CampaignInput) {
  // One place for the statuses (#751). A caller may hand them over either way -- the editor
  // as a field, Home inside its constant scope -- and the campaign records one list, the
  // one `astOf` reads: beside the conditions in its filter column, and beside `ast` in the
  // blob, whose `ast` keeps only the conditions (`definitionData`).
  const { productStatuses: inAst, ...conditions } = input.ast;
  const definition: Definition = {
    // Written out even when it is the default, so a campaign's record says what it covers
    // rather than leaving it to whatever the reader's default is that year.
    filter: { ...conditions, productStatuses: productStatusesOf(input.productStatuses ?? inAst) },
    segmentId: input.segmentId || null,
    rounding: (input.rounding ?? null) as unknown as Prisma.JsonValue | null,
    practice: input.practice === true,
  };

  // A practice campaign is always a draft (#827). The editor refuses the dates and names
  // the field; this is the same rule for any caller that does not go through it, because a
  // practice campaign with a window comes out Scheduled -- a state whose page promises the
  // prices will change, and which the scheduler would otherwise be asked about every tick.
  if (input.practice && input.schedule?.kind === "window") {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        "A practice campaign is only ever previewed, so it cannot be scheduled. Leave out the dates " +
        "to keep it as practice, or create a real campaign to schedule the sale. Nothing was created.",
      context: { practice: true },
    });
  }

  return {
      name: input.name,
      status: input.schedule?.kind === "window" ? ("SCHEDULED" as const) : ("DRAFT" as const),
      priority: input.priority ?? 100,
      autoEnroll: input.autoEnroll ?? true,
      tagKit: input.tagKit ?? [],
      ruleRows: [{ segmentIds: [], rule: input.rule }] as never,
      surfaces: { base: true, priceLists: input.priceLists ?? [] } as never,
      compareAtPolicy: input.compareAtPolicy as never,
      compareAtViolationPolicy: "clear",
      guardrails: (input.guardrails ?? {}) as never,
      // The shop's answer to "when a price would breach a floor", not a literal.
      // It was hardcoded here and again in `toResolvable`, so the setting the merchant
      // picked -- including "leave those variants alone" and "refuse the run" -- was
      // silently replaced by "write the floor price anyway" (#338).
      //
      // Copied onto the campaign rather than read live at resolution time, so changing
      // the store default does not retroactively change what a running campaign does
      // to prices already on a storefront.
      guardrailViolationPolicy: await violationPolicyFor(shopId),
      // What it prices, in its columns and in the blob beside the window, for the release
      // before (#884); parseSchedule ignores the extra keys.
      ...definitionData(
        {
          ...(input.schedule ?? { kind: "manual" }),
          ...(input.startConfirmed ? { [START_CONFIRMED_KEY]: input.startConfirmed } : {}),
        },
        definition,
      ),
      ...(input.schedule?.kind === "window"
        ? {
            startAt: new Date(input.schedule.startAt),
            endAt: input.schedule.endAt ? new Date(input.schedule.endAt) : null,
          }
        : {}),
  };
}

/** What `toResolvable` and `scopeOf` read: a campaign as the resolver plans it, stored or not. */
export type PlannableCampaign = Pick<
  Campaign,
  | "id"
  | "priority"
  | "ruleRows"
  | "compareAtPolicy"
  | "guardrails"
  | "guardrailViolationPolicy"
  | keyof typeof DEFINITION
  | "createdAt"
  | "excludedVariantGids"
  | "surfaces"
>;

/** Not a cuid, and never persisted: only distinct from every campaign that exists. */
export const UNSAVED_CAMPAIGN_ID = "unsaved";

/**
 * The campaign `createCampaign` would store, without storing it (#1009).
 *
 * Built from the same fields, so the plan made from it is the plan the scheduler makes from
 * the stored row: newest of all, as it will be a moment from now, and with nothing excluded.
 */
export async function unsavedCampaign(shopId: string, input: CampaignInput): Promise<PlannableCampaign> {
  const row = await campaignRow(shopId, input);
  return {
    id: UNSAVED_CAMPAIGN_ID,
    priority: row.priority,
    // The JSON columns exactly as the row writes them: no field of the plan is rebuilt here.
    ruleRows: row.ruleRows,
    compareAtPolicy: row.compareAtPolicy,
    guardrails: row.guardrails,
    guardrailViolationPolicy: row.guardrailViolationPolicy,
    schedule: row.schedule as Prisma.JsonValue,
    filter: row.filter as Prisma.JsonValue,
    segmentId: row.segmentId,
    rounding: row.rounding === Prisma.DbNull ? null : (row.rounding as Prisma.JsonValue),
    practice: row.practice,
    createdAt: new Date(),
    excludedVariantGids: [],
    surfaces: row.surfaces,
  };
}

/**
 * A campaign's rounding policy as stored.
 *
 * Kept here rather than inlined so every reader -- resolver, preview, run report and
 * the wizard -- agrees about what an old campaign's bare `"charm99"` string means.
 */
export function roundingFor(raw: unknown): RoundingPolicy {
  return resolvePolicy(parseRoundingPolicy(raw));
}

/**
 * A campaign's rule, for anything that wants to describe rather than resolve it.
 *
 * `ruleRows` is a list because several rules can match a variant with the last winning
 * (E16), and nothing in the app creates more than one today. This reads the first, which
 * is the whole rule for every campaign that exists — and returns null rather than
 * pretending, so a multi-row campaign is described as having no single rule instead of
 * being described by an arbitrary one of them.
 */
export function ruleOf(campaign: Pick<Campaign, "ruleRows">): AdjustmentRule | null {
  const rows = (campaign.ruleRows ?? []) as unknown as Array<{ rule?: AdjustmentRule }>;
  if (rows.length !== 1) return null;
  return rows[0]?.rule ?? null;
}

/**
 * What a campaign prices, apart from when it runs (#884): its filter -- the conditions,
 * and the product statuses it covers (#751) -- the segment it targets instead, its
 * rounding as stored, and whether it is practice.
 *
 * Columns of its own since #884. They lived in the `schedule` blob beside the dates, and a
 * copy that dropped the dates dropped them too (#762). For one release they are written
 * both ways (`definitionData`), because the release before reads only the blob.
 *
 * ## Read from the column, or from the blob where the column is at its default
 *
 * Every reader takes a column at its default -- null, or false -- to mean "not recorded
 * here", and reads the blob instead. Only one writer leaves a row like that: the release
 * before this one, which knows nothing of the columns. Its inserts leave them at their
 * defaults, and its updates never touch them. Nor does it change what an existing campaign
 * prices -- nothing does; a campaign that prices differently is a copy, which is an insert
 * -- so its writes to an existing row's blob carry the definition keys along as they were.
 * Two kinds of row, then, and no third: one this release wrote, whose columns and blob
 * agree, and one the release before inserted -- in the migration's wake, or during a
 * rollback -- whose columns are at their defaults and whose blob holds the definition.
 *
 * So a column off its default is always one this release wrote, and the blob cannot know
 * better; a column at its default is wrong only where the blob says otherwise, and then the
 * blob is right. Column first, blob behind it, is exact for both. A real `false` and a
 * default `false` look alike, and need not differ: the blob of a row this release wrote
 * says the same. The contract release drops the fallback, once a second backfill has filled
 * the rows a rollback may have inserted (see the migration that added the columns).
 */
export interface Definition {
  /** The conditions, and the product statuses as recorded: none on a campaign from before #751. */
  filter: FilterAst;
  segmentId: string | null;
  /** As recorded, for `roundingFor`: a policy, a bare profile name from before those, or null. */
  rounding: Prisma.JsonValue | null;
  practice: boolean;
}

/** For a `select`: the columns a definition is read from, and the blob behind them (#884). */
export const DEFINITION = { filter: true, segmentId: true, rounding: true, practice: true, schedule: true } as const;

/** A campaign as far as its definition is concerned. */
export type DefinedCampaign = Pick<Campaign, keyof typeof DEFINITION>;

/** The blob's copy of a definition, read for a row the release before wrote. Gone with the contract. */
interface DefinitionBlob {
  ast?: FilterAst | null;
  productStatuses?: unknown;
  segmentId?: string | null;
  rounding?: Prisma.JsonValue;
  practice?: unknown;
}

function blobOf(campaign: Pick<Campaign, "schedule">): DefinitionBlob {
  return (campaign.schedule ?? {}) as DefinitionBlob;
}

/** What a campaign prices, as recorded: what `definitionData` writes, and a copy copies. */
export function campaignDefinition(campaign: DefinedCampaign): Definition {
  return {
    filter: storedFilter(campaign),
    segmentId: segmentIdOf(campaign),
    rounding: storedRounding(campaign),
    practice: isPractice(campaign),
  };
}

/** The rounding as recorded, for `roundingFor`: the column, or the blob's (#884). */
function storedRounding(campaign: Pick<Campaign, "rounding" | "schedule">): Prisma.JsonValue | null {
  return campaign.rounding ?? blobOf(campaign).rounding ?? null;
}

/**
 * A definition as a write stores it (#884): its columns, and `schedule` -- the blob the write
 * stores -- with whatever it held of a definition replaced by this one's keys, as the
 * release before reads them. Every write of a definition comes through here, so neither half
 * is ever written without the other, and the blob says what the columns say. The contract
 * keeps the columns and leaves `schedule` as it is handed in.
 */
export function definitionData(schedule: unknown, definition: Definition) {
  const blob = { ...((schedule ?? {}) as Record<string, unknown>) };
  for (const key of DEFINITION_KEYS) delete blob[key];
  // The blob's `ast` is the conditions alone, with the statuses beside it (#751).
  const { productStatuses, ...ast } = definition.filter;

  return {
    filter: definition.filter as unknown as Prisma.InputJsonValue,
    segmentId: definition.segmentId,
    // `DbNull`, as Prisma spells a null in a JSON column: every column is written, always.
    rounding: definition.rounding === null ? Prisma.DbNull : (definition.rounding as Prisma.InputJsonValue),
    practice: definition.practice,
    schedule: {
      ...blob,
      ...(definition.rounding === null ? {} : { rounding: definition.rounding }),
      ast,
      ...(productStatuses === undefined ? {} : { productStatuses }),
      ...(definition.segmentId ? { segmentId: definition.segmentId } : {}),
      ...(definition.practice ? { practice: true } : {}),
    } as unknown as Prisma.InputJsonValue,
  };
}

/**
 * The filter as recorded: the column, or the blob's `ast` with its statuses beside it. The
 * blob's top-level list over any inside `ast`, as `astOf` always read it, and as the
 * migration's backfill fills the column.
 */
function storedFilter(campaign: Pick<Campaign, "filter" | "schedule">): FilterAst {
  const column = campaign.filter ?? null;
  if (column !== null) return column as unknown as FilterAst;

  const blob = blobOf(campaign);
  const conditions: FilterAst = { ...(blob.ast ?? { groups: [] }) };
  delete conditions.productStatuses;
  if (blob.productStatuses === undefined) return conditions;
  return { ...conditions, productStatuses: blob.productStatuses as FilterAst["productStatuses"] };
}

/**
 * The filter that defines a campaign's scope -- an empty one matching every variant --
 * limited to the product statuses the campaign covers (#751).
 *
 * The statuses are attached here rather than by each caller, because every caller wants
 * them: the run and its preview through `scopeOf`, the calendar's fallback, and the
 * sentence the campaigns list and header print. A caller that forgot would be a count or
 * a description that includes the drafts the run leaves out.
 */
export function astOf(campaign: Pick<Campaign, "filter" | "schedule">): FilterAst {
  return { ...storedFilter(campaign), productStatuses: productStatusesFor(campaign) };
}

/**
 * The product statuses a campaign covers: what it recorded, or active products only.
 *
 * Active only for a campaign with nothing recorded, which is every campaign created before
 * #751. Those covered draft and archived products because nobody had asked, not because
 * anybody chose to, and the reader's default is what lets a forgotten path fail safe.
 * Prices one of them already wrote on a draft or archived variant are not stranded by
 * this: a whole-campaign revert takes back every price the campaign wrote, in its scope or
 * not (#828) -- see D12 in `docs/decisions.md`.
 */
export function productStatusesFor(campaign: Pick<Campaign, "filter" | "schedule">): ProductStatus[] {
  return productStatusesOf(storedFilter(campaign).productStatuses);
}

/**
 * Whether this campaign is practice.
 *
 * A practice campaign exists to be previewed and never applied. It is how a merchant
 * with fifty thousand products builds confidence before touching a live price, which is
 * exactly the merchant most worth converting — and the promise is only worth anything
 * if it is impossible to break by accident.
 *
 * Practice where either place says so (#884): `false` is the column's default, and a
 * campaign the release before made practice says so only in its blob.
 */
export function isPractice(campaign: Pick<Campaign, "practice" | "schedule">): boolean {
  return campaign.practice === true || blobOf(campaign).practice === true;
}

/** `isPractice` as a query: the column, or the blob for a row the release before wrote (#884). */
export const IS_PRACTICE = {
  OR: [{ practice: true }, { schedule: { path: ["practice"], equals: true } }],
} satisfies Prisma.CampaignWhereInput;

/** The segment a campaign targets, if it targets one rather than an inline filter. */
export function segmentIdOf(campaign: Pick<Campaign, "segmentId" | "schedule">): string | null {
  return campaign.segmentId ?? blobOf(campaign).segmentId ?? null;
}

/**
 * True when the campaign was built on a segment that has since been deleted (#776).
 *
 * The campaign keeps the segment's id in `segmentId`; the relation goes with the segment.
 */
export async function segmentGone(shopId: string, campaign: Pick<Campaign, "segmentId" | "schedule">): Promise<boolean> {
  const segmentId = segmentIdOf(campaign);
  if (!segmentId) return false;
  return (await prisma.segment.count({ where: { id: segmentId, shopId } })) === 0;
}

/** How a campaign whose segment was deleted describes its scope, wherever it is listed. */
export const DELETED_SEGMENT_SCOPE = "Its segment was deleted, so it prices nothing";

/**
 * The segment name to describe a campaign's scope by: the segment's, or
 * `DELETED_SEGMENT_SCOPE` when it named one that is gone. Without this, a campaign whose
 * segment was deleted described its stored filter instead -- "All variants" for a
 * spreadsheet campaign -- which is exactly what it no longer prices.
 */
export function segmentNameOf(
  campaign: Pick<Campaign, "segmentId" | "schedule"> & { segments: Array<{ name: string }> },
): string | undefined {
  return campaign.segments[0]?.name ?? (segmentIdOf(campaign) ? DELETED_SEGMENT_SCOPE : undefined);
}

/**
 * The scope a campaign actually runs against.
 *
 * Resolved rather than copied. A campaign that had its segment's filter written into
 * it at creation would keep pricing the old products after the segment was edited,
 * which would make "reusable" a lie -- the merchant fixes the segment once and expects
 * every campaign using it to follow.
 *
 * A segment that has since been deleted matches nothing. It used to fall back to the
 * campaign's own stored filter, and a spreadsheet campaign's is `{ groups: [] }`, which
 * matches the whole catalogue. Once a segment only finished and draft campaigns use can
 * be deleted (#776), that fallback is one Apply away from repricing every product in the
 * store, so a campaign whose segment is gone has nothing in scope, and `runCampaign`
 * refuses to apply it (`segmentGone`).
 */
export async function scopeOf(
  shopId: string,
  campaign: Pick<Campaign, "filter" | "segmentId" | "schedule">,
): Promise<FilterAst> {
  const segmentId = segmentIdOf(campaign);
  if (!segmentId) return astOf(campaign);

  const segment = await prisma.segment.findFirst({
    where: { id: segmentId, shopId },
    select: { kind: true, filterAst: true, frozenVariantGids: true },
  });
  if (!segment) {
    return { groups: [{ conditions: [{ field: "variantGid", value: [] }] }], productStatuses: productStatusesFor(campaign) };
  }

  return {
    ...segmentToAst({
      kind: segment.kind as "DYNAMIC" | "FROZEN",
      filterAst: segment.filterAst,
      frozenVariantGids: segment.frozenVariantGids,
    }),
    // The campaign's, not the segment's (#751). A segment is a definition shared by every
    // campaign that targets it and means every status; which of its products this sale
    // reaches is this campaign's choice. A frozen list is narrowed too: a variant pinned
    // while active and archived since is not one the merchant asked to put on sale.
    productStatuses: productStatusesFor(campaign),
  };
}

/** Rehydrates a stored campaign into the shape the pure resolver expects. */
export function toResolvable(campaign: PlannableCampaign): ResolvableCampaign {
  return {
    id: campaign.id,
    priority: campaign.priority,
    // createdAt stands in for startAt until scheduling lands (P3.9); it keeps the
    // winner ordering total and stable in the meantime.
    startAt: campaign.createdAt.getTime(),
    // Stored as JSON, so the cast has to route through `unknown`: Prisma's
    // JsonValue and RuleRow[] do not overlap structurally.
    ruleRows: campaign.ruleRows as unknown as ResolvableCampaign["ruleRows"],
    compareAtPolicy: campaign.compareAtPolicy as unknown as CompareAtPolicy,
    compareAtViolationPolicy: "clear",
    roundingPolicy: roundingFor(storedRounding(campaign)),
    guardrails: (campaign.guardrails ?? undefined) as unknown as Guardrails | undefined,
    // Read from the campaign, not hardcoded. See #338: every layer below this
    // implemented `skip` and `block` correctly and none of them could ever be reached,
    // because this line threw the answer away.
    guardrailViolationPolicy: asViolationPolicy(campaign.guardrailViolationPolicy),
    // Variants reverted out of this campaign individually. Carried into resolution
    // rather than filtered out beforehand, so an excluded variant falls through to
    // whatever else still controls it instead of jumping to full price.
    excludedVariantGids: campaign.excludedVariantGids,
    // Off the base price only when its surfaces say so, as the market writer reads them
    // (#1094). Left out otherwise, so a campaign that prices it looks as it always did.
    ...(parseSurfaces(campaign.surfaces).base ? {} : { marketsOnly: true }),
  };
}

/**
 * Loads a campaign plus every other campaign it resolves against.
 *
 * The others take part in resolution so overlap resolves the same way it will at
 * execution time, rather than being previewed in isolation. `heldEdits` goes to the
 * planner beside them: variants none of this campaign's runs may write (#821).
 */
export async function loadCampaignContext(shopId: string, campaignId: string) {
  const campaign = await prisma.campaign.findFirstOrThrow({
    where: { id: campaignId, shopId },
  });

  return { campaign, ...(await campaignContext(shopId, campaign)) };
}

/**
 * The same, for a campaign in hand: stored, or one `unsavedCampaign` describes (#1009), so a
 * campaign about to be saved is planned against the others exactly as it will be once it is.
 */
export async function campaignContext(shopId: string, campaign: PlannableCampaign) {
  const others = await competingCampaigns(shopId, campaign.id);

  return {
    // The campaign being planned covers its own candidates by construction; every other
    // one is offered only the variants inside its own scope (#752).
    resolvable: [toResolvable(campaign), ...(await withScopes(shopId, others))],
    heldEdits: await heldEditsOf(shopId, others),
    // By name, priority and state, for saying who wins what (#821).
    others: others.map(({ id, name, priority, status }) => ({ id, name, priority, status })),
    ast: await scopeOf(shopId, campaign),
  };
}

/**
 * The campaigns every other one resolves against: those meant to be pricing their
 * variants, whatever their exact state (#821).
 *
 * The one list, for the run, its preview, the rollback report and the editor's draft
 * preview alike. Each had its own `status: "ACTIVE"`, so a campaign held by one hand edit
 * vanished from all of them at once: a priority-50 sale wrote over a priority-100 one and
 * its revert put baselines under it, while every dialog said nothing else covered them.
 */
export async function competingCampaigns(shopId: string, besides?: string): Promise<Campaign[]> {
  const campaigns = await prisma.campaign.findMany({
    where: { shopId, status: { in: [...PRICING_STATES] }, ...(besides ? { id: { not: besides } } : {}) },
  });
  const ending = await endingAmong(campaigns.map((campaign) => campaign.id));
  return campaigns.filter((campaign) => !ending.has(campaign.id));
}

/**
 * Which of these campaigns are being ended: the latest whole-campaign run is a revert --
 * asked for, writing, or stopped part-way (#805). Runs over named variants, a single
 * variant's revert or an enrolment, say nothing about the campaign as a whole.
 */
export async function endingAmong(campaignIds: readonly string[]): Promise<Set<string>> {
  if (campaignIds.length === 0) return new Set();
  const latest = await prisma.campaignRun.findMany({
    where: { campaignId: { in: [...campaignIds] }, NOT: { occurrenceKey: { startsWith: "VARIANT-" } } },
    orderBy: { createdAt: "desc" },
    distinct: ["campaignId"],
    select: { campaignId: true, kind: true },
  });
  return new Set(latest.filter((run) => run.kind === "REVERT").map((run) => run.campaignId));
}

/**
 * Variants a hand edit has held in another campaign, by the campaign holding them (#821).
 *
 * The merchant has been asked whether to keep that price, and until they answer no other
 * campaign's run may write it -- not the sale below it, which would overwrite their edit,
 * and not a revert, which would put the held campaign's price back over it. The holding
 * campaign's own Apply and Revert decide it with the merchant (#755) and are not affected.
 */
export async function heldEditsOf(
  shopId: string,
  holders: readonly Pick<Campaign, "id">[],
): Promise<Map<string, string>> {
  if (holders.length === 0) return new Map();
  const pending = await prisma.driftEvent.findMany({
    where: {
      shopId,
      resolution: "PENDING",
      surfaceKind: "BASE",
      priceListGid: "",
      campaignId: { in: holders.map((holder) => holder.id) },
    },
    select: { variantGid: true, campaignId: true },
  });
  return new Map(pending.flatMap((event) => (event.campaignId ? [[event.variantGid, event.campaignId] as const] : [])));
}

/**
 * Other campaigns, each carrying the set of variants its own scope covers (#752).
 *
 * Resolved the way a run resolves a scope -- segment or filter, through `astToWhere` --
 * so "this campaign covers that variant" here means what it means when the campaign runs.
 */
export async function withScopes(
  shopId: string,
  campaigns: readonly Campaign[],
  /**
   * Only these variants, for a question about a handful of them (#998): each scope then
   * says which of these it covers, without reading every variant it covers to say so.
   */
  only?: readonly string[],
): Promise<ResolvableCampaign[]> {
  return Promise.all(
    campaigns.map(async (campaign) => {
      const where = astToWhere(shopId, await scopeOf(shopId, campaign));
      const covered = only
        ? await inChunks([...only], (batch) =>
            prisma.variantIndex.findMany({ where: { AND: [where, { variantGid: { in: batch } }] }, select: { variantGid: true } }),
          )
        : await prisma.variantIndex.findMany({ where, select: { variantGid: true } });
      return { ...toResolvable(campaign), scope: new Set(covered.map((row) => row.variantGid)) };
    }),
  );
}


/**
 * Import ids any of these campaigns price from.
 *
 * Collected from the rules rather than stored separately, so a campaign whose rule
 * changes cannot end up loading prices for an import it no longer uses — or, worse,
 * failing to load the one it now does.
 */
export function importIdsOf(campaigns: readonly ResolvableCampaign[]): string[] {
  const ids = new Set<string>();

  for (const campaign of campaigns) {
    for (const row of campaign.ruleRows) {
      if (row.rule.kind === "from-import") ids.add(row.rule.importId);
    }
    // The compare-at a file gave is read from the same import (#766). Named by the rule
    // too in every campaign the import route makes, but not loading it here would leave
    // the policy with nothing to read, silently, should the two ever part.
    if (campaign.compareAtPolicy?.kind === "from-import") ids.add(campaign.compareAtPolicy.importId);
  }

  return [...ids];
}
