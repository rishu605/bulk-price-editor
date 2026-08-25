/**
 * Choosing a rounding profile per currency.
 *
 * A campaign that prices into three markets prices in three currencies, and one shared
 * profile cannot be right for all of them. `.99` is the charm ending shoppers expect in
 * dollars and pounds; parts of the euro zone favour `.95`; yen has no sub-unit at all,
 * so a charm ending is not merely unconventional there but unexpressible.
 *
 * This is not cosmetic (edge case E9). A price that ends wrong reads as a mistake to a
 * local shopper — the same instinct that makes £19.99 look considered makes ¥1,999.00
 * look like a broken import. The whole reason to price per market is to look local, and
 * a shared profile throws that away at the last step.
 *
 * Profiles are stored by name rather than by structure. A merchant picks "prices ending
 * .99", not `{mode: "charm", ending: 99, direction: "nearest"}`, and a stored name keeps
 * campaigns readable, comparable and migratable in a way a serialised object does not.
 */

import { isZeroDecimal } from "./currency";
import {
  NO_ROUNDING,
  charm95,
  charm99,
  wholeUnits,
  type RoundingProfile,
} from "./rounding";

/** Rounding a merchant can choose, by the name we store and show. */
export const ROUNDING_PROFILES = {
  none: NO_ROUNDING,
  charm99,
  charm95,
  whole: wholeUnits,
  nearest10: { mode: "step", step: 10, direction: "nearest" },
  nearest100: { mode: "step", step: 100, direction: "nearest" },
} as const satisfies Record<string, RoundingProfile>;

export type RoundingProfileName = keyof typeof ROUNDING_PROFILES;

/** What each profile is called in the interface. */
export const ROUNDING_LABELS: Record<RoundingProfileName, string> = {
  none: "Leave prices exactly as calculated",
  charm99: "Prices ending .99",
  charm95: "Prices ending .95",
  whole: "Whole amounts, no cents",
  nearest10: "Nearest 10",
  nearest100: "Nearest 100",
};

export function isRoundingProfileName(value: unknown): value is RoundingProfileName {
  return typeof value === "string" && value in ROUNDING_PROFILES;
}

/**
 * A campaign's rounding, per currency, as the merchant chose it.
 *
 * One default plus overrides, rather than an entry per currency: a merchant selling in
 * eight markets should not have to answer the same question eight times, and a currency
 * added later must inherit something sensible rather than nothing at all.
 *
 * Stored and displayed by name. The resolver never sees this shape — `resolvePolicy`
 * turns it into structural profiles first — so the pricing core stays independent of
 * what happens to be on a dropdown this month.
 */
export interface StoredRoundingPolicy {
  default: RoundingProfileName;
  byCurrency: Record<string, RoundingProfileName>;
}

/** The same policy in the form the resolver applies. */
export interface RoundingPolicy {
  default: RoundingProfile;
  byCurrency: Record<string, RoundingProfile>;
}

export const NO_ROUNDING_POLICY: RoundingPolicy = {
  default: NO_ROUNDING,
  byCurrency: {},
};

/** Wraps a single profile as a policy. Every currency rounds the same way. */
export function policyOf(profile: RoundingProfile): RoundingPolicy {
  return { default: profile, byCurrency: {} };
}

/** Turns a merchant's named choices into the profiles the resolver applies. */
export function resolvePolicy(stored: StoredRoundingPolicy): RoundingPolicy {
  const byCurrency: Record<string, RoundingProfile> = {};

  for (const [currency, name] of Object.entries(stored.byCurrency)) {
    byCurrency[currency.toUpperCase()] = ROUNDING_PROFILES[name];
  }

  return { default: ROUNDING_PROFILES[stored.default], byCurrency };
}

/**
 * The profile that applies to one currency.
 *
 * A charm ending chosen for the store's own currency is *not* inherited into a
 * zero-decimal one. `applyRounding` would degrade it safely to whole units, but silently:
 * the merchant would see "prices ending .99" on the campaign and yen prices that do not.
 * Falling back to the currency's own sensible default instead means what is shown and
 * what happens are the same thing.
 */
export function profileFor(policy: RoundingPolicy, currency: string): RoundingProfile {
  const profile = policy.byCurrency[currency.toUpperCase()] ?? policy.default;

  if (profile.mode === "charm" && profile.ending > 0 && isZeroDecimal(currency)) {
    return ROUNDING_PROFILES.nearest10;
  }

  return profile;
}

/** The name that applies to a currency, for showing the merchant what will happen. */
export function profileNameFor(
  policy: StoredRoundingPolicy,
  currency: string,
): RoundingProfileName {
  const chosen = policy.byCurrency[currency.toUpperCase()] ?? policy.default;

  if (ROUNDING_PROFILES[chosen].mode === "charm" && isZeroDecimal(currency)) {
    const charm = ROUNDING_PROFILES[chosen];
    if (charm.mode === "charm" && charm.ending > 0) return "nearest10";
  }

  return chosen;
}

/**
 * Reads a stored policy, tolerating every shape the field has ever held.
 *
 * Campaigns created before per-currency rounding stored a bare string, and campaigns
 * created before rounding existed at all stored nothing. Both must keep pricing the way
 * they always did — a migration that changed what an existing campaign does to prices is
 * the one migration this product cannot ship.
 */
export function parseRoundingPolicy(raw: unknown): StoredRoundingPolicy {
  if (isRoundingProfileName(raw)) return { default: raw, byCurrency: {} };

  if (raw && typeof raw === "object") {
    const value = raw as { default?: unknown; byCurrency?: unknown };
    const byCurrency: Record<string, RoundingProfileName> = {};

    if (value.byCurrency && typeof value.byCurrency === "object") {
      for (const [currency, name] of Object.entries(value.byCurrency)) {
        if (isRoundingProfileName(name)) byCurrency[currency.toUpperCase()] = name;
      }
    }

    return {
      default: isRoundingProfileName(value.default) ? value.default : "none",
      byCurrency,
    };
  }

  return { default: "none", byCurrency: {} };
}

/** A starting policy for a store: charm where there is room, tidy steps where not. */
export function defaultPolicyFor(currencies: readonly string[]): StoredRoundingPolicy {
  const byCurrency: Record<string, RoundingProfileName> = {};

  for (const currency of currencies) {
    if (isZeroDecimal(currency)) byCurrency[currency.toUpperCase()] = "nearest10";
  }

  return { default: "charm99", byCurrency };
}
