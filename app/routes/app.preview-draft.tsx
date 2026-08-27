/**
 * Prices a campaign that does not exist yet, for the editor's live preview.
 *
 * A resource route rather than a second action on the editor: the editor's own action
 * creates a campaign, and a preview that shares a submit target with "create the thing"
 * is one misrouted request away from creating one by accident.
 *
 * Deliberately outside `/app/campaigns/*` so it cannot be confused with a campaign id
 * by `app.campaigns.$id`.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { astFrom, compareAtFrom, readerFor, ruleFrom } from "../lib/campaigns/draft-form";
import { previewDraft } from "../services/campaigns/draft-preview.server";
import { readRoundingPolicy } from "../lib/money/rounding-policy";
import { shopCurrency } from "../services/settings.server";
import { segmentToAst } from "../services/segments.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const read = readerFor(form);

  // A chosen segment replaces the inline filter, exactly as it does on submit -- a
  // preview scoped differently from the campaign it previews is worse than no preview.
  const segmentId = (read("segment") ?? "").trim();
  const segment = segmentId
    ? await prisma.segment.findFirst({
        where: { id: segmentId, shopId: shop.id },
        select: { kind: true, filterAst: true, frozenVariantGids: true },
      })
    : null;

  const preview = await previewDraft(shop.id, {
    ast: segment
      ? segmentToAst({
          kind: segment.kind as "DYNAMIC" | "FROZEN",
          filterAst: segment.filterAst,
          frozenVariantGids: segment.frozenVariantGids,
        })
      : astFrom(read),
    rule: ruleFrom(read, await shopCurrency(shop.id)),
    compareAtPolicy: compareAtFrom(read),
    rounding: readRoundingPolicy(form.entries()),
    priority: Number(read("priority") ?? 100) || 100,
  });

  return preview;
};
