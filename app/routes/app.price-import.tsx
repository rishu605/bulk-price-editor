/**
 * The POST a price import makes.
 *
 * A resource route rather than an action on the campaign editor, for the reason
 * `app.preview-draft.tsx` gives about its own: the editor's action creates a campaign
 * from a rule, and a second submit target on the same route is one misrouted request away
 * from creating the wrong thing. It is also why the URL is outside `/app/campaigns/*` —
 * `app.campaigns.$id` would otherwise read `import` as a campaign id.
 *
 * #445 moved the *entrance*. Everything here is unchanged: the two-phase
 * dry-run-then-commit, the parsing, the per-row error reporting, and the rule that a
 * missing intent falls safe. That is the guard which makes writing prices from a file
 * survivable, and the editor posts here rather than reimplementing any of it.
 *
 * The campaign it creates is the point. The file does not set prices — it creates a
 * campaign that does, which is what gives an import a preview, guardrails, rounding,
 * market surfaces and a revert, none of which a direct write would have had.
 */

import type { ActionFunctionArgs } from "react-router";
import { redirect } from "react-router";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { shopCurrency } from "../services/settings.server";
import { importedVariantGids, importPrices } from "../services/price-import.server";
import { createCampaign } from "../services/campaigns/index.server";
import { linesOf } from "../lib/reporting/lines";
import { countOf, formatCount } from "../lib/format/display";
import { actorFor } from "../lib/audit/actor";
import { EVERY_STATUS } from "../lib/campaigns/product-status";
import { withGuard } from "../lib/errors/guard.server";
import { importCheckKey, uncheckedCommit } from "../lib/imports/check-key.server";
import { isCommit } from "../lib/imports/intent";
import { importSegmentName } from "../lib/imports/segment-name";

export const action = withGuard("/app/price-import", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const currency = await shopCurrency(shop.id);
  const dryRun = !isCommit(form.get("intent"));
  const name = String(form.get("name") ?? "Imported prices").trim() || "Imported prices";
  // Started in practice mode: the campaign is practice too, so it can be previewed and
  // never applied. The editor promises exactly that above this form (#765).
  const practice = String(form.get("practice") ?? "") === "1";
  const actor = actorFor(sessionToken, session.shop);
  const csv = String(form.get("csv") ?? "");

  // A commit of rows nobody checked is refused before anything is read (#989).
  const unchecked = dryRun
    ? null
    : uncheckedCommit(form.get("checked"), csv, {
        outcome: "no campaign was created",
        next: "create the campaign from what the check shows",
      });
  if (unchecked) return unchecked;

  const result = await importPrices(
    shop.id,
    name,
    linesOf(csv),
    currency,
    { dryRun, actor },
  );

  if (dryRun || !result.importId) {
    return {
      ok: true,
      result,
      // Carried back by the commit: the rows it creates a campaign from are these (#989).
      checkKey: importCheckKey(csv),
      message: `${formatCount(result.ready)} of ${countOf(result.total, "row")} matched a product. Nothing has been created yet.`,
    };
  }

  // The import, its segment and its campaign together or not at all (#719). The second
  // import under the editor's default name used to collide with the first's segment after
  // the import was committed: the merchant got the error screen, and every retry left
  // another import with no campaign in the history.
  const importId = result.importId;
  let segmentId: string | null = null;
  let campaign: Awaited<ReturnType<typeof createCampaign>>;
  try {
    const segmentName = importSegmentName(
      name,
      (
        await prisma.segment.findMany({
          where: { shopId: shop.id, name: { startsWith: `${name} (imported` } },
          select: { name: true },
        })
      ).map((segment) => segment.name),
    );

    // Frozen to exactly the variants the file named. A dynamic filter would let products
    // added later fall into a campaign whose rule can say nothing about them.
    const gids = await importedVariantGids(importId);
    const segment = await prisma.segment.create({
      data: {
        shopId: shop.id,
        name: segmentName,
        kind: "FROZEN",
        filterAst: { groups: [] } as never,
        frozenVariantGids: gids,
      },
    });
    segmentId = segment.id;

    campaign = await createCampaign(
      shop.id,
      {
      name,
      ast: { groups: [] },
      segmentId: segment.id,
      // Every status, unlike a campaign built in the editor (#751). A file names each
      // variant it prices, which is a choice made row by row -- a draft in it is a launch
      // price somebody typed, not a sale that reached further than meant. And the editor
      // shows no scope for a file, so there would be no box to tick to get them back: the
      // rows the import just reported as matched would be priced as nothing, unexplained.
      productStatuses: EVERY_STATUS,
      rule: { kind: "from-import", importId },
      // The file's compare-at column, where a row filled it in (#766). It was "leave": the
      // column was checked against the price, refusing rows over it, and then never
      // written. A row with no compare-at still leaves the variant's own alone.
      compareAtPolicy: { kind: "from-import", importId },
      rounding: { default: "none", byCurrency: {} },
      ...(practice ? { practice: true } : {}),
      },
      { actor },
    );
  } catch (error) {
    if (segmentId) await prisma.segment.delete({ where: { id: segmentId } }).catch(() => undefined);
    await prisma.priceImport.delete({ where: { id: importId } }).catch(() => undefined);
    throw error;
  }

  // Straight to the preview. The whole argument for routing an import through a campaign
  // is that the merchant sees what it will do before it does it.
  return redirect(`/app/campaigns/${campaign.id}`);
});

