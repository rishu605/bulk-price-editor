/**
 * The Reason column for a clamped row, by what raised it (#792).
 *
 * Shared because two places write it: a run recording its results, and a bulk run when
 * Shopify accepts its operation (#832). The second is the only record a later run has
 * that a row it settles from the result file was clamped rather than priced by the rule.
 */
export const CLAMP_REASONS: ReadonlyArray<[string, string]> = [
  ["below-floor", "Raised to your guardrail floor: the rule would have priced it below it."],
  ["non-positive-price", "Raised to the smallest price: the rule would have priced it at zero or below."],
];

const CLAMP_TEXTS = new Set(CLAMP_REASONS.map(([, text]) => text));

/** Whether a ledger row's reason says the price was clamped. */
export function isClampReason(text: string | null | undefined): boolean {
  return text !== null && text !== undefined && CLAMP_TEXTS.has(text);
}
