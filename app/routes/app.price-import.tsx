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
import { actorFor } from "../lib/audit/actor";
import { withGuard } from "../lib/errors/guard.server";
import { isCommit } from "../lib/imports/intent";

export const action = withGuard("/app/price-import", async ({ request }: ActionFunctionArgs) => {
  const { session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const form = await request.formData();

  const currency = await shopCurrency(shop.id);
  const dryRun = !isCommit(form.get("intent"));
  const name = String(form.get("name") ?? "Imported prices").trim() || "Imported prices";
  const actor = actorFor(sessionToken, session.shop);

  const result = await importPrices(
    shop.id,
    name,
    linesOf(String(form.get("csv") ?? "")),
    currency,
    { dryRun, actor },
  );

  if (dryRun || !result.importId) {
    return {
      ok: true,
      result,
      message: `${result.ready} of ${result.total} rows matched a product. Nothing has been created yet.`,
    };
  }

  // Frozen to exactly the variants the file named. A dynamic filter would let products
  // added later fall into a campaign whose rule can say nothing about them.
  const gids = await importedVariantGids(result.importId);
  const segment = await prisma.segment.create({
    data: {
      shopId: shop.id,
      name: `${name} (imported)`,
      kind: "FROZEN",
      filterAst: { groups: [] } as never,
      frozenVariantGids: gids,
    },
  });

  const campaign = await createCampaign(shop.id, {
    name,
    ast: { groups: [] },
    segmentId: segment.id,
    rule: { kind: "from-import", importId: result.importId },
    compareAtPolicy: { kind: "leave" },
    rounding: { default: "none", byCurrency: {} },
  });

  // Straight to the preview. The whole argument for routing an import through a campaign
  // is that the merchant sees what it will do before it does it.
  return redirect(`/app/campaigns/${campaign.id}`);
});

