/**
 * Keeping prices out of telemetry.
 *
 * The rule is absolute and it is in CLAUDE.md: telemetry carries shop id, plan, counts,
 * durations and statuses — never a price. A merchant's pricing is commercially sensitive
 * and a third-party error tracker is somewhere they never agreed to put it. It also
 * leaves the building: Sentry, a log aggregator, a metrics vendor, each with their own
 * retention and their own access list.
 *
 * A rule enforced by everyone remembering is a rule that lasts until somebody adds a
 * field in a hurry. So it is enforced here, at the boundary, over whatever object it is
 * handed — and the redaction is by key *and* by shape, because the two failure modes are
 * different. A field named `price` is caught by name. A field named `value` holding
 * "19.99" is not, and that is the one that gets added in a hurry.
 */

/** Keys whose values are prices whatever they are called. */
const PRICE_KEYS =
  /^(price|amount|cost|compare_?at|compareAtPrice|basePrice|baseCompareAt|livePrice|liveCompareAt|intendedPrice|intendedCompareAt|beforePrice|beforeCompareAt|observedPrice|expectedPrice|msrp|subtotal|total)$/i;

/**
 * A value that looks like money regardless of its key.
 *
 * Deliberately broad. A decimal with two places, a currency symbol, or a bare currency
 * code all count — being over-strict here costs a redacted count now and then, and being
 * under-strict costs a merchant's price list sitting in somebody's error tracker.
 */
const MONEY_SHAPE = /[$£€¥]\s?\d|(?:^|\s)\d+\.\d{2}(?:\s|$)|\b(?:USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF|SEK)\b/;

export const REDACTED = "[redacted:price]";

/**
 * Returns a copy safe to send to a third party.
 *
 * Depth-limited, because telemetry context is occasionally handed something with a
 * cycle or a Prisma model hanging off it, and an error reporter that stack-overflows
 * while reporting an error is worse than no reporter.
 */
export function redactPrices(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";

  if (typeof value === "string") return MONEY_SHAPE.test(value) ? REDACTED : value;

  // BigInt is how every price in this codebase is stored. Nothing else uses it, so it
  // is redacted on sight rather than inspected.
  if (typeof value === "bigint") return REDACTED;

  if (Array.isArray(value)) return value.map((entry) => redactPrices(entry, depth + 1));

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = PRICE_KEYS.test(key) ? REDACTED : redactPrices(entry, depth + 1);
    }
    return out;
  }

  return value;
}

/** True when a payload still carries something that reads as money. */
export function containsPrice(value: unknown): boolean {
  return JSON.stringify(redactPrices(value)) !== JSON.stringify(stringifySafe(value));
}

function stringifySafe(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? `${entry}` : entry)));
}
