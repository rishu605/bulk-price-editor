/**
 * The commonest job in the category, as one number.
 *
 * "20% off everything" is what most merchants open this app to do, and until now it cost
 * them the whole editor: a name, a rule, a scope, a compare-at policy, rounding, a
 * schedule. Sami puts it on its dashboard as one field and one button — *"just enter your
 * target price and click Quick Create"* — and it is the single best idea in their app.
 *
 * What we do not copy is where it ends. Sami's Quick Create can write prices; ours makes a
 * **draft**, which lands on the campaign page with the preview already computed. The
 * two-step shape is the safety property, and trading it for parity with an app that
 * changes every price in a catalogue on one click would be trading away the reason to
 * choose us.
 */

/** What a merchant typed, and what is wrong with it. */
export type QuickPercent =
  | { ok: true; percent: number }
  | { ok: false; message: string };

/**
 * Reading the one field.
 *
 * A discount is entered as a positive number here — "20" means 20% off — because that is
 * how a merchant says it out loud, and the field is labelled "% off". The editor's own
 * rule field takes a signed number because it also does increases; this one does not, and
 * asking for "-20" in a box labelled "% off" is a double negative.
 */
export function readQuickPercent(raw: string): QuickPercent {
  const trimmed = raw.trim().replace(/%$/, "").trim();
  if (trimmed === "") return { ok: false, message: "Enter a percentage to discount by." };

  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, message: `“${raw.trim()}” is not a number.` };
  }
  if (value <= 0) {
    return {
      ok: false,
      message: "Enter a positive number — 20 means 20% off. Use the full editor to raise prices.",
    };
  }
  if (value >= 100) {
    return {
      ok: false,
      message: "100% off would make everything free. Use the full editor if you mean that.",
    };
  }

  return { ok: true, percent: value };
}

/** The campaign's name, which a merchant can change but should never have to invent. */
export function quickCampaignName(percent: number, today: string): string {
  return `${percent}% off · ${today}`;
}
