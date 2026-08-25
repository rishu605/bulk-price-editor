/**
 * Store settings, including the guardrails that bound every campaign.
 *
 * Stored as JSON on the shop row so the shape can evolve without a migration, but
 * read back through a parser that validates and defaults, so the rest of the app
 * never handles a half-populated settings object.
 *
 * Guardrails are the merchant-facing half of invariant I6: no campaign may price a
 * variant below its floor. They were enforceable from the start but unreachable --
 * preview and run both passed an empty object -- so this is what makes them real.
 */

import prisma from "../db.server";
import { decimalsFor } from "../lib/money/format";
import { money } from "../lib/money/money";
import type { Guardrails } from "../lib/pricing/types";

export interface StoreSettings {
  /** Never price at or below cost. Requires cost data on the variant. */
  neverBelowCost: boolean;
  /** Minimum gross margin as a percentage of selling price. */
  minMarginPercent: number | null;
  /** Absolute minimum price, in major units as typed by the merchant. */
  minPrice: number | null;
  /** What to do when a computed price breaches a floor. */
  violationPolicy: "clamp" | "skip" | "block";
  /** What to do when a cost-dependent guardrail meets a variant with no cost. */
  missingCostPolicy: "skip" | "error";
}

export const DEFAULT_SETTINGS: StoreSettings = {
  // Off by default: switching it on when most variants have no cost would skip
  // most of the catalogue, which looks like the app is broken. The dashboard
  // prompts for it once cost data exists.
  neverBelowCost: false,
  minMarginPercent: null,
  minPrice: null,
  violationPolicy: "clamp",
  missingCostPolicy: "skip",
};

/** Reads settings, filling anything absent or malformed with a default. */
export async function readSettings(shopId: string): Promise<StoreSettings> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { settings: true },
  });

  return parseSettings(shop?.settings);
}

export function parseSettings(raw: unknown): StoreSettings {
  const value = (raw ?? {}) as Partial<Record<keyof StoreSettings, unknown>>;

  return {
    neverBelowCost: value.neverBelowCost === true,
    minMarginPercent: finiteOrNull(value.minMarginPercent, 0, 99.9),
    minPrice: finiteOrNull(value.minPrice, 0, Number.MAX_SAFE_INTEGER),
    violationPolicy:
      value.violationPolicy === "skip" || value.violationPolicy === "block"
        ? value.violationPolicy
        : "clamp",
    missingCostPolicy: value.missingCostPolicy === "error" ? "error" : "skip",
  };
}

function finiteOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  // Clamp rather than reject: a merchant typing 150 into a margin field means
  // "as high as possible", and refusing the whole save would lose their other edits.
  return Math.min(max, Math.max(min, parsed));
}

export async function writeSettings(
  shopId: string,
  settings: StoreSettings,
  /** Who changed them. Recorded so "who turned the cost floor off?" is answerable. */
  actor?: string,
): Promise<StoreSettings> {
  const parsed = parseSettings(settings);

  // Read first, so the entry records what actually changed rather than only where it
  // ended up. "minPrice: — → 5" answers the question somebody opens the audit log
  // with; "minPrice: 5" leaves them wondering whether it was ever anything else.
  const previous = await readSettings(shopId);

  // Merged, not replaced. Notification preferences live in the same JSON column, and
  // saving a guardrail must not silently switch a merchant's emails off.
  const existing = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { settings: true },
  });

  await prisma.shop.update({
    where: { id: shopId },
    data: { settings: { ...((existing.settings ?? {}) as object), ...parsed } as never },
  });

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor: actor ?? null,
      action: "settings.guardrails.update",
      entity: "Shop",
      entityId: shopId,
      before: previous as never,
      after: parsed as never,
    },
  });

  return parsed;
}

/**
 * Converts stored settings into the `Guardrails` the resolver expects.
 *
 * `minPrice` is typed by merchants in major units and stored that way, so it is
 * converted to minor units here -- the single place that translation happens.
 *
 * The multiplier comes from the currency table rather than a literal 100. A
 * hardcoded 100 would read a ¥1,000 floor as ¥100,000 and a 1.5 KWD floor as
 * 0.15 KWD, which is the same mistake three service files were quietly making
 * until recently.
 */
export function toGuardrails(settings: StoreSettings, currency: string): Guardrails {
  const perMajor = 10 ** decimalsFor(currency);

  return {
    neverBelowCost: settings.neverBelowCost,
    minMarginPercent: settings.minMarginPercent ?? undefined,
    minPrice:
      settings.minPrice === null
        ? undefined
        : money(Math.round(settings.minPrice * perMajor), currency),
    missingCostPolicy: settings.missingCostPolicy,
  };
}

/** The shop's primary currency, taken from the mirror. */
export async function shopCurrency(shopId: string): Promise<string> {
  const row = await prisma.variantIndex.findFirst({
    where: { shopId, currency: { not: null } },
    select: { currency: true },
  });
  return row?.currency ?? "USD";
}

/** Guardrails ready to hand to the planner, in one call. */
export async function guardrailsFor(shopId: string): Promise<Guardrails> {
  const [settings, currency] = await Promise.all([
    readSettings(shopId),
    shopCurrency(shopId),
  ]);
  return toGuardrails(settings, currency);
}
