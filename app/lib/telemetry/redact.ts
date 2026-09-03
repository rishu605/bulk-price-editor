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

/**
 * Money-shaped substrings inside free text.
 *
 * Shared by both sinks that export free text: Sentry's `beforeSend` and the span
 * recorder in `otel.server`. It lived in `sentry.server.ts` while Sentry was the only
 * caller, which meant the trace path had no equivalent at all and the same thrown
 * error was scrubbed on its way to Sentry and exported intact to the collector.
 * One definition, so the two cannot drift about what a price looks like.
 *
 * `redactPrices` above works on keys and values; an exception message is one string,
 * and "cannot set price 19.99 on variant 12345" carries a price in the middle of a
 * sentence. Numbers with exactly two decimals are the shape worth catching — variant ids
 * and counts do not look like that.
 *
 * The lookbehind and lookahead are load-bearing rather than tidiness. Without them
 * "API version 2025.10" matched its own tail as "5.10" and became "API version 2[price]",
 * which is both a corrupted message and a false sense that something was protected. And
 * without them the leading space was consumed, so every redaction ran the previous word
 * into the placeholder.
 *
 * Over-matching costs more than it looks: a log full of unreadable messages is a log
 * people stop reading, which is worse than the leak it was guarding against.
 */
export function redactPricesInText(text: string): string {
  return text.replace(
    /(?<![\d.])[$£€¥]?\d{1,3}(?:[,\s]\d{3})*\.\d{2}(?!\d)/g,
    "[price]",
  );
}
