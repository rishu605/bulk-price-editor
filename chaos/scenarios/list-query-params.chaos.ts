/**
 * A list page opened from a link it did not write still renders (#747).
 *
 * `/app/campaigns?status=active` -- lower case, as anyone typing it would -- replaced the
 * campaigns list with "Shopify rejected part of this change", a reference number, and a
 * link to "Understanding a partial run". The status went into the where clause as typed,
 * the column is an enum, and Prisma's "Invalid value for argument" was then read as
 * Shopify's wording. Nothing had been changed and Shopify was never called.
 *
 * The same shape on three other loaders: the calendar's `on`, the baselines page's
 * `source`, and the Activity log's dates. Each is driven through the route's own loader,
 * so what is tested is the URL a merchant opens, and each must answer 200 without
 * filing anything in Diagnostics.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import { toAppError } from "../../app/lib/errors/app-error";
import { ANCHOR_ERROR } from "../../app/lib/errors/report";
import { withChaos } from "../harness/scenario";

/** Who the next request authenticates as. Mutable, because the mock is bound once. */
let pendingShop = "";

// The one boundary that needs a real Shopify session. Everything past it -- the query
// string, the parsers, Prisma, the guard -- is the real code.
vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: pendingShop }, sessionToken: undefined }),
  },
}));

type Loader = (args: never) => Promise<unknown>;

/** The parts of the three loaders' data the assertions read. */
interface Loaded {
  filters: { status?: string; source?: string };
  list: { campaigns: Array<{ id: string }> };
  calendar: { on: string } | null;
  total: number;
}

/**
 * What a GET of `path` answers: 200 and the loader's data, or the status and error code
 * the guard reported. The guard throws `data({ [ANCHOR_ERROR]: … }, { status })`, so a
 * failure is read back exactly as the error page would have shown it.
 */
async function get(loader: Loader, path: string) {
  try {
    const data = await loader({
      request: new Request(`https://example.invalid${path}`),
      params: {},
      context: {},
    } as never);
    return { status: 200, data: data as Loaded, error: null };
  } catch (thrown) {
    const failure = thrown as { init?: { status?: number }; data?: Record<string, { code?: string }> };
    return {
      status: failure.init?.status ?? 500,
      data: null,
      error: failure.data?.[ANCHOR_ERROR]?.code ?? String(thrown),
    };
  }
}

describe("chaos: list pages read their query strings against what exists", () => {
  it("renders the campaigns list, the calendar, baselines and Activity from links they did not write", async () => {
    await withChaos(
      "list-query-params",
      { catalog: { products: 2, variantsPerProduct: 1 }, percent: -10 },
      async (chaos) => {
        const { shopId, domain, campaignId } = chaos.fixture;
        pendingShop = domain;

        // An ACTIVE campaign, so a status filter that is honoured can be told apart from
        // one that is dropped: `active` must find it, `draft` must not.
        await prisma.campaign.update({ where: { id: campaignId }, data: { status: "ACTIVE" } });
        const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
        const reportsBefore = await prisma.errorEvent.count({ where: { shopId } });

        const campaigns = (await import("../../app/routes/app.campaigns._index")).loader as Loader;
        const listed = (result: Awaited<ReturnType<typeof get>>) =>
          result.data?.list.campaigns.map((row) => row.id);

        // The link from the issue. Read as the state it names, and honoured.
        const active = await get(campaigns, "/app/campaigns?status=active");
        expect(active.status, `status=active answered ${active.error}`).toBe(200);
        expect(active.data!.filters.status).toBe("ACTIVE");
        expect(listed(active)).toEqual([campaignId]);

        const draft = await get(campaigns, "/app/campaigns?status=Draft");
        expect(draft.status, `status=Draft answered ${draft.error}`).toBe(200);
        expect(listed(draft), "a lower-case filter was read but not applied").toEqual([]);

        // A value that names nothing is no filter: the whole list, with "All" selected.
        for (const junk of ["<script>alert(1)</script>", "nope", "ACTIVE'--"]) {
          const result = await get(campaigns, `/app/campaigns?status=${encodeURIComponent(junk)}`);
          expect(result.status, `status=${junk} answered ${result.error}`).toBe(200);
          expect(result.data!.filters.status).toBe("");
          expect(listed(result)).toEqual([campaignId]);
        }

        // The calendar's day. Malformed threw a RangeError; impossible rolled into March.
        const today = (await import("../../app/services/calendar.server")).todayIn(shop.timezone);
        for (const on of ["garbage", "2026-02-31", "2026-13-45"]) {
          const result = await get(campaigns, `/app/campaigns?view=calendar&period=week&on=${on}`);
          expect(result.status, `on=${on} answered ${result.error}`).toBe(200);
          expect(result.data!.calendar?.on, `on=${on} was not answered with today`).toBe(today);
        }

        // The baselines page's source: an enum column, like the campaign status.
        const baselines = (await import("../../app/routes/app.prices.baselines._index")).loader as Loader;
        const hacked = await get(baselines, "/app/prices/baselines?source=hacked&page=-3");
        expect(hacked.status, `source=hacked answered ${hacked.error}`).toBe(200);
        expect(hacked.data!.total, "an unknown source filtered every baseline out").toBe(2);
        const lower = await get(baselines, "/app/prices/baselines?source=install_capture");
        expect(lower.status, `source=install_capture answered ${lower.error}`).toBe(200);
        expect(lower.data!.filters.source).toBe("INSTALL_CAPTURE");
        expect(lower.data!.total).toBe(2);

        // The Activity log's dates.
        const activity = (await import("../../app/routes/app.activity")).loader as Loader;
        const dates = await get(activity, "/app/activity?from=garbage&to=2026-02-31");
        expect(dates.status, `from=garbage&to=2026-02-31 answered ${dates.error}`).toBe(200);

        // None of it was a failure, so none of it is in Diagnostics.
        expect(await prisma.errorEvent.count({ where: { shopId } })).toBe(reportsBefore);
      },
    );
  });

  it("files a query Prisma refuses as ours, never as Shopify rejecting a change", async () => {
    // The real client's own error for the query the list used to build, not a stand-in:
    // what is classified is exactly what Prisma throws.
    const thrown = await prisma.campaign
      .count({ where: { shopId: "no-such-shop", status: "active" as never } })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown, "Prisma accepted a status outside its enum").not.toBeNull();
    const error = toAppError(thrown);
    expect(error.code).toBe("UNKNOWN");
    expect(error.userMessage).not.toMatch(/Shopify|ledger/);
  });
});
