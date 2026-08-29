/**
 * There is no campaign delete, and this is what keeps it that way.
 *
 * `campaign_runs` cascades from `campaigns`, and `variant_changes` cascades from
 * `campaign_runs`. So deleting one campaign row does not orphan a ledger row — it erases
 * every ledger row that campaign ever wrote, which is worse. Invariant I4 says nothing is
 * written to a storefront without a `variant_changes` row committed first; the ledger is
 * the evidence that invariant held, and it is what a revert recomputes against.
 *
 * The obvious fix is `ON DELETE RESTRICT` on that first relation, and it is wrong here.
 * The `shop/redact` compliance webhook deletes a `Shop`, and all three tables cascade
 * from `Shop` as well, so a RESTRICT between two of them can abort a GDPR erasure
 * depending on the order Postgres processes the referencing tables in. Erasure has to
 * win; so the constraint stays permissive and the *app* is what does not offer a delete.
 *
 * Archive is the answer instead: `archivedAt` takes the campaign out of the list and
 * leaves the record whole.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Comments only, so prose about deleting cannot masquerade as a delete. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * The one place a campaign may legitimately be destroyed.
 *
 * `shop.deleteMany` in the compliance webhook, which cascades to everything this shop
 * owns. That is not a campaign delete — it is an erasure request, where destroying the
 * ledger is the whole point.
 */
const ERASURE = "app/routes/webhooks.compliance.tsx";

/**
 * Tracked files *and* untracked ones git is not ignoring.
 *
 * `git ls-files` alone lists only what is already committed, which means a brand-new file
 * — the most likely place for a new offender — is invisible to this check until after the
 * commit that introduced it. Found the hard way: a deliberately broken copy of this rule
 * passed because the file breaking it had not been `git add`ed yet.
 */
function sourceFiles(...paths: string[]): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...paths], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

describe("nothing in the app deletes a campaign", () => {
  const files = sourceFiles("app", "prisma")
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !f.includes(".test.") && f !== ERASURE);

  it("offers no campaign delete", () => {
    const offenders = files.filter((file) =>
      /prisma\.campaign\.delete|campaign\.deleteMany/.test(withoutComments(readFileSync(file, "utf8"))),
    );

    expect(
      offenders,
      "deleting a campaign cascades to its runs and to variant_changes — archive it instead",
    ).toEqual([]);
  });

  it("offers no run delete either", () => {
    // One step further down the same chain, and the same consequence: the ledger rows
    // hang off the run, so deleting a run is deleting the record of what it wrote.
    const offenders = files.filter((file) =>
      /prisma\.campaignRun\.delete|campaignRun\.deleteMany|prisma\.variantChange\.delete/.test(
        withoutComments(readFileSync(file, "utf8")),
      ),
    );

    expect(offenders, "the ledger is the record; nothing may remove rows from it").toEqual([]);
  });

  it("keeps the erasure path, because a redaction request has to be honoured", () => {
    // The inverse assertion. If the compliance webhook ever stops deleting the shop,
    // this file's whole argument for leaving the cascade permissive has gone with it.
    expect(withoutComments(readFileSync(ERASURE, "utf8"))).toContain("shop.deleteMany");
  });
});
