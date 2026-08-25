/**
 * Named, reusable targeting.
 *
 * The dynamic/frozen distinction is the point, and picking the wrong one silently
 * produces the wrong campaign:
 *
 *   DYNAMIC re-evaluates whenever it is asked, so a product added to a collection
 *   joins a sale that is already running. What a merchant wants for "everything in
 *   Summer".
 *
 *   FROZEN pins the variant list at save time, so a campaign touches exactly the
 *   variants that were reviewed and nothing else. What a merchant wants after
 *   uploading a spreadsheet somebody signed off.
 *
 * Neither is a safe default, so the choice is made explicitly at creation and shown
 * everywhere the segment appears.
 */

import prisma from "../db.server";
import { AppError } from "../lib/errors/app-error";
import {
  buildMatchIndex,
  matchIdentifiers,
  parseIdentifierCsv,
  type MatchOutcome,
} from "../lib/segments/csv-import";
import { resolveVariantGids, type FilterAst } from "./segments.server";

export type SegmentKind = "DYNAMIC" | "FROZEN";

export interface SegmentSummary {
  id: string;
  name: string;
  kind: SegmentKind;
  /** Variants it currently matches. For frozen segments, the pinned count. */
  size: number;
  usedBy: Array<{ id: string; name: string; status: string }>;
  updatedAt: string;
}

/**
 * Campaigns that would break if this segment went away.
 *
 * Checked in two places on purpose. The relation is the declarative reference, but a
 * campaign's rule rows carry segment ids in JSON as well, and that is what the rule
 * engine actually reads. A guard that consulted only the relation would happily delete
 * a segment a running campaign was pricing from.
 */
export async function referencingCampaigns(shopId: string, segmentId: string) {
  const [related, all] = await Promise.all([
    prisma.campaign.findMany({
      where: { shopId, segments: { some: { id: segmentId } } },
      select: { id: true, name: true, status: true },
    }),
    prisma.campaign.findMany({
      where: { shopId },
      select: { id: true, name: true, status: true, ruleRows: true, schedule: true },
    }),
  ]);

  const byId = new Map(related.map((c) => [c.id, { id: c.id, name: c.name, status: c.status }]));

  for (const campaign of all) {
    if (byId.has(campaign.id)) continue;
    if (mentionsSegment(campaign.ruleRows, segmentId) || mentionsSegment(campaign.schedule, segmentId)) {
      byId.set(campaign.id, { id: campaign.id, name: campaign.name, status: campaign.status });
    }
  }

  return [...byId.values()];
}

/** True when this JSON blob names the segment anywhere inside it. */
function mentionsSegment(blob: unknown, segmentId: string): boolean {
  if (blob === null || blob === undefined) return false;
  return JSON.stringify(blob).includes(segmentId);
}

export async function listSegments(shopId: string): Promise<SegmentSummary[]> {
  const segments = await prisma.segment.findMany({
    where: { shopId },
    orderBy: { updatedAt: "desc" },
    include: { campaigns: { select: { id: true, name: true, status: true } } },
  });

  return Promise.all(
    segments.map(async (segment) => ({
      id: segment.id,
      name: segment.name,
      kind: segment.kind as SegmentKind,
      size:
        segment.kind === "FROZEN"
          ? segment.frozenVariantGids.length
          : (await resolveVariantGids(shopId, astOfSegment(segment.filterAst))).length,
      usedBy: await referencingCampaigns(shopId, segment.id),
      updatedAt: segment.updatedAt.toISOString(),
    })),
  );
}

export async function getSegment(shopId: string, id: string) {
  const segment = await prisma.segment.findFirst({ where: { id, shopId } });
  if (!segment) {
    throw new AppError({
      code: "NOT_FOUND",
      userMessage: "That segment no longer exists. It may have been deleted.",
      context: { segmentId: id },
    });
  }
  return segment;
}

export interface CreateSegmentInput {
  name: string;
  kind: SegmentKind;
  /** For a dynamic segment, and for freezing a filter into a list. */
  filterAst?: FilterAst;
  /** For a frozen segment built from an upload. */
  variantGids?: string[];
  createdBy?: string;
}

export async function createSegment(shopId: string, input: CreateSegmentInput) {
  const name = input.name.trim();
  if (!name) {
    throw new AppError({
      code: "VALIDATION",
      userMessage: "Give the segment a name so you can find it when building a campaign.",
    });
  }

  // Frozen means pinned now. A frozen segment built from a filter resolves that filter
  // once, here, and keeps the answer -- which is the entire difference from dynamic.
  const frozen =
    input.kind === "FROZEN"
      ? (input.variantGids ?? (await resolveVariantGids(shopId, input.filterAst ?? { groups: [] })))
      : [];

  try {
    return await prisma.segment.create({
      data: {
        shopId,
        name,
        kind: input.kind,
        filterAst: (input.filterAst ?? { groups: [] }) as never,
        frozenVariantGids: frozen,
        createdBy: input.createdBy ?? null,
      },
    });
  } catch (error) {
    throw nameCollision(error, name);
  }
}

export interface UpdateSegmentInput {
  name?: string;
  filterAst?: FilterAst;
  variantGids?: string[];
  /** Confirms the merchant saw the warning about campaigns using this segment. */
  acknowledgedCampaigns?: boolean;
}

/**
 * Edits a segment.
 *
 * Kind is deliberately not editable. Flipping dynamic to frozen would silently pin
 * whatever the filter happens to match today; flipping frozen to dynamic would widen a
 * reviewed list to whatever a filter returns. Both change what a running campaign
 * prices without the merchant asking for it, and both are better expressed as making a
 * new segment.
 */
export async function updateSegment(shopId: string, id: string, input: UpdateSegmentInput) {
  const segment = await getSegment(shopId, id);
  const users = await referencingCampaigns(shopId, id);
  const live = users.filter((c) => c.status === "ACTIVE" || c.status === "APPLYING");

  // A segment edit reaches straight into a running sale. Not blocked -- sometimes
  // that is exactly the intent -- but never silent.
  if (live.length > 0 && !input.acknowledgedCampaigns) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        `${live.map((c) => `"${c.name}"`).join(", ")} ${live.length === 1 ? "is" : "are"} running and ` +
        `using this segment. Saving changes which products ${live.length === 1 ? "it prices" : "they price"}. ` +
        `Confirm to continue.`,
      context: { segmentId: id, campaigns: live.map((c) => c.id) },
    });
  }

  const name = input.name?.trim();

  try {
    return await prisma.segment.update({
      where: { id: segment.id },
      data: {
        ...(name ? { name } : {}),
        ...(input.filterAst ? { filterAst: input.filterAst as never } : {}),
        // Frozen lists are re-pinned only when a new list is supplied; editing a
        // frozen segment's name must not silently re-resolve what it contains.
        ...(input.variantGids ? { frozenVariantGids: input.variantGids } : {}),
      },
    });
  } catch (error) {
    throw nameCollision(error, name ?? segment.name);
  }
}

/**
 * Deletes a segment, unless something is using it.
 *
 * Blocked rather than cascaded. A campaign whose targeting silently emptied would
 * either price nothing or -- far worse, if an empty filter were treated as
 * "everything" -- price the entire catalogue on its next run.
 */
export async function deleteSegment(shopId: string, id: string): Promise<void> {
  const users = await referencingCampaigns(shopId, id);

  if (users.length > 0) {
    throw new AppError({
      code: "VALIDATION",
      userMessage:
        `This segment is used by ${users.map((c) => `"${c.name}"`).join(", ")}. ` +
        `Remove it from ${users.length === 1 ? "that campaign" : "those campaigns"} first, ` +
        `or the campaign would lose its targeting.`,
      context: { segmentId: id, campaigns: users.map((c) => c.id) },
    });
  }

  await prisma.segment.deleteMany({ where: { id, shopId } });
}

export interface CsvImportResult extends MatchOutcome {
  skippedHeader: string | null;
  /** Rows read from the file, excluding a header. */
  total: number;
}

/**
 * Matches an uploaded list of identifiers against the catalogue.
 *
 * Returns the report without creating anything. The merchant sees what could not be
 * placed *before* committing, because a segment quietly missing 40 of 3,000 rows is
 * a campaign that quietly misses 40 products.
 */
export async function matchCsv(shopId: string, text: string): Promise<CsvImportResult> {
  const { rows, skippedHeader } = parseIdentifierCsv(text);

  const variants = await prisma.variantIndex.findMany({
    where: { shopId, deletedAt: null },
    select: { variantGid: true, productGid: true, sku: true, barcode: true },
  });

  return {
    ...matchIdentifiers(rows, buildMatchIndex(variants)),
    skippedHeader,
    total: rows.length,
  };
}

/** Prisma hands back JSON; the AST shape has to be asserted through `unknown`. */
function astOfSegment(stored: unknown): FilterAst {
  const ast = stored as FilterAst | null;
  return ast && Array.isArray(ast.groups) ? ast : { groups: [] };
}

function nameCollision(error: unknown, name: string): unknown {
  if (typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002") {
    return new AppError({
      code: "VALIDATION",
      userMessage: `You already have a segment called "${name}". Pick a different name.`,
    });
  }
  return error;
}
