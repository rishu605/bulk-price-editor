import { useEffect } from "react";
import { useSearchParams } from "react-router";

import { formatCount } from "../lib/format/display";
import { SPACE } from "../lib/ui/spacing";

/**
 * Paging, and saying where you are in the set.
 *
 * Every table in the prices section had its own copy of this arithmetic, each free to
 * be off by one differently. It is the kind of duplication that never causes a bug big
 * enough to chase and always causes small ones: a last page that says "51-50 of 50", a
 * Next button that stays enabled on the final page.
 *
 * `from`/`to` rather than only a page number, because "showing 51-100 of 3,412" answers
 * the question a merchant scanning for one variant is actually asking.
 *
 * The three parts sit at item rhythm and share a centre line: Previous, the count, Next
 * are one control, and spacing them like separate blocks -- which `gap="base"` did -- was
 * asking the merchant to notice three things instead of one.
 *
 * The count is `subdued` and tabular. Subdued because it is orientation, not the action;
 * tabular because the digits change on every click, and proportional figures make the
 * two buttons either side of them shuffle sideways each time.
 *
 * It lives here rather than under `components/prices/` because it is not the prices
 * section's. Activity had kept its own to the end -- Previous, "Page 2 of 69", Next --
 * and a sentence that answers a different question from the one this asks. Two paginations
 * in one app is the `SectionNav`/`PricesTabs` shape again, and a component sitting in one
 * section's folder is most of how the second one gets written.
 */
export function Pagination({
  page,
  total,
  pageSize,
  noun = "variants",
}: {
  page: number;
  total: number;
  pageSize: number;
  /** What is being counted, so the sentence reads naturally on every tab. */
  noun?: string;
}) {
  const [, setSearchParams] = useSearchParams();

  const { lastPage, from, to, beyond } = pageRange(page, total, pageSize);

  const goTo = (next: number, replace = false) =>
    setSearchParams(
      (params) => {
        params.set("page", String(next));
        return params;
      },
      { replace, preventScrollReset: true },
    );

  // A bookmark or a shared link to page 40 lands past the end once the list has shrunk
  // (#775): an empty table and "1499971–3669 of 3,669", with Next disabled and Previous
  // going to another empty page. It goes to the last page instead, in place of the URL
  // it came with, so Back does not return to the empty one.
  useEffect(() => {
    if (beyond) goTo(lastPage, true);
    // `goTo` is rebuilt each render; the page numbers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beyond, lastPage]);

  if (total === 0) return null;

  return (
    <s-stack direction="inline" gap={SPACE.item} alignItems="center">
      <s-button disabled={page <= 1 || undefined} onClick={() => goTo(Math.min(page, lastPage) - 1)}>
        Previous
      </s-button>
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        {formatCount(from)}–{formatCount(to)} of {formatCount(total)} {noun}
      </s-text>
      <s-button disabled={page >= lastPage || undefined} onClick={() => goTo(page + 1)}>
        Next
      </s-button>
    </s-stack>
  );
}

/**
 * The range a page shows, never past the end (#775): a page beyond the last reads as the
 * last, so the range cannot run backwards, and `beyond` says the URL needs correcting.
 */
export function pageRange(page: number, total: number, pageSize: number) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const shown = Math.min(Math.max(1, page), lastPage);
  return {
    lastPage,
    shown,
    from: total === 0 ? 0 : (shown - 1) * pageSize + 1,
    to: Math.min(total, shown * pageSize),
    beyond: total > 0 && page > lastPage,
  };
}

/**
 * What a capped table is not showing.
 *
 * Rendered as its own line rather than folded into a heading, because the number it
 * carries changes the meaning of everything above it: a table that shows fifteen of
 * fifteen and a table that shows fifteen of three thousand look identical.
 */
export function ShowingSome({
  shown,
  total,
  noun,
  suffix,
}: {
  shown: number;
  total: number;
  noun: string;
  /** What to do about the rest — an export, a filter, a next page. */
  suffix?: string;
}) {
  if (total <= shown) return null;

  return (
    <s-paragraph>
      <s-text color="subdued" fontVariantNumeric="tabular-nums">
        Showing {formatCount(shown)} of {formatCount(total)} {noun}.{suffix ? ` ${suffix}` : ""}
      </s-text>
    </s-paragraph>
  );
}
