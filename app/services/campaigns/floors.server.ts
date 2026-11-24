/**
 * Saving a campaign's own floors and floor-breach policy (#816, D30): from the editor as it
 * creates one, and from the Floors card on its Overview tab afterwards.
 *
 * A floor that tightens the store's is saved as it is. One that goes below the store's is saved
 * only with the word typed, and the audit log records who typed it, what the floor became and
 * what it went below. A campaign already running is no exception: its floors can be changed,
 * and going below the store's asks the same question, because the next run, resume or new
 * product priced under it is written at that floor. Its policy cannot: a running campaign keeps
 * the policy it started with until it ends, its own choice included (D21).
 *
 * None of this writes a price. A saved floor reaches the storefront when the campaign is next
 * applied, and every stored plan of the shop hears of the write and is worked out again (#812).
 */

import prisma from "../../db.server";
import {
  campaignGuardrailsOf,
  describeFloors,
  FLOOR_FIELDS,
  floorFieldsOf,
  floorsAudit,
  floorsFromForm,
  floorsView,
  looseningAsk,
  stillToConfirm,
  typedLoosen,
  type CampaignGuardrails,
} from "../../lib/campaigns/campaign-floors";
import { AppError } from "../../lib/errors/app-error";
import { describeState, pricesMayBeLive, type CampaignState } from "../../lib/lifecycle/transitions";
import type { GuardrailFloor, Guardrails } from "../../lib/pricing/types";
import { guardrailsFor, readSettings, shopCurrency } from "../settings.server";

/** What a save of the floor fields keeps, or the question it asks first. */
export type FloorsSave =
  | {
      ok: true;
      guardrails: CampaignGuardrails;
      /** The floors this save confirmed below the store's, which its audit entry names. */
      confirmed: GuardrailFloor[];
      /** The store's floors it was compared with. */
      store: Guardrails;
      /** What was typed, for the entry. */
      typed: string;
      /**
       * The question the word answered, where this save confirmed any: a form that asks
       * something else next keeps the box, and the word in it, beside this sentence.
       */
      ask: string | null;
    }
  | { ok: false; ask: string };

/**
 * The floors and policy a form saves over `previous`, the campaign's as stored (nothing, for a
 * new one). A value that cannot be saved is refused naming the field, `unchanged` saying what
 * was left alone. Floors below the store's that nobody has confirmed are asked about, answered
 * as data so the form keeps what was typed: the sentence, beside the box for the word.
 */
export async function floorsToSave(
  shopId: string,
  read: (name: string) => string | null,
  previous: CampaignGuardrails,
  actor: string,
  unchanged: string,
): Promise<FloorsSave> {
  const [store, currency] = await Promise.all([guardrailsFor(shopId), shopCurrency(shopId)]);
  const input = floorsFromForm(read, currency, store);
  if (!input.ok) throw new AppError({ code: "VALIDATION", userMessage: `${input.problems.join(" ")} ${unchanged}` });

  const typed = (read(FLOOR_FIELDS.word) ?? "").trim();
  const asked = stillToConfirm(input.floors, input.below, previous);
  if (asked.length > 0 && !typedLoosen(typed)) return { ok: false, ask: looseningAsk(asked, input.floors, store) };

  // Confirmed now, by whoever typed the word; or each of them confirmed before and no lower
  // since, by whoever confirmed them then.
  const loosened =
    input.below.length === 0
      ? undefined
      : asked.length > 0 || !previous.loosened
        ? { floors: input.below, by: actor, at: new Date().toISOString() }
        : { ...previous.loosened, floors: input.below };
  return {
    ok: true,
    guardrails: { ...input.floors, ...(loosened ? { loosened } : {}) },
    confirmed: asked,
    store,
    typed,
    ask: asked.length > 0 ? looseningAsk(asked, input.floors, store) : null,
  };
}

/**
 * The audit entry for floors a save confirmed below the store's: who, the campaign, each floor
 * as the store had it and as it became, and the word. Written after the campaign it is about,
 * as `campaign.created` is: an entry about a campaign that does not exist would be a lie.
 */
export async function recordLoosening(shopId: string, campaignId: string, actor: string, save: FloorsSave): Promise<void> {
  if (!save.ok || save.confirmed.length === 0) return;
  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: "campaign.floors.loosened",
      entity: "Campaign",
      entityId: campaignId,
      before: floorsAudit(save.store, save.confirmed) as never,
      after: { ...floorsAudit(save.guardrails, save.confirmed), confirmation: save.typed } as never,
    },
  });
}

/**
 * What the Floors card's save answers: done, refused with why, or the question asked first --
 * a warning rather than a failure, since nothing is wrong yet -- with `loosen` for the box.
 */
export type FloorsAnswer = { ok: boolean; message: string; tone?: "warning"; loosen?: string };

/**
 * The Floors card's save on the campaign page (`intent=floors`), or null for any other intent.
 * A run writing the campaign is let finish first: what it writes was planned before the change.
 */
export async function floorsAction(
  shopId: string,
  campaignId: string,
  intent: string,
  form: FormData,
  actor: string,
): Promise<FloorsAnswer | null> {
  if (intent !== "floors") return null;
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, shopId },
    select: { status: true, guardrails: true },
  });
  if (!campaign) throw new AppError({ code: "NOT_FOUND", userMessage: "That campaign no longer exists. Reload the page." });

  const state = campaign.status as CampaignState;
  if (state === "APPLYING" || state === "REVERTING") {
    return {
      ok: false,
      message: `This campaign is ${describeState(state).label.toLowerCase()}. Change its floors once that has finished. Nothing was changed.`,
    };
  }

  const previous = campaignGuardrailsOf(campaign.guardrails);
  const read = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : null;
  };
  // A value that cannot be saved is said in the page's banner, naming the field, as the
  // schedule's are: thrown, it would take the page to its error screen over a typo.
  const save = await floorsToSave(shopId, read, previous, actor, "Nothing was changed.").catch((error: unknown) => {
    if (error instanceof AppError && error.code === "VALIDATION") return { ok: false as const, problem: error.userMessage };
    throw error;
  });
  if ("problem" in save) return { ok: false, message: save.problem };
  if (!save.ok) return { ok: false, tone: "warning", message: save.ask, loosen: save.ask };

  // A campaign that has started keeps the policy it started with until it ends (D21), its own
  // choice included: the card does not offer it, and a post that names one changes nothing.
  const started = pricesMayBeLive(state);
  const policy = started ? previous.violationPolicy : save.guardrails.violationPolicy;
  const guardrails: CampaignGuardrails = { ...save.guardrails };
  delete guardrails.violationPolicy;
  if (policy) guardrails.violationPolicy = policy;

  // Conditional on the state that was read, so a run claiming it in between is not overtaken:
  // its plan was made with the floors it found.
  const updated = await prisma.campaign.updateMany({
    where: { id: campaignId, shopId, status: state },
    data: {
      guardrails: guardrails as never,
      // Before it starts the column is only a record, written again as it starts (#789); kept
      // in step so it reads as this campaign's choice, or the store's as it is now.
      ...(started ? {} : { guardrailViolationPolicy: policy ?? (await readSettings(shopId)).violationPolicy }),
    },
  });
  if (updated.count === 0) {
    return { ok: false, message: "This campaign changed while you were editing it. Reload the page and try again. Nothing was changed." };
  }

  await prisma.auditLogEntry.create({
    data: {
      shopId,
      actor,
      action: "campaign.floors.update",
      entity: "Campaign",
      entityId: campaignId,
      before: floorsAudit(previous) as never,
      after: floorsAudit(guardrails) as never,
    },
  });
  await recordLoosening(shopId, campaignId, actor, { ...save, guardrails });

  return {
    ok: true,
    message: started
      ? "Floors saved. Prices already on your storefront stay as they are until this campaign is applied again."
      : "Floors saved. The preview is worked out again with them.",
  };
}

/** For a page: which floors apply to this campaign, whose they are, and what its fields show. */
export async function floorsOf(
  shopId: string,
  campaign: { guardrails: unknown },
  timeZone: string,
) {
  const [store, currency] = await Promise.all([guardrailsFor(shopId), shopCurrency(shopId)]);
  const stored = campaignGuardrailsOf(campaign.guardrails);
  return {
    ...floorsView(stored, store, currency, timeZone),
    fields: floorFieldsOf(stored, store, currency),
    store: describeFloors(store),
    currency,
  };
}
