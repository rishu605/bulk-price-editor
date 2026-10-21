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
import {
  parseRoundingPolicy,
  type StoredRoundingPolicy,
} from "../lib/money/rounding-policy";
import { storedMajorUnits } from "../lib/money/typed-amount";
import type { Guardrails } from "../lib/pricing/types";
import { DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT, DEFAULT_CONFIRM_ABOVE_VARIANTS } from "../lib/campaigns/blast-radius";

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
  /**
   * The store's rounding, per currency.
   *
   * A store default rather than only a per-campaign one, because the answer is a
   * property of how the merchant sells — .99 in dollars, tidy tens in yen — and not of
   * any one sale. Campaigns inherit it and may override it.
   */
  rounding: StoredRoundingPolicy;
  /**
   * Campaigns changing more than this many variants need a second person's approval.
   *
   * Null, and off by default. Most stores are one person, and making them approve their
   * own work is a ritual that teaches people to click through warnings — which is worse
   * than no rule, because the same reflex is what makes real warnings ineffective.
   */
  approvalThreshold: number | null;
  /**
   * Campaigns writing more prices than this ask for "apply" to be typed (A-3.11, #818).
   *
   * Never off. A small shop lowers it and a large one raises it, but a campaign that can
   * reprice the whole store from a one-click dialog is the thing the confirmation exists
   * to stop.
   */
  confirmAboveVariants: number;
  /**
   * A written price moving more than this whole percentage of its baseline, or landing
   * that far below cost, asks for the word too (#818). 1 to 100.
   */
  confirmAboveChangePercent: number;
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
  // No rounding until a merchant asks for it. A store that has never opened the
  // setting should get exactly the prices the campaign calculated.
  rounding: { default: "none", byCurrency: {} },
  approvalThreshold: null,
  confirmAboveVariants: DEFAULT_CONFIRM_ABOVE_VARIANTS,
  confirmAboveChangePercent: DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT,
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
    rounding: parseRoundingPolicy(value.rounding),
    approvalThreshold: finiteOrNull(value.approvalThreshold, 1, Number.MAX_SAFE_INTEGER),
    // Settings saved before #818 have neither key, and read as the PRD's defaults.
    confirmAboveVariants: Math.trunc(
      finiteOrNull(value.confirmAboveVariants, 1, Number.MAX_SAFE_INTEGER) ?? DEFAULT_CONFIRM_ABOVE_VARIANTS,
    ),
    confirmAboveChangePercent: Math.trunc(
      finiteOrNull(value.confirmAboveChangePercent, 1, 100) ?? DEFAULT_CONFIRM_ABOVE_CHANGE_PERCENT,
    ),
  };
}

function finiteOrNull(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  // Clamped, for a value read back from storage that is somehow out of range. What a
  // merchant types never gets here out of range: the settings action refuses it first,
  // naming the field (#739), because silently turning 150 into 99.9 made a floor of a
  // thousand times cost under "Settings saved."
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

  // The approval threshold gets an entry of its own when it moves (#788). It is the
  // setting whose change matters most to somebody other than the person making it: the
  // author of a large campaign switching off the check meant for them. Inside the entry
  // above it is one field of seven, under a generic "settings" line; here it can be picked
  // out of the What filter and read at a glance -- who, from what, to what. A count of
  // variants, never a price.
  if (previous.approvalThreshold !== parsed.approvalThreshold) {
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: actor ?? null,
        action: "settings.approval.update",
        entity: "Shop",
        entityId: shopId,
        before: { approvalThreshold: previous.approvalThreshold } as never,
        after: { approvalThreshold: parsed.approvalThreshold } as never,
      },
    });
  }

  // The typed-confirmation thresholds likewise (#818): raising either one is somebody
  // deciding that fewer campaigns get a second look, and that should be findable by itself.
  // Only the ones that moved, so the entry says what changed. Counts and percentages,
  // never a price.
  const moved = (["confirmAboveVariants", "confirmAboveChangePercent"] as const).filter(
    (key) => previous[key] !== parsed[key],
  );
  if (moved.length > 0) {
    await prisma.auditLogEntry.create({
      data: {
        shopId,
        actor: actor ?? null,
        action: "settings.confirmation.update",
        entity: "Shop",
        entityId: shopId,
        before: Object.fromEntries(moved.map((key) => [key, previous[key]])) as never,
        after: Object.fromEntries(moved.map((key) => [key, parsed[key]])) as never,
      },
    });
  }

  return parsed;
}

/**
 * Converts stored settings into the `Guardrails` the resolver expects.
 *
 * `minPrice` is typed by merchants in major units and stored that way, so it is
 * converted to minor units here -- the single place that translation happens.
 *
 * The scale comes from the currency table rather than a literal 100. A
 * hardcoded 100 would read a ¥1,000 floor as ¥100,000 and a 1.5 KWD floor as
 * 0.15 KWD, which is the same mistake three service files were quietly making
 * until recently.
 *
 * And it is applied to the decimal the number prints as, not to the float (#1068):
 * `Math.round(9.995 * 100)` is 999, so a 9.995 floor let 9.99 through. A save refuses that
 * many decimals now; one stored before is rounded up, because a minimum of 9.995 is met by
 * 10.00 and not by 9.99.
 */
export function toGuardrails(settings: StoreSettings, currency: string): Guardrails {
  return {
    neverBelowCost: settings.neverBelowCost,
    minMarginPercent: settings.minMarginPercent ?? undefined,
    minPrice: settings.minPrice === null ? undefined : storedMajorUnits(settings.minPrice, currency, "ceil"),
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
