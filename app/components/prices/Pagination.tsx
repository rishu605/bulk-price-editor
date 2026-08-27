import { useSearchParams } from "react-router";

import { formatCount } from "../../lib/format/display";

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

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  const goTo = (next: number) =>
    setSearchParams((params) => {
      params.set("page", String(next));
      return params;
    });

  if (total === 0) return null;

  return (
    <s-stack direction="inline" gap="base">
      <s-button disabled={page <= 1 || undefined} onClick={() => goTo(page - 1)}>
        Previous
      </s-button>
      <s-text tone="neutral">
        {from}–{to} of {formatCount(total)} {noun}
      </s-text>
      <s-button disabled={page >= lastPage || undefined} onClick={() => goTo(page + 1)}>
        Next
      </s-button>
    </s-stack>
  );
}
