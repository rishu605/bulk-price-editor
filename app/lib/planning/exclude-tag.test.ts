/**
 * "Everything on sale, except the four things we are not discounting."
 *
 * Sami has `Exclude products` as a card of its own beside "Apply to products"; neither of
 * the other two has anything. Ours had no way to say it: a merchant with a list of things
 * never to discount had to narrow the *inclusion* filter until it happened to leave them
 * out, which is a different scope that goes wrong the next time they add a product.
 *
 * Expressed as an ordinary condition rather than as a field on the campaign, so preview,
 * planning, enrolment and the run path all handle it without knowing exclusions exist.
 */

import { describe, expect, it } from "vitest";

import { astToWhere } from "../../services/segments.server";
import { describeScope } from "../campaigns/describe";

describe("the query", () => {
  it("asks the database to leave the tag out", () => {
    // A `NOT` inside the query rather than a filter over the results: the GIN index on
    // `tags` serves this, and a second pass would read the whole catalogue on the perf
    // store to throw most of it away.
    const where = astToWhere("shop", {
      groups: [
        {
          conditions: [
            { field: "collection", value: "Outerwear" },
            { field: "excludeTag", value: "no-sale" },
          ],
        },
      ],
    });

    expect(JSON.stringify(where)).toContain('"NOT"');
    expect(JSON.stringify(where)).toContain("no-sale");
    // And the inclusion half is still there — an exclusion that quietly replaced the
    // scope would price nothing at all.
    expect(JSON.stringify(where)).toContain("Outerwear");
  });

  it("ignores an empty exclusion rather than excluding everything", () => {
    // "Nothing excluded" is the default option, and it posts an empty string. Reading
    // that as `NOT tags has ""` would be a campaign that prices nothing, from a control
    // the merchant never touched.
    const where = astToWhere("shop", {
      groups: [{ conditions: [{ field: "excludeTag", value: "" }] }],
    });

    expect(JSON.stringify(where)).not.toContain('"NOT"');
  });
});

describe("what the merchant is told", () => {
  it("reads as an exception, not as another condition", () => {
    // "In Outerwear · except tagged no-sale" is a sentence somebody can check against
    // what they meant. "In Outerwear · Tagged no-sale" says the opposite of the truth.
    expect(
      describeScope({
        groups: [
          {
            conditions: [
              { field: "collection", value: "Outerwear" },
              { field: "excludeTag", value: "no-sale" },
            ],
          },
        ],
      }),
    ).toBe("In Outerwear · except tagged no-sale");
  });
});
