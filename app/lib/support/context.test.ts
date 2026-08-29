/**
 * The rule that makes attaching context safe at all.
 *
 * `docs/telemetry`: shop id, plan, counts and durations, never a price. A support mailbox
 * is the easiest place to break that rule, because everything about a support request
 * argues for sending more.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { CONTEXT_FIELDS, contextLines, supportContext } from "./context";

const base = {
  shopDomain: "boltify-apps.myshopify.com",
  plan: "growth",
  appVersion: "1.4.0",
};

describe("what is attached", () => {
  it("carries only the seven named fields", () => {
    const context = supportContext({ ...base, path: "/app/campaigns/c1", campaignId: "c1" });

    // Against the exported list, not against a literal written here: a copy in the test
    // would let a new field slip in without either one noticing.
    expect(Object.keys(context).sort()).toEqual([...CONTEXT_FIELDS].sort());
  });

  it("keeps the path and drops the query string", () => {
    // A query string is where a filter, a search term or an amount ends up. "Where were
    // you" is answered by the route.
    expect(supportContext({ ...base, path: "/app/prices/live?q=19.99&min=1000" }).path).toBe(
      "/app/prices/live",
    );
  });

  it("keeps the path out of an absolute URL, and nothing else from it", () => {
    expect(
      supportContext({ ...base, path: "https://admin.shopify.com/app/campaigns?price=29.99" }).path,
    ).toBe("/app/campaigns");
  });

  it("treats an empty id as no id rather than as an empty one", () => {
    const context = supportContext({ ...base, campaignId: "", runId: undefined });

    expect(context.campaignId).toBeNull();
    expect(context.runId).toBeNull();
  });
});

describe("no attached field can carry a price", () => {
  it("holds for any ids and any path a merchant could be on", () => {
    // A property rather than an example. The failure this guards against is a future
    // field, and a fixed case would only ever prove the fields that exist today.
    const money = /(?<![\d.])\d{1,3}(?:[,\s]\d{3})*\.\d{2}(?!\d)/;

    fc.assert(
      fc.property(
        fc.record({
          campaignId: fc.string({ maxLength: 30 }),
          runId: fc.string({ maxLength: 30 }),
          errorId: fc.string({ maxLength: 30 }),
          query: fc.string({ maxLength: 40 }),
        }),
        ({ campaignId, runId, errorId, query }) => {
          const context = supportContext({
            ...base,
            // The realistic leak: a price in the URL a merchant was looking at.
            path: `/app/prices/live?amount=19.99&${query}`,
            campaignId,
            runId,
            errorId,
          });

          expect(context.path).not.toMatch(money);
        },
      ),
    );
  });
});

describe("what the merchant is shown", () => {
  it("lists what will be sent, and leaves out what is not there", () => {
    const lines = contextLines(supportContext({ ...base, path: "/app", errorId: "e-9" }));

    expect(lines).toContain("Shop: boltify-apps.myshopify.com");
    expect(lines).toContain("Error id: e-9");
    expect(lines.some((line) => line.startsWith("Campaign:"))).toBe(false);
  });

  it("labels every field it can show, so none arrives unexplained", () => {
    const full = supportContext({
      ...base,
      path: "/app/campaigns/c1",
      campaignId: "c1",
      runId: "r1",
      errorId: "e1",
    });

    expect(contextLines(full)).toHaveLength(CONTEXT_FIELDS.length);
  });
});
