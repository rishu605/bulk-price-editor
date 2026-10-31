/**
 * How long a run has left, said while it writes (#820), from the run's own progress.
 *
 * Driven through the real run and the real status route, with the run held part-way: the
 * client the run is given asks the route, as the page does every five seconds, before it
 * passes a call on to the store. The run is waiting on that answer, so the poll reads what a
 * page would read at that moment.
 *
 * The estimate is the heartbeat's: it keeps the executor's count of prices written beside its
 * time, under the same throttle (`HEARTBEAT_EVERY_MS`). So the run is held for one beat where
 * the count has to move. The ledger shows nothing written the whole time the prices are
 * written: the sync path settles it in one batch at the end, which is why the count is kept on
 * the heartbeat.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import type { AdminClient } from "../../app/lib/execution/sync-executor";
import { HEARTBEAT_EVERY_MS } from "../../app/services/campaigns/reaper.server";
import { runCampaign } from "../../app/services/campaigns/run.server";
import { isVariantWrite } from "../harness/faults";
import { chaosAdminClient } from "../harness/http-client";
import { withChaos, type ChaosContext } from "../harness/scenario";

let shop = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop } }) },
}));

/** Every sentence `runEta` can say. */
const TIME_LEFT = /^(about (a|\d+) minutes?|under a minute) left$/;

interface Polled {
  status: string | null;
  eta: string | null;
}

/** What the page's poll hears. */
async function poll(campaignId: string): Promise<Polled> {
  const { loader } = await import("../../app/routes/app.campaign-status");
  return (await loader({
    request: new Request(`https://example.invalid/app/campaign-status?id=${campaignId}`),
    params: {},
    context: {},
  } as never)) as Polled;
}

/** The poll's answer, the run's count as the heartbeat keeps it, and its base rows by status. */
async function look(campaignId: string) {
  const polled = await poll(campaignId);
  const run = await prisma.campaignRun.findFirstOrThrow({
    where: { campaignId },
    orderBy: { createdAt: "desc" },
    select: { id: true, writePath: true, writtenRows: true, writableRows: true },
  });
  const rows = await prisma.variantChange.groupBy({
    by: ["status"],
    where: { runId: run.id, surfaceKind: "BASE" },
    _count: { _all: true },
  });
  return {
    polled,
    count: { written: run.writtenRows, of: run.writableRows, path: run.writePath },
    ledger: Object.fromEntries(rows.map((row) => [row.status, row._count._all])),
  };
}

type Look = Awaited<ReturnType<typeof look>>;

/** Long enough for the heartbeat's throttle to let the next count through. */
const aBeat = () => new Promise((resolve) => setTimeout(resolve, HEARTBEAT_EVERY_MS + 250));

/** A client that, before the nth price write or the first tag write, lets `onHold` look. */
function holding(chaos: ChaosContext, onHold: (at: number | "tags") => Promise<void>): AdminClient {
  const inner = chaosAdminClient(chaos.server.endpoint());
  let writes = 0;
  let tagged = false;
  return {
    async request(query, variables) {
      if (isVariantWrite(query)) await onHold(++writes);
      else if (query.includes("tagsAdd") && !tagged) {
        tagged = true;
        await onHold("tags");
      }
      return inner.request(query, variables);
    },
  };
}

describe("chaos: the time left while a run writes", () => {
  it("says nothing before 5% of a sync apply, how long is left after, and nothing once its prices are written", async () => {
    const spec = { catalog: { products: 40, variantsPerProduct: 1 }, percent: -10, tagKit: ["SALE"] };
    await withChaos("run-eta-sync", spec, async (chaos) => {
      const { shopId, campaignId, domain } = chaos.fixture;
      shop = domain;
      const seen = new Map<number | "tags", Look>();

      const client = holding(chaos, async (at) => {
        if (at !== 2 && at !== 3 && at !== "tags") return;
        seen.set(at, await look(campaignId));
        // Held for a beat before the second write, so its count is the next one stamped.
        if (at === 2) await aBeat();
      });
      expect((await runCampaign(shopId, campaignId, client, { actor: "chaos" })).clean).toBe(true);

      // One product written of forty: 2.5%.
      const before = seen.get(2)!;
      expect(before.count).toEqual({ written: 1, of: 40, path: "SYNC" });
      expect(before.polled).toEqual(expect.objectContaining({ status: "APPLYING", eta: null }));
      expect(before.ledger, "the ledger has nothing to say part-way, which is why the count is the heartbeat's").toEqual({ PENDING: 40 });

      // Two of forty: 5%.
      const after = seen.get(3)!;
      expect(after.count).toEqual({ written: 2, of: 40, path: "SYNC" });
      expect(after.polled.status).toBe("APPLYING");
      expect(after.polled.eta, "no time left once 5% of the run was written").toMatch(TIME_LEFT);
      expect(after.ledger).toEqual({ PENDING: 40 });

      // Tagging: every price written and its count kept past the throttle, so nothing is left
      // in these rows, and the tags after them are not counted in them.
      const tagging = seen.get("tags")!;
      expect(tagging.count, "the last count was throttled away, leaving the run nearly done for as long as tagging took").toEqual({
        written: 40,
        of: 40,
        path: "SYNC",
      });
      expect(tagging.polled).toEqual(expect.objectContaining({ status: "APPLYING", eta: null }));

      expect(await poll(campaignId)).toMatchObject({ status: "ACTIVE", eta: null });
    });
  });

  it("does not count the prices a revert keeps as rows it has written", async () => {
    await withChaos("run-eta-kept", { catalog: { products: 40, variantsPerProduct: 1 }, percent: -10 }, async (chaos) => {
      const { shopId, campaignId, domain, variantGids } = chaos.fixture;
      shop = domain;
      expect((await chaos.apply()).clean).toBe(true);

      // A tenth kept as edited: ledgered SKIPPED as the revert starts, and never handed to the
      // executor. Counted as written, the revert would open at 12.5% and nearly done.
      const kept = variantGids.slice(0, 4);
      const seen: Look[] = [];
      const client = holding(chaos, async (at) => {
        if (at === 2) seen.push(await look(campaignId));
      });
      const outcome = await runCampaign(shopId, campaignId, client, { actor: "chaos", revert: true, skipVariantGids: kept });
      expect(outcome.clean).toBe(true);
      expect(seen).toHaveLength(1);

      const [held] = seen;
      expect(held.ledger).toEqual({ SKIPPED: 4, PENDING: 36 });
      expect(held.count, "the kept prices were counted").toEqual({ written: 1, of: 36, path: "SYNC" });
      expect(held.polled).toEqual(expect.objectContaining({ status: "REVERTING", eta: null }));
    });
  });
});
