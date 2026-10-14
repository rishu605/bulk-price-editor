/**
 * A crash in the browser leaves a reference Diagnostics can find (#783).
 *
 * The error screen gave the merchant "ANC-KFTN-QS6Q · UNKNOWN" and promised it led to the
 * full technical detail. It was minted and logged in the browser and never stored, so
 * Diagnostics answered "No error stored under ANC-KFTN-QS6Q" when they quoted it.
 *
 * Driven through the reporting endpoint's own action, with a report built by the same
 * function the boundary uses, and read back through the Diagnostics loader -- the lookup a
 * merchant or support actually performs. Only `authenticate.admin` is replaced, with the
 * shop chosen per request.
 */

import { describe, expect, it, vi } from "vitest";

import prisma from "../../app/db.server";
import {
  BROWSER_METHOD,
  BROWSER_REPORTS_PER_HOUR,
  recordBrowserError,
} from "../../app/services/error-report.server";
import {
  browserReportOf,
  MAX_BODY_CHARS,
  MAX_FRAMES,
  MAX_STACK_CHARS,
} from "../../app/lib/errors/browser-report";
import { newErrorId } from "../../app/lib/errors/error-id";
import { reportErrorSync } from "../../app/lib/errors/report";
import { withChaos } from "../harness/scenario";

let signedIn = "";

vi.mock("../../app/shopify.server", () => ({
  authenticate: {
    admin: async () => ({ session: { shop: signedIn }, sessionToken: undefined, admin: {} }),
  },
}));

/** What the boundary would post for a render that threw `error` on `path`. */
function reportFor(error: Error, path = "/app/campaigns/cmt-browser-783") {
  const reported = reportErrorSync(error, { route: path });
  return browserReportOf(error, { errorId: reported.errorId ?? "", code: reported.code }, path);
}

/** Posts a body to the reporting endpoint as the merchant of `shop`. */
async function post(shop: string, body: unknown): Promise<{ status: number; stored: unknown }> {
  signedIn = shop;
  const { action } = await import("../../app/routes/app.error-report");
  const response = (await action({
    request: new Request("https://example.invalid/app/error-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never)) as Response;
  return { status: response.status, stored: ((await response.json()) as { stored?: unknown }).stored };
}

/** The Diagnostics page's lookup, as the merchant of `shop`. */
async function diagnostics(shop: string, id: string) {
  signedIn = shop;
  const { loader } = await import("../../app/routes/app.settings.diagnostics");
  return (await loader({
    request: new Request(`https://example.invalid/app/settings/diagnostics?id=${id}`),
    params: {},
    context: {},
  } as never)) as {
    match: {
      errorId: string;
      code: string;
      route: string | null;
      method: string | null;
      message: string;
      stack: string | null;
      userMessage: string;
    } | null;
    recent: Array<{ errorId: string }>;
  };
}

/** A render failure whose message carries a price, the way a careless throw would. */
function crash(): Error {
  try {
    const details = undefined as unknown as { map: (fn: unknown) => unknown };
    // A message the throwing code wrote, with a price in it. It must not reach the table.
    throw new TypeError(`Could not show 19.99 for variant 4412: ${String(details.map)}`);
  } catch (error) {
    return error as Error;
  }
}

describe("chaos: a crash in the browser", () => {
  it("is stored under the reference its screen showed, and Diagnostics finds it", async () => {
    await withChaos("browser-error-report", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      const report = reportFor(crash(), "/app/campaigns/cmt-browser-783?price=12.50#ledger");

      const answer = await post(domain, report);
      expect(answer, "the endpoint did not say it stored the report").toEqual({ status: 200, stored: true });

      const found = (await diagnostics(domain, report.errorId)).match;
      expect(found?.errorId, "Diagnostics could not find the reference the screen showed").toBe(report.errorId);
      expect(found?.code).toBe("UNKNOWN");
      expect(found?.method).toBe(BROWSER_METHOD);
      expect(found?.route, "the route kept its query string").toBe("/app/campaigns/cmt-browser-783");
      expect(found?.stack, "no frames were stored").toMatch(/^\s*at /);
      expect(found?.userMessage.length).toBeGreaterThan(0);

      // No price anywhere in the row: not in the stack (whose V8 header is the message),
      // not in the technical message, not from the query string.
      const row = await prisma.errorEvent.findUniqueOrThrow({ where: { errorId: report.errorId } });
      const text = JSON.stringify(row);
      expect(text, "a price from the thrown message was stored").not.toContain("19.99");
      expect(text, "a price from the page's query string was stored").not.toContain("12.50");
      expect(row.shopId).toBe(shopId);

      // And in the shop's recent failures, which is where support looks without a reference.
      const recent = (await diagnostics(domain, report.errorId)).recent.map((entry) => entry.errorId);
      expect(recent).toContain(report.errorId);
    });
  });

  it("is stored once, however many times the same reference is posted", async () => {
    await withChaos("browser-error-retry", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { domain } = chaos.fixture;
      const report = reportFor(crash());

      // Three sent together, as a screen that renders twice and a retry might, then a plain
      // retry. Through the endpoint the requests stagger, so the real race is below.
      const raced = await Promise.all([post(domain, report), post(domain, report), post(domain, report)]);
      expect(raced).toEqual([
        { status: 200, stored: true },
        { status: 200, stored: true },
        { status: 200, stored: true },
      ]);
      expect(await post(domain, report)).toEqual({ status: 200, stored: true });

      expect(
        await prisma.errorEvent.count({ where: { errorId: report.errorId } }),
        "posting the same reference again stored a second row",
      ).toBe(1);

      // The race again, one layer down where nothing staggers the callers: every one of
      // them reads "not stored" before any of them inserts.
      const shop = { id: chaos.fixture.shopId, domain };
      const twin = reportFor(crash());
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => recordBrowserError(shop, twin)));
      expect(outcomes, "a racing duplicate failed instead of finding the row").toEqual(Array(5).fill("stored"));
      expect(await prisma.errorEvent.count({ where: { errorId: twin.errorId } })).toBe(1);
    });
  });

  it("refuses a malformed reference, and bounds what it does store", async () => {
    await withChaos("browser-error-bounds", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      const before = await prisma.errorEvent.count({ where: { shopId } });
      const valid = reportFor(crash());

      // Not the house format: O and 0 are outside the alphabet; the rest are not ids at all.
      for (const errorId of ["ANC-OOOO-0000", "not-an-id", "", `ANC-${"A".repeat(500)}`, 42, null]) {
        expect(await post(domain, { ...valid, errorId }), `accepted ${String(errorId)}`).toEqual({
          status: 400,
          stored: false,
        });
      }
      expect(await post(domain, "{ not json"), "accepted a body that is not JSON").toEqual({ status: 400, stored: false });
      expect(
        await post(domain, { ...valid, errorId: newErrorId(), stack: "x".repeat(MAX_BODY_CHARS) }),
        "read a body past the ceiling",
      ).toEqual({ status: 413, stored: false });
      expect(await prisma.errorEvent.count({ where: { shopId } }), "a refused report was stored").toBe(before);

      // An oversized stack and an unknown code are narrowed rather than refused.
      // Under the body ceiling, over the stack ceiling in both lines and characters.
      const frames = Array.from({ length: 150 }, (_, i) => `    at render${i} (https://app.example/assets/page-${i}.js:1:${i})`);
      const oversized = {
        ...valid,
        errorId: newErrorId(),
        code: "DROP TABLE error_events",
        name: "TypeError: with a sentence",
        stack: ["TypeError: header line with 19.99 in it", ...frames].join("\n"),
      };
      expect(await post(domain, oversized)).toEqual({ status: 200, stored: true });

      const row = await prisma.errorEvent.findUniqueOrThrow({ where: { errorId: oversized.errorId } });
      expect(row.code, "a code outside the list was stored as sent").toBe("UNKNOWN");
      expect(row.stack?.length ?? 0).toBeLessThanOrEqual(MAX_STACK_CHARS);
      expect(row.stack?.split("\n").length ?? 0).toBeLessThanOrEqual(MAX_FRAMES);
      expect(row.stack, "the stack's header -- the message -- was stored").not.toContain("header line");
      expect(row.context, "a name that is not a class name was stored").toBeNull();
    });
  });

  it("belongs to the signed-in shop, whatever the body says", async () => {
    await withChaos("browser-error-tenancy", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const a = { id: chaos.fixture.shopId, domain: chaos.fixture.domain };
      const bRow = await prisma.shop.create({ data: { domain: `browser-other-${chaos.seed}.myshopify.com` } });
      const b = { id: bRow.id, domain: bRow.domain };

      try {
        const report = reportFor(crash());
        // The body names shop B every way it could. The session is shop A's.
        expect(await post(a.domain, { ...report, shop: b.domain, shopId: b.id, shopDomain: b.domain })).toEqual({
          status: 200,
          stored: true,
        });

        const row = await prisma.errorEvent.findUniqueOrThrow({ where: { errorId: report.errorId } });
        expect(row.shopId, "the body chose the shop").toBe(a.id);
        expect((await diagnostics(a.domain, report.errorId)).match?.errorId).toBe(report.errorId);
        expect((await diagnostics(b.domain, report.errorId)).match, "shop B can read shop A's crash").toBeNull();

        // Shop B posting a reference shop A already holds neither moves nor copies it.
        expect(await post(b.domain, report)).toEqual({ status: 409, stored: false });
        expect((await prisma.errorEvent.findUniqueOrThrow({ where: { errorId: report.errorId } })).shopId).toBe(a.id);
        expect(await prisma.errorEvent.count({ where: { errorId: report.errorId } })).toBe(1);
      } finally {
        await prisma.errorEvent.deleteMany({ where: { shopId: b.id } });
        await prisma.shop.delete({ where: { id: b.id } });
      }
    });
  });

  it("stops storing past the hourly ceiling, so a crash that reloads itself cannot fill the table", async () => {
    await withChaos("browser-error-ceiling", { catalog: { products: 1, variantsPerProduct: 1 } }, async (chaos) => {
      const { shopId, domain } = chaos.fixture;
      const before = reportFor(crash());
      expect(await post(domain, before)).toEqual({ status: 200, stored: true });

      await prisma.errorEvent.createMany({
        data: Array.from({ length: BROWSER_REPORTS_PER_HOUR }, () => ({
          errorId: newErrorId(),
          shopId,
          code: "UNKNOWN",
          message: "earlier crash",
          userMessage: "x",
          method: BROWSER_METHOD,
        })),
      });

      const report = reportFor(crash());
      expect(await post(domain, report)).toEqual({ status: 429, stored: false });
      expect(await prisma.errorEvent.count({ where: { errorId: report.errorId } })).toBe(0);
      expect((await diagnostics(domain, report.errorId)).match).toBeNull();

      // A reference stored before the ceiling is still stored after it. A retry of it must
      // say so, or the screen tells the merchant a findable reference was lost.
      expect(await post(domain, before), "a retry of a stored reference was refused by the ceiling").toEqual({
        status: 200,
        stored: true,
      });
    });
  });
});
