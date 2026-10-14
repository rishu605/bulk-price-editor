/**
 * Nothing records the store as the person who did something (#726).
 *
 * Drift decisions, a duplicate from the campaigns list and segments wrote `session.shop` --
 * the store's domain -- as the actor, `resolvedBy` and `createdBy`, while the campaign page
 * wrote the staff member through `actorFor`. The same merchant action was a person on one
 * page and the store on another, and "who kept this drifted price as the new baseline?",
 * the question the activity log exists for, had no answer.
 *
 * So every `session.shop` in a route or a service is one of the shapes below, none of
 * which is a "who". A new use that is not fails here, and is either one of these or an
 * `actorFor(sessionToken, session.shop)`.
 */

import { describe, expect, it } from "vitest";

import { sourceFiles, sourceOf } from "../testing/source";

/** The ways a route uses the store's domain that are not recording who did something. */
const NOT_A_WHO: Array<[RegExp, string]> = [
  [/ensureShop\(\s*$/, "finding the shop's row"],
  [/actorFor\(\s*sessionToken,\s*$/, "the fallback when no staff member is known"],
  [/\bdomain:\s*$/, "a where clause on the shop's domain"],
  [/\bshopDomain:\s*$/, "the support form's store field"],
  [/\bshop:\s*$/, "error-report context"],
  [/planReturnUrl\(\s*$/, "the billing return URL"],
  [/this\.open\(token,\s*$/, "the session store's decryption key"],
];

describe("who did it", () => {
  it("is never the store's domain where a person could be named", () => {
    const offences: string[] = [];
    let seen = 0;
    for (const file of sourceFiles("app/routes", "app/services").filter((f) => !/ \d+\.tsx?$/.test(f))) {
      const source = sourceOf(file);
      for (const match of source.matchAll(/session\.shop\b/g)) {
        seen += 1;
        const before = source.slice(Math.max(0, match.index! - 60), match.index!);
        if (!NOT_A_WHO.some(([shape]) => shape.test(before))) {
          const line = source.slice(0, match.index!).split("\n").length;
          offences.push(`${file}:${line}: …${before.split("\n").pop()!.trim()}session.shop`);
        }
      }
    }
    expect(seen, "the guard found no uses to check").toBeGreaterThan(10);
    expect(offences, "the store's domain recorded where actorFor names the staff member").toEqual([]);
  });
});
