/**
 * Changing what a fixture campaign prices, the way this release stores it (#884).
 *
 * Scenarios used to spread a new `ast` or `rounding` into the `schedule` JSON. A campaign's
 * definition has columns of its own now, which every reader reads first, so that changed
 * nothing on a campaign `createCampaign` made -- its columns are filled -- and the scenario
 * went on testing the fixture's own filter and rounding. This writes both halves through
 * the app's own writer, so the campaign is one this release could have written.
 *
 * A scenario about a row the release before wrote -- definition in the blob, columns at their
 * defaults -- writes the blob itself, on purpose, and says so.
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
    data: definitionData(campaign.schedule, {
      filter: statuses === undefined ? ast : { ...ast, productStatuses: statuses },
      segmentId: change.segmentId === undefined ? current.segmentId : change.segmentId,
      rounding: change.rounding === undefined ? current.rounding : (change.rounding as typeof current.rounding),
      practice: change.practice ?? current.practice,
    }),
  });
}
