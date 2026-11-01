/**
 * A campaign's own floors and floor-breach policy (#816, PRD A-3.7, D30).
 *
 * The store's guardrails bound every campaign, and the resolver has always merged a campaign's
 * own floors over them, tighter only. Nothing ever set any: every campaign was created with
 * `{}`, and its policy was copied from Settings without the merchant seeing it. A clearance
 * with a lower floor than every day, or a luxury line with a higher one, could not be said.
 *
 * The editor's Advanced section and the campaign's Overview tab set them now. A floor that
 * tightens the store's is the campaign's to set. One that goes below it is a deliberate act,
 * so it is asked for by typing the word, and the audit log records who typed it and what it
 * went below. Pure and client-safe, and the one place each of these is answered, so the
 * editor, its preview, the save, the campaign page and the run cannot disagree (rule 4):
 *
 *  - what a campaign stores, read back (`campaignGuardrailsOf`);
 *  - what the resolver merges over the store's (`resolverGuardrails`);
 *  - what a form says, and which of it goes below the store's (`floorsFromForm`);
 *  - which of that still needs the word (`stillToConfirm`), and how it is asked (`looseningAsk`);
 *  - which floors apply, and whose they are (`floorsView`).
 *
 * A floor is compared with the store's as it is now, not as it was when the campaign was saved:
 * the store's floors are read live (D21), and "tighter than the store's" means what it means
 * today. One the store has since overtaken is the store's again, and one that has come to sit
 * below it is not loosened unless somebody said so.
 */

import { describeActor } from "../audit/actor";
import { auditMoney } from "../audit/money";
import { formatWhen } from "../format/display";
import { format, formatPrice } from "../money/format";
import type { Money } from "../money/money";
import { isKnownCurrency } from "../money/currency";
import { typedAmount } from "../money/typed-amount";
import { inCurrency, mergeGuardrails } from "../pricing/guardrails";
import type { GuardrailFloor, GuardrailViolationPolicy, Guardrails } from "../pricing/types";
import { MAX_MARGIN_PERCENT } from "../settings/guardrail-input";

/** What a campaign stores in its `guardrails` column. Every field absent is every campaign before #816. */
export interface CampaignGuardrails {
  /** Its own "never at or below cost"; absent follows the store's. */
  neverBelowCost?: boolean;
  /** Its own minimum margin; null is none, which counts only where it is confirmed as loosened. */
  minMarginPercent?: number | null;
  /** Its own minimum price, in the store's currency; null is none, as above. */
  minPrice?: Money | null;
  /** Its own floor-breach policy; absent follows the store's until it starts (D21). */
  violationPolicy?: GuardrailViolationPolicy;
  /** The floors it sets below the store's, and who typed the word for them. */
  loosened?: Loosening;
}

/** A typed confirmation of floors below the store's: which, who and when. */
export interface Loosening {
  floors: GuardrailFloor[];
  /** The actor, as the audit log records one. */
  by: string;
  /** An ISO instant. */
  at: string;
}

/** The three floors, in the order Settings lists them. */
export const FLOORS: readonly GuardrailFloor[] = ["neverBelowCost", "minMarginPercent", "minPrice"];

/** Each floor as Settings names it. */
export const FLOOR_LABELS: Readonly<Record<GuardrailFloor, string>> = {
  neverBelowCost: "Never price at or below cost",
  minMarginPercent: "Minimum margin",
  minPrice: "Minimum price",
};

/** The form's fields. `floors` says the rest were posted, so a box left unticked reads as unticked. */
export const FLOOR_FIELDS = {
  marker: "floors",
  neverBelowCost: "floorNeverBelowCost",
  minMarginPercent: "floorMinMargin",
  minPrice: "floorMinPrice",
  policy: "breachPolicy",
  word: "loosen",
} as const;

/** The word that confirms floors below the store's. Not "apply": a reflex for one must not pass the other. */
export const LOOSEN_WORD = "loosen";

/** Whether what was typed is the word: "loosen", in any case, spaces aside. */
export function typedLoosen(typed: string | null | undefined): boolean {
  return (typed ?? "").trim().toLowerCase() === LOOSEN_WORD;
}

const POLICIES = new Set<GuardrailViolationPolicy>(["clamp", "skip", "block"]);

/**
 * A campaign's stored guardrails, read tolerantly. The column is JSON and was `{}` on every
 * campaign before #816; a value this does not recognise is left out, which follows the store's
 * floor -- the direction that never prices lower than the merchant asked.
 */
export function campaignGuardrailsOf(raw: unknown): CampaignGuardrails {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const stored: CampaignGuardrails = {};
  if (typeof value.neverBelowCost === "boolean") stored.neverBelowCost = value.neverBelowCost;
  if (value.minMarginPercent === null || isMargin(value.minMarginPercent)) stored.minMarginPercent = value.minMarginPercent;
  if (value.minPrice === null || isMoney(value.minPrice)) stored.minPrice = value.minPrice;
  if (POLICIES.has(value.violationPolicy as GuardrailViolationPolicy)) {
    stored.violationPolicy = value.violationPolicy as GuardrailViolationPolicy;
  }
  const loosened = value.loosened as Partial<Loosening> | undefined;
  if (loosened && typeof loosened.by === "string" && typeof loosened.at === "string" && Array.isArray(loosened.floors)) {
    const floors = FLOORS.filter((floor) => loosened.floors!.includes(floor));
    if (floors.length > 0) stored.loosened = { floors, by: loosened.by, at: loosened.at };
  }
  return stored;
}

function isMargin(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_MARGIN_PERCENT;
}

function isMoney(value: unknown): value is Money {
  const money = value as Money | null;
  return (
    typeof money === "object" && money !== null && Number.isInteger(money.amount) && money.amount >= 0 && typeof money.currency === "string"
  );
}

/** Whether the campaign sets anything of its own: a floor, or a policy. */
export function setsAnything(stored: CampaignGuardrails): boolean {
  return ownFloors(stored).length > 0 || stored.violationPolicy !== undefined;
}

/** The floors a campaign sets a value of its own for. */
export function ownFloors(stored: CampaignGuardrails): GuardrailFloor[] {
  return FLOORS.filter((floor) => stored[floor] !== undefined);
}

/** Whether a campaign's stored guardrails set any floor of its own. */
export function hasOwnFloors(raw: unknown): boolean {
  return ownFloors(campaignGuardrailsOf(raw)).length > 0;
}

/**
 * The guardrails the resolver merges over the store's for this campaign. A null floor is
 * left out, which is none only where it is confirmed in `loosens`, and the store's otherwise.
 */
export function resolverGuardrails(stored: CampaignGuardrails): Guardrails {
  const loosens = stored.loosened?.floors ?? [];
  return {
    ...(stored.neverBelowCost !== undefined ? { neverBelowCost: stored.neverBelowCost } : {}),
    ...(typeof stored.minMarginPercent === "number" ? { minMarginPercent: stored.minMarginPercent } : {}),
    ...(stored.minPrice ? { minPrice: stored.minPrice } : {}),
    ...(loosens.length > 0 ? { loosens } : {}),
  };
}

/** The floors that apply to this campaign's prices in `currency`, merged exactly as the resolver merges them. */
export function floorsApplying(stored: CampaignGuardrails, store: Guardrails, currency: string): Guardrails {
  return mergeGuardrails(store, inCurrency(resolverGuardrails(stored), currency));
}

/** Of a campaign's own floors, the ones below the store's as it is now. */
export function belowStore(own: CampaignGuardrails, store: Guardrails): GuardrailFloor[] {
  return FLOORS.filter((floor) => own[floor] !== undefined && lower(floor, own, store));
}

/** Whether `a`'s value of `floor` is below `b`'s: none is below any value. */
function lower(floor: GuardrailFloor, a: CampaignGuardrails, b: CampaignGuardrails | Guardrails): boolean {
  if (floor === "neverBelowCost") return a.neverBelowCost !== true && b.neverBelowCost === true;
  if (floor === "minMarginPercent") {
    const [mine, theirs] = [a.minMarginPercent ?? null, b.minMarginPercent ?? null];
    return theirs !== null && (mine === null || mine < theirs);
  }
  const [mine, theirs] = [a.minPrice ?? null, b.minPrice ?? null];
  // A minimum in another currency than the store's now is not applied to its base price at all
  // (`inCurrency`), so it is below nothing.
  if (theirs === null || (mine !== null && mine.currency !== theirs.currency)) return false;
  return mine === null || mine.amount < theirs.amount;
}

/**
 * Of the floors `next` sets below the store's, the ones nobody has confirmed: not among those
 * `previous` was confirmed for, or set lower than it was then. Editing another field of a
 * campaign whose clearance floor was confirmed does not ask again; taking that floor further down
 * does.
 */
export function stillToConfirm(next: CampaignGuardrails, below: readonly GuardrailFloor[], previous: CampaignGuardrails): GuardrailFloor[] {
  const confirmed = new Set(previous.loosened?.floors ?? []);
  return below.filter((floor) => !confirmed.has(floor) || lower(floor, next, previous));
}

/** What a form of floor fields says, or why it cannot be saved. */
export type FloorsInput =
  | { ok: true; floors: CampaignGuardrails; below: GuardrailFloor[] }
  | { ok: false; problems: string[] };

type Read = (name: string) => string | null;

/**
 * The campaign's own floors and policy, as the fields describe them, against the store's floors
 * now. A field left as the store's is not the campaign's: it follows the store's, as today, so a
 * campaign whose fields nobody touched stores nothing and behaves exactly as before #816. Blank
 * is none; a box unticked is off.
 *
 * Without the `floors` field nothing was posted -- Home's quick sale, an import, an old link --
 * and the campaign sets nothing.
 */
export function floorsFromForm(read: Read, currency: string, store: Guardrails): FloorsInput {
  if ((read(FLOOR_FIELDS.marker) ?? "") !== "1") return { ok: true, floors: {}, below: [] };

  const problems: string[] = [];
  const typed = (name: string) => (read(name) ?? "").trim();

  const margin = typed(FLOOR_FIELDS.minMarginPercent);
  const marginValue = margin === "" ? null : Number(margin);
  if (marginValue !== null && !isMargin(marginValue)) {
    problems.push(
      `This campaign's minimum margin (%) must be a number from 0 to ${MAX_MARGIN_PERCENT}, or blank for none. “${margin}” is not.`,
    );
  }

  const price = typed(FLOOR_FIELDS.minPrice);
  let priceValue: Money | null = null;
  if (price !== "") {
    const label = `This campaign's minimum price (${currency})`;
    const amount = isKnownCurrency(currency) ? typedAmount(label, price, currency) : null;
    if (!amount) problems.push(`${label} cannot be read in a currency Anchor does not know. Leave it blank.`);
    else if (!amount.ok) problems.push(amount.message);
    else if (amount.amount.amount < 0) problems.push(`${label} must be zero or more, or blank for none. “${price}” is not.`);
    else priceValue = amount.amount;
  }
  if (problems.length > 0) return { ok: false, problems };

  const policy = typed(FLOOR_FIELDS.policy) as GuardrailViolationPolicy;
  const floors: CampaignGuardrails = {
    ...(typed(FLOOR_FIELDS.neverBelowCost) !== "") !== (store.neverBelowCost === true)
      ? { neverBelowCost: store.neverBelowCost !== true }
      : {},
    ...(marginValue !== (store.minMarginPercent ?? null) ? { minMarginPercent: marginValue } : {}),
    ...(samePrice(priceValue, store.minPrice ?? null) ? {} : { minPrice: priceValue }),
    ...(POLICIES.has(policy) ? { violationPolicy: policy } : {}),
  };
  return { ok: true, floors, below: belowStore(floors, store) };
}

function samePrice(a: Money | null, b: Money | null): boolean {
  if (a === null || b === null) return a === b;
  return a.amount === b.amount && a.currency === b.currency;
}

/** A floor's value as a merchant reads it: "on", "25%", "$5.00", "none". */
export function floorValue(floor: GuardrailFloor, guardrails: CampaignGuardrails | Guardrails): string {
  if (floor === "neverBelowCost") return guardrails.neverBelowCost ? "on" : "off";
  if (floor === "minMarginPercent") {
    return typeof guardrails.minMarginPercent === "number" ? `${guardrails.minMarginPercent}%` : "none";
  }
  return guardrails.minPrice ? formatPrice(guardrails.minPrice.amount, guardrails.minPrice.currency) : "none";
}

/** "minimum margin 10% (the store's is 25%)", for each floor named. */
function againstStore(floors: readonly GuardrailFloor[], own: CampaignGuardrails, store: Guardrails): string {
  return listed(
    floors.map((floor) => `${FLOOR_LABELS[floor].toLowerCase()} ${floorValue(floor, own)} (the store's is ${floorValue(floor, store)})`),
  );
}

/**
 * What the save asks before floors below the store's are kept, beside the box for the word. It
 * is the same sentence on a new campaign and on one already running.
 */
export function looseningAsk(floors: readonly GuardrailFloor[], own: CampaignGuardrails, store: Guardrails): string {
  return (
    `This goes below the store's floors: ${againstStore(floors, own, store)}. Prices can then be written lower than ` +
    `Settings allows, for this campaign only. Type ${LOOSEN_WORD} to confirm it. Your name and what it went below are ` +
    "recorded in the activity log."
  );
}

/** What the campaign page, its Apply dialog and the editor's preview say about the floors. */
export interface FloorsView {
  /** The floors it is planned with, in a sentence: "Never at or below cost, at least 25% margin". */
  applied: string;
  /** Whose they are: the store's, or which are the campaign's own. */
  whose: string;
  /**
   * Its own floors below the store's that nobody has confirmed, so the store's apply instead: a
   * copy's, whose confirmation stayed with the campaign it was copied from, or one the store's
   * floor has since overtaken.
   */
  unconfirmed: string | null;
}

/**
 * Which floors apply to a campaign's prices in the store's `currency`, and whose. `timeZone`
 * dates a confirmation.
 */
export function floorsView(stored: CampaignGuardrails, store: Guardrails, currency: string, timeZone: string): FloorsView {
  const applying = floorsApplying(stored, store, currency);
  const confirmed = new Set(stored.loosened?.floors ?? []);
  const own = ownFloors(stored);
  const below = belowStore(stored, store);
  const loosened = own.filter((floor) => confirmed.has(floor) && below.includes(floor));
  const unconfirmed = own.filter((floor) => !confirmed.has(floor) && below.includes(floor));
  // Its own, and tighter than the store's now: the floor that applies is the campaign's.
  const tighter = own.filter((floor) => lower(floor, store, stored));

  const sentences: string[] = [];
  if (tighter.length > 0) sentences.push(`This campaign's own ${againstStore(tighter, stored, store)}, tighter than the store's.`);
  if (loosened.length > 0 && stored.loosened) {
    sentences.push(
      `This campaign's own ${againstStore(loosened, stored, store)}, below the store's, confirmed by ` +
        `${describeActor(stored.loosened.by)} on ${formatWhen(stored.loosened.at, timeZone)}.`,
    );
  }
  const theirs = tighter.length + loosened.length;
  sentences.push(theirs === 0 ? "The store's floors, from Settings." : theirs < FLOORS.length ? "The rest are the store's, from Settings." : "");

  return {
    applied: describeFloors(applying),
    whose: sentences.filter(Boolean).join(" "),
    unconfirmed:
      unconfirmed.length > 0
        ? `This campaign's own ${againstStore(unconfirmed, stored, store)} is below the store's, and nobody has confirmed ` +
          `that for this campaign, so the store's applies. To use its own instead, set it again below and type ${LOOSEN_WORD}.`
        : null,
  };
}

/**
 * The guardrails a draft in the editor is previewed with (#816): its own floors over the store's,
 * those below the store's as though confirmed. Nothing is created until they are, so the preview
 * shows the prices the campaign will have once somebody types the word, and says that it will ask.
 */
export function draftGuardrails(own: CampaignGuardrails, below: readonly GuardrailFloor[]): Guardrails {
  return { ...resolverGuardrails(own), ...(below.length > 0 ? { loosens: [...below] } : {}) };
}

/** What the editor's preview says about a draft's floors: which apply, whose, and what Create will ask. */
export function draftFloorsView(
  own: CampaignGuardrails,
  below: readonly GuardrailFloor[],
  store: Guardrails,
  currency: string,
): Omit<FloorsView, "unconfirmed"> & { below: string | null } {
  const tighter = ownFloors(own).filter((floor) => lower(floor, store, own));
  return {
    applied: describeFloors(mergeGuardrails(store, inCurrency(draftGuardrails(own, below), currency))),
    whose:
      tighter.length + below.length === 0
        ? "The store's floors, from Settings."
        : [
            ...(tighter.length > 0 ? [`This campaign's own ${againstStore(tighter, own, store)}, tighter than the store's.`] : []),
            ...(tighter.length + below.length < FLOORS.length ? ["The rest are the store's, from Settings."] : []),
          ].join(" ") || "This campaign's own floors.",
    below:
      below.length > 0
        ? `Below the store's: ${againstStore(below, own, store)}. Create asks you to type ${LOOSEN_WORD} to confirm it.`
        : null,
  };
}

/** The floors that apply, in a sentence: "Never at or below cost, at least 25% margin and at least $5.00". */
export function describeFloors(guardrails: Guardrails): string {
  const parts = [
    ...(guardrails.neverBelowCost ? ["never at or below cost"] : []),
    ...(guardrails.minMarginPercent !== undefined ? [`at least ${guardrails.minMarginPercent}% margin`] : []),
    ...(guardrails.minPrice ? [`at least ${formatPrice(guardrails.minPrice.amount, guardrails.minPrice.currency)}`] : []),
  ];
  if (parts.length === 0) return "None: no floor applies, only that a price stays above zero";
  const sentence = listed(parts);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The fields' values as a form renders them. */
export interface FloorFields {
  neverBelowCost: boolean;
  /** As typed: "25", or "" for none. */
  minMarginPercent: string;
  /** In major units, as typed: "5.00", or "" for none. */
  minPrice: string;
  /** The campaign's own choice, or "" for the store's. */
  policy: GuardrailViolationPolicy | "";
}

/**
 * What the fields show for a campaign: the floors that apply to it, so saving them untouched
 * changes nothing. A floor of its own below the store's that nobody confirmed shows the store's,
 * which is what applies; to keep it, somebody sets it again and types the word.
 */
export function floorFieldsOf(stored: CampaignGuardrails, store: Guardrails, currency: string): FloorFields {
  const applying = floorsApplying(stored, store, currency);
  return {
    neverBelowCost: applying.neverBelowCost === true,
    minMarginPercent: applying.minMarginPercent === undefined ? "" : String(applying.minMarginPercent),
    minPrice: applying.minPrice ? format(applying.minPrice) : "",
    policy: stored.violationPolicy ?? "",
  };
}

/** The fields as a link carries them back from the full preview, or the store's where it carries none. */
export function floorFieldsFrom(params: URLSearchParams, store: FloorFields): FloorFields {
  if (params.get(FLOOR_FIELDS.marker) !== "1") return store;
  const policy = params.get(FLOOR_FIELDS.policy) ?? "";
  return {
    neverBelowCost: (params.get(FLOOR_FIELDS.neverBelowCost) ?? "") !== "",
    minMarginPercent: params.get(FLOOR_FIELDS.minMarginPercent) ?? "",
    minPrice: params.get(FLOOR_FIELDS.minPrice) ?? "",
    policy: POLICIES.has(policy as GuardrailViolationPolicy) ? (policy as GuardrailViolationPolicy) : "",
  };
}

/**
 * Floors as an audit entry records them: one flat key each, the minimum price with its
 * currency (`auditMoney`), so the activity log reads "minMarginPercent: 25 → 10". With `named`,
 * exactly those floors, none as null, for an entry about what a confirmation went below;
 * without, the campaign's own floors and policy, whichever it sets.
 */
export function floorsAudit(guardrails: CampaignGuardrails | Guardrails, named?: readonly GuardrailFloor[]): Record<string, unknown> {
  const floors = named ?? FLOORS.filter((floor) => guardrails[floor] !== undefined);
  const entry: Record<string, unknown> = Object.fromEntries(
    floors.map((floor) => {
      const value = guardrails[floor];
      if (floor !== "minPrice") return [floor, value ?? (floor === "neverBelowCost" ? false : null)];
      const price = value as Money | null | undefined;
      return [floor, price ? auditMoney(price.amount, price.currency) : null];
    }),
  );
  const policy = (guardrails as CampaignGuardrails).violationPolicy;
  return named || !policy ? entry : { ...entry, violationPolicy: policy };
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
