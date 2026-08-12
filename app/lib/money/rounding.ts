/**
 * Campaign rounding profiles.
 *
 * Two modes:
 *
 *   charm — force a fixed ending: 19.47 → 19.99. What merchants mean by "price it
 *           at .99". Meaningless in a zero-decimal currency, which is why it
 *           degrades rather than emitting a fractional yen (edge case E9).
 *
 *   step  — round to a multiple: nearest 5 → 1947 → 1945 or 1950. The sane
 *           behaviour for JPY/KRW and useful anywhere a merchant wants tidy prices.
 *
 * Direction is explicit. `down` is worth understanding: it can only ever lower a
 * price, which is what keeps it safe for discount campaigns — but it also means a
 * rounded result can cross below a guardrail floor, so clamping runs *after*
 * rounding in the resolver, never before.
 */

import { exponentOf, isZeroDecimal } from "./currency";
import { money, type Money } from "./money";

export type RoundingDirection = "up" | "down" | "nearest";

export interface CharmProfile {
  mode: "charm";
  /**
   * The forced ending, in minor units below one major unit.
   * 99 → x.99, 95 → x.95, 0 → whole units.
   */
  ending: number;
  direction: RoundingDirection;
}

export interface StepProfile {
  mode: "step";
  /** Step size in minor units. 5 → nearest 5 cents; 100 → nearest whole USD. */
  step: number;
  direction: RoundingDirection;
}

export type RoundingProfile = CharmProfile | StepProfile;

/** No-op profile. Explicit, so "don't round" is a choice rather than an omission. */
export const NO_ROUNDING: StepProfile = { mode: "step", step: 1, direction: "nearest" };

export class InvalidRoundingProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRoundingProfileError";
  }
}

export function validateProfile(profile: RoundingProfile, currency: string): void {
  if (profile.mode === "step") {
    if (!Number.isInteger(profile.step) || profile.step < 1) {
      throw new InvalidRoundingProfileError(
        `Step must be a positive integer number of minor units, got ${profile.step}.`,
      );
    }
    return;
  }

  if (!Number.isInteger(profile.ending) || profile.ending < 0) {
    throw new InvalidRoundingProfileError(
      `Charm ending must be a non-negative integer, got ${profile.ending}.`,
    );
  }
  const perMajor = 10 ** exponentOf(currency);
  if (!isZeroDecimal(currency) && profile.ending >= perMajor) {
    throw new InvalidRoundingProfileError(
      `Charm ending ${profile.ending} does not fit below one major unit of ${currency} ` +
        `(max ${perMajor - 1}).`,
    );
  }
}

/**
 * Resolves a profile against a currency, degrading charm profiles where they cannot
 * apply.
 *
 * A `.99` ending in JPY is not an error the merchant should have to think about —
 * there is simply no sub-yen space for it. We fall back to step rounding to the
 * nearest whole unit and preserve the direction they chose, which is the closest
 * honest interpretation of "make these prices tidy".
 */
export function effectiveProfile(profile: RoundingProfile, currency: string): RoundingProfile {
  if (profile.mode === "charm" && isZeroDecimal(currency)) {
    return { mode: "step", step: 1, direction: profile.direction };
  }
  validateProfile(profile, currency);
  return profile;
}

function roundStep(amount: number, step: number, direction: RoundingDirection): number {
  const q = amount / step;
  switch (direction) {
    case "up":
      return Math.ceil(q) * step;
    case "down":
      return Math.floor(q) * step;
    case "nearest": {
      const lower = Math.floor(q) * step;
      const upper = lower + step;
      const dLower = amount - lower;
      const dUpper = upper - amount;
      if (dLower < dUpper) return lower;
      if (dUpper < dLower) return upper;
      // Exact tie: round half away from zero so behaviour is symmetric about 0.
      return amount >= 0 ? upper : lower;
    }
  }
}

function roundCharm(
  amount: number,
  ending: number,
  perMajor: number,
  direction: RoundingDirection,
): number {
  // Candidate endings in the major units bracketing `amount`.
  const base = Math.floor(amount / perMajor) * perMajor;
  let candidates = [base - perMajor + ending, base + ending, base + perMajor + ending];

  // A non-negative price must never round to a negative one. Without this, 47c under
  // a .99 profile picks -1c: the candidates are [-1, 99, 199] and -1 is genuinely the
  // closest. Correct arithmetic, nonsense price -- found by the property tests.
  if (amount >= 0) {
    const nonNegative = candidates.filter((c) => c >= 0);
    // If every candidate is negative the price is below the smallest charm price;
    // zero is the only non-negative answer, and it keeps `down` monotonic.
    if (nonNegative.length === 0) return 0;
    candidates = nonNegative;
  }

  switch (direction) {
    case "up": {
      const up = candidates.filter((c) => c >= amount);
      return up.length ? Math.min(...up) : Math.max(...candidates);
    }
    case "down": {
      const down = candidates.filter((c) => c <= amount);
      if (down.length) return Math.max(...down);
      // No charm price at or below `amount`. Clamping to zero preserves the
      // guarantee that `down` never increases a price; returning the smallest
      // candidate would raise it.
      return amount >= 0 ? 0 : Math.min(...candidates);
    }
    case "nearest": {
      let best = candidates[0];
      let bestDist = Math.abs(amount - best);
      for (const c of candidates.slice(1)) {
        const d = Math.abs(amount - c);
        // Ties resolve upward, matching step-nearest for positive amounts.
        if (d < bestDist || (d === bestDist && c > best)) {
          best = c;
          bestDist = d;
        }
      }
      return best;
    }
  }
}

/**
 * Applies a rounding profile.
 *
 * Idempotent by construction: rounding an already-rounded value returns it
 * unchanged, which the property tests assert directly. That matters because a
 * campaign may be re-planned and re-previewed many times, and a rounding step that
 * drifted on each pass would break the idempotency invariant (I2).
 */
export function applyRounding(value: Money, profile: RoundingProfile): Money {
  const effective = effectiveProfile(profile, value.currency);

  if (effective.mode === "step") {
    if (effective.step === 1) return value; // nothing to do at minor-unit granularity
    return money(roundStep(value.amount, effective.step, effective.direction), value.currency);
  }

  const perMajor = 10 ** exponentOf(value.currency);
  return money(
    roundCharm(value.amount, effective.ending, perMajor, effective.direction),
    value.currency,
  );
}

// ------------------------------------------------------------------ presets

/** `.99` endings, rounding to the nearest such price. */
export const charm99: CharmProfile = { mode: "charm", ending: 99, direction: "nearest" };

/** `.95` endings. */
export const charm95: CharmProfile = { mode: "charm", ending: 95, direction: "nearest" };

/** Whole major units (x.00). */
export const wholeUnits: CharmProfile = { mode: "charm", ending: 0, direction: "nearest" };

/**
 * A sensible default for a currency: charm `.99` where there is room for it,
 * nearest-10 minor units otherwise. Used to seed store defaults per enabled currency.
 */
export function defaultProfileFor(currency: string): RoundingProfile {
  return isZeroDecimal(currency)
    ? { mode: "step", step: 10, direction: "nearest" }
    : charm99;
}
