/**
 * A price inside an audit entry, and how the Activity log knows it is one (#757).
 *
 * Resolving a drift wrote `observedPrice: "70100"` -- the integer minor units, as a bare
 * string -- and the log printed it as written. A merchant read their own $701.00 price as
 * "70100", i.e. $70,100, and in a zero-decimal currency the same field would have been
 * right by accident, which made the two impossible to tell apart. The CSV export carried
 * the same number.
 *
 * ## How the summariser knows a field is money, and in which currency
 *
 * The writer says so. A price goes into `before`/`after` as `{ minor, currency }`, built
 * by `auditMoney` below, and the summariser formats exactly the values of that shape and
 * no others. The amount is a string because JSON has no bigint, and the currency rides
 * with each amount rather than with the entry.
 *
 * Considered and rejected:
 *
 * - **Field names** (`*Price`, `*Cost`, `compareAt`). The guardrail settings entry
 *   already has a `minPrice`, and it is stored in *major* units, as the merchant typed it
 *   (see `toGuardrails`). A name rule would show a $5 floor as "$0.05" -- the same bug in
 *   the other direction -- and would claim the next `priceListGid` or `priceCount`
 *   somebody adds without anybody deciding it should.
 * - **A `currency` key beside the fields.** Still needs a name rule to say which fields it
 *   applies to, and ties every amount in an entry to one currency. A market whose
 *   currency changed holds two.
 * - **The shop's currency.** Wrong for every amount on a market price list, and a shop
 *   that changes currency would silently re-read its whole history in the new one.
 *
 * The cost of the choice: an entry written before a writer adopts this shape carries a
 * bare number with no currency. Where one exists (drift entries before #757), the reader
 * recovers the currency from the record the price came from rather than guessing -- see
 * `activity.server.ts`. A release one version back renders this shape as its JSON, which
 * is ugly and still correct.
 *
 * Client-safe on purpose: the summary is read on the page and in the export alike.
 */

import { formatPrice } from "../money/format";

export interface AuditMoney {
  /** Integer minor units: cents for USD, whole yen for JPY. A string, as JSON has no bigint. */
  minor: string;
  /** ISO 4217, uppercase. */
  currency: string;
}

const INTEGER = /^-?\d+$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A price as an audit entry stores it. Null for no price, which the log shows as a dash. */
export function auditMoney(
  amount: bigint | number | null | undefined,
  currency: string,
): AuditMoney | null {
  if (amount === null || amount === undefined) return null;
  if (typeof amount === "number" && !Number.isInteger(amount)) {
    // Not rounded here: a fractional minor unit means a float reached a price, and
    // quietly writing a whole number into the merchant's record would hide where.
    throw new Error(`An audit price must be whole minor units, got ${amount} ${currency}.`);
  }
  return { minor: String(amount), currency: currency.trim().toUpperCase() };
}

/**
 * The stored value, if it is a price written by `auditMoney`; otherwise null.
 *
 * Strict on purpose. Exactly these two keys, an integer amount and a three-letter code:
 * anything looser would start formatting some other object that happened to have a
 * `currency` in it, which is the field-name guess this module exists to avoid.
 */
export function asAuditMoney(value: unknown): AuditMoney | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2) return null;
  const { minor, currency } = record;
  if (typeof minor !== "string" || !INTEGER.test(minor)) return null;
  if (typeof currency !== "string" || !CURRENCY.test(currency)) return null;
  return { minor, currency };
}

/** "$701.00", "¥701", "KWD 1.500" -- the price as the merchant would write it. */
export function describeAuditMoney(value: AuditMoney): string {
  return formatPrice(BigInt(value.minor), value.currency);
}
