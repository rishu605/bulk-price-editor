/**
 * CSV serialisation and browser-side download.
 *
 * Pure and client-safe on purpose. The obvious way to offer a download is a resource
 * route that returns the file, and inside an embedded app that route cannot
 * authenticate: following the link is a full navigation of the iframe, which drops the
 * App Bridge params, and the loader sees `shop: null`. The merchant gets a blank frame
 * instead of a file.
 *
 * Building the file in the browser from data the page already loaded sidesteps the
 * problem rather than fighting it — there is no request, so there is nothing to
 * authenticate.
 */

/** Quotes a cell, doubling any internal quotes. */
export function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Renders a header and rows as CSV text.
 *
 * Every cell is quoted rather than only the ones that look like they need it. Product
 * titles contain commas and inches routinely — `Monitor, 24"` — and a report that
 * corrupts itself on ordinary catalogue data is not a record of anything.
 */
export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * Hands the browser a file to save.
 *
 * A temporary anchor rather than navigating: navigation would take the embedded frame
 * with it. The object URL is revoked straight after — without it every export leaks a
 * copy of the file for the lifetime of the page.
 */
export function downloadCsv(filename: string, csv: string): void {
  // A byte-order mark, so Excel opens the file as UTF-8 instead of mangling every
  // accented product title. Numbers and Sheets ignore it. Written as an escape
  // because a literal BOM in source is invisible and lint flags it.
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  URL.revokeObjectURL(url);
}

/** Turns a name into something safe to land in a downloads folder. */
export function filenameSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
