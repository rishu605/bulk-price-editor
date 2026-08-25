import type { ReactNode } from "react";
import { useSearchParams } from "react-router";

/**
 * A filter form that navigates client-side instead of reloading the page.
 *
 * A plain `<form method="get">` looks like the obvious thing here and is quietly
 * broken inside an embedded app. Submitting one does a full browser navigation that
 * replaces the entire query string — including `host`, `embedded`, `id_token` and
 * `shop`, which App Bridge put there and which `authenticate.admin` needs. The server
 * then sees `shop: null`, fails to authenticate, and the merchant gets a blank page
 * with nothing in the console to explain it.
 *
 * Merging into the existing params instead keeps those intact, and staying inside the
 * router means the data request goes through App Bridge's authenticated fetch rather
 * than around it.
 */
export function FilterForm({
  /** Field names this form owns. Anything else in the URL is left untouched. */
  fields,
  children,
}: {
  fields: readonly string[];
  children: ReactNode;
}) {
  const [, setSearchParams] = useSearchParams();

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);

        setSearchParams((params) => {
          for (const field of fields) {
            const value = String(data.get(field) ?? "").trim();
            if (value) params.set(field, value);
            else params.delete(field);
          }

          // Page 4 of the old filter is meaningless under the new one, and landing
          // on an empty page reads as "no results" rather than "wrong page".
          params.delete("page");
          return params;
        });
      }}
    >
      {children}
    </form>
  );
}
