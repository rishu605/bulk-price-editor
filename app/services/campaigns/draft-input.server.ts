/**
 * One reading of the editor's fields, for everything that has to price a draft.
 *
 * Two callers exist and a third is coming: the resource route the live preview posts to,
 * the loader that prices the unedited form so the preview is populated on first paint,
 * and eventually the confirmation step. Each of them was going to repeat the same six
 * lines — segment lookup, AST, rule, compare-at, rounding, priority — and rule 4 says
 * preview and execution share one code path. Six lines copied twice is where that stops
 * being true, quietly, in a way no test notices until a merchant sees one number in the
 * sidebar and a different one in the run.
 */

import { astFrom, compareAtFrom, readerFor, ruleFrom } from "../../lib/campaigns/draft-form";
import { readRoundingPolicy } from "../../lib/money/rounding-policy";
import { segmentToAst } from "../segments.server";
import type { DraftCampaign } from "./draft-preview.server";
import prisma from "../../db.server";

/**
 * The draft a set of fields describes.
 *
 * A chosen segment replaces the inline filter rather than narrowing it, exactly as it
 * does on submit — a preview scoped differently from the campaign it previews is worse
 * than no preview.
 */
export async function draftCampaignFrom(
  shopId: string,
  source: FormData | URLSearchParams,
  currency: string,
): Promise<DraftCampaign> {
  const read = readerFor(source);

  const segmentId = (read("segment") ?? "").trim();
  const segment = segmentId
    ? await prisma.segment.findFirst({
        where: { id: segmentId, shopId },
        select: { kind: true, filterAst: true, frozenVariantGids: true },
      })
    : null;

  return {
    ast: segment
      ? segmentToAst({
          kind: segment.kind as "DYNAMIC" | "FROZEN",
          filterAst: segment.filterAst,
          frozenVariantGids: segment.frozenVariantGids,
        })
      : astFrom(read),
    rule: ruleFrom(read, currency),
    compareAtPolicy: compareAtFrom(read),
    rounding: readRoundingPolicy(source.entries()),
    priority: Number(read("priority") ?? 100) || 100,
  };
}
