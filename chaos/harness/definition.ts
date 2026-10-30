/**
 * Changing what a fixture campaign prices, the way the app stores it (#884, #1141).
 *
 * Scenarios used to spread a new `ast` or `rounding` into the `schedule` JSON. A campaign's
 * definition has columns of its own, and since #1141 nothing reads the blob for one, so that
 * changes nothing: the scenario goes on testing the fixture's own filter and rounding. This
 * writes the columns through the app's own writer, and leaves `schedule` -- the window and
 * the campaign's own record -- as it is, so the campaign is one the app could have written.
 */

import prisma from "../../app/db.server";
import type { ProductStatus } from "../../app/lib/campaigns/product-status";
import { campaignDefinition, DEFINITION, definitionData } from "../../app/services/campaigns/model.server";
import type { FilterAst } from "../../app/services/segments.server";

export interface Redefinition {
  /** New conditions. The statuses stay as they are unless `productStatuses` is given too. */
  ast?: FilterAst;
  /** New statuses; `null` records none, as a campaign from before #751 has. */
  productStatuses?: readonly ProductStatus[] | null;
  segmentId?: string | null;
  /** As stored: a policy, or a bare profile name as a campaign from before policies has. */
  rounding?: unknown;
  practice?: boolean;
}

export async function redefine(campaignId: string, change: Redefinition): Promise<void> {
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: DEFINITION });
  const current = campaignDefinition(campaign);

  const { productStatuses: kept, ...conditions } = current.filter;
  // A new `ast` brings conditions only: the statuses are `productStatuses`'s to change.
  const ast: FilterAst = { ...(change.ast ?? conditions) };
  delete ast.productStatuses;
  const statuses = change.productStatuses === undefined ? kept : (change.productStatuses ?? undefined);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: definitionData({
      filter: statuses === undefined ? ast : { ...ast, productStatuses: statuses },
      segmentId: change.segmentId === undefined ? current.segmentId : change.segmentId,
      rounding: change.rounding === undefined ? current.rounding : (change.rounding as typeof current.rounding),
      practice: change.practice ?? current.practice,
    }),
  });
}
