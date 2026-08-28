/**
 * Database values, as words.
 *
 * The app stores states as Prisma enums — `VERIFIED`, `CSV_IMPORT`, `INSTALL_CAPTURE` —
 * and rendered a lot of them straight into badges and table cells. SCREAMING_SNAKE in a
 * merchant-facing badge reads as an internal detail that leaked, and next to Polaris'
 * own sentence-case badges ("Fulfilled", "Paid") it reads as a different app.
 *
 * Three places had grown their own `toLowerCase().replace(/_/g, " ")` to cope, which is
 * this function with two of its three problems missing: it lowercases acronyms into
 * nonsense, and it leaves the first letter lowercase so a badge starts mid-sentence.
 *
 * ## Why a transformation and not a table of labels
 *
 * The same reason as the audit actions: a table is a thing that can be missing an entry,
 * and its failure mode is silent — a new enum value falls through to the raw string and a
 * merchant reads `DRIFT_ADOPTION`. A transformation cannot be missing an entry. The trade
 * is that the phrasing is mechanical rather than composed, which for state names is
 * exactly what is wanted: they should read the same way everywhere.
 *
 * The one thing a transformation genuinely cannot know is which tokens are acronyms, so
 * that is the one thing spelled out. `label.test.ts` renders every enum value in
 * `schema.prisma` through this, so a new value with an unlisted acronym shows up as a
 * failing expectation rather than as "Csv import" in production.
 */

/**
 * Tokens that are said, not spelled.
 *
 * Short and deliberately not speculative: every entry is a token that appears in an enum,
 * a CSV header or a field label this app actually renders.
 */
const ACRONYMS = new Set(["B2B", "CSV", "SKU", "ID", "GID", "API", "URL", "VAT"]);

/** `CSV_IMPORT` → "CSV import". `market.notice-resolved` → "Market notice resolved". */
export function humanise(value: string): string {
  // Dots, hyphens and underscores are all word breaks: the same function serves enum
  // values and the dotted audit actions, which differ only in their separator.
  const words = value
    .split(/[.\-_\s]+/)
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word.toLowerCase()));

  if (words.length === 0) return value;

  const [first, ...rest] = words;
  const opening = ACRONYMS.has(first) ? first : first.charAt(0).toUpperCase() + first.slice(1);

  return [opening, ...rest].join(" ");
}
