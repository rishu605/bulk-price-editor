import prisma from "../../db.server";
import { pressedKey } from "../../lib/scheduling/attempts";

/** The occurrence key for a scoped run somebody pressed a button for. See `pressedKey`. */
export async function pressedRunKey(campaignId: string, base: string): Promise<string> {
  const runs = await prisma.campaignRun.findMany({
    where: { campaignId, OR: [{ occurrenceKey: base }, { occurrenceKey: { startsWith: `${base}#` } }] },
    select: { occurrenceKey: true, status: true },
  });
  return pressedKey(base, runs);
}
