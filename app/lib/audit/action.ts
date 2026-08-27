/**
 * What happened, in words a merchant recognises.
 *
 * Audit actions are written as namespaced machine strings — `market.added`,
 * `drift.accepted`, `settings.guardrails.update` — and several are built at the call site
 * from a variable (`market.${change.kind}`), so there is no closed list of them anywhere
 * and any lookup table here would go stale silently the first time somebody adds a kind.
 *
 * So this is a transformation, not a mapping: it cannot be missing an entry. Dots,
 * hyphens and underscores are word breaks, and the first word is capitalised. That turns
 * every action the app writes today into a readable phrase, and every action it writes
 * tomorrow into a readable phrase without anybody remembering to come back here.
 *
 * The trade is that the phrasing is mechanical rather than composed — "Campaign
 * transition" rather than "Campaign status changed". Worth it: a plausible sentence for
 * an action nobody anticipated beats a polished one for six actions and a raw
 * `mirror.divergence_rate` for the seventh.
 */
export function describeAction(action: string): string {
  const words = action.split(/[.\-_]+/).filter(Boolean).join(" ");
  if (words.length === 0) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The icon for an action's subject.
 *
 * Keyed on the namespace — everything before the first dot — because that is the part
 * that names *what* the entry is about, and it is the stable half of the string. A
 * namespace with no icon gets a neutral one rather than nothing: an activity list where
 * some rows have a leading glyph and others have a hole is worse than one with no icons
 * at all, because the hole reads as a failure to load.
 */
// No return annotation, deliberately: the inferred union of literals is what makes these
// assignable to Polaris' `IconType`, and a typo becomes a build error at the call site.
// Annotating `string` here would push the mistake to runtime, where a bad name renders
// nothing at all.
export function iconForAction(action: string) {
  const subject = action.split(".")[0];
  switch (subject) {
    case "market":
      return "markets";
    case "campaign":
      return "megaphone";
    case "drift":
      return "alert-triangle";
    case "baselines":
      return "price-list";
    case "cost":
      return "product-cost";
    case "settings":
      return "settings";
    case "billing":
      return "credit-card";
    case "notification":
      return "notification";
    case "approval":
      return "shield-pending";
    case "mirror":
      return "globe";
    default:
      return "note";
  }
}
