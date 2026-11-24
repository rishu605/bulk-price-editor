/**
 * How many variants a filter builder's scope matches, for the Segments form's live count (#817,
 * PRD A-2.1).
 *
 * A resource route, as the editor's preview is: the form it counts has its own action, which
 * saves a segment, and a count that shared a submit target with "save this" would be one
 * misrouted request away from saving one.
 *
 * Read by `scopeFrom`, the reading the save uses, and counted by `previewMatches`, which
 * compiles through `astToWhere` as planning does, so the number is what a campaign on the
 * segment would cover before its draft and archived boxes. Nothing here writes.
 */

import type { ActionFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import { previewMatches } from "../services/segments.server";
import { readerFor } from "../lib/campaigns/draft-form";
import { scopeFrom } from "../lib/segments/scope-builder";
import type { ScopeCount } from "../components/scope/useScopeCount";

/** The sample's size, the PRD's ten rows. */
const SAMPLE = 10;

export const action = async ({ request }: ActionFunctionArgs): Promise<ScopeCount> => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const scope = scopeFrom(readerFor(await request.formData()));
  if (!scope.ok) return { problem: scope.problem };

  const matches = await previewMatches(shop.id, scope.ast, SAMPLE);
  return { matched: matches.count, sample: matches.sample.map((row) => row.title) };
};
