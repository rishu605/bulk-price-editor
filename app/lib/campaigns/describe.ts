import { format } from "../money/format";
import type { AdjustmentRule } from "../pricing/types";
import type { FilterAst } from "../../services/segments.server";

/**
 * What a campaign does and what it does it to, in words.
 *
 * The campaigns index listed a name, a status, a priority and a last run — everything
 * *about* a campaign and nothing about what it is. Both competitors that have a usable
 * list solved this: Sami renders an `Editing rules` column reading "Price decrease by
 * 10%" beside an `Applies to` column reading "All products", and NA writes the whole row
 * as a sentence — "20% off sale on 1 product variant". Either way the index answers "what
 * is this" without opening anything, and ours did not.
 *
 * One formatter, not one per surface. The index, the apply confirmation and the campaign
 * header all want this sentence, and three copies of it is three chances to describe the
 * same rule three ways — which is exactly what happened to the drift page's buttons
 * before #400. `describe.test.ts` checks the callers go through here.
 */

/** The rule, as a merchant would say it. */
export function describeRule(rule: AdjustmentRule | null | undefined): string {
  if (!rule) return "No rule";

  switch (rule.kind) {
    case "percent-change":
      // The sign is the whole meaning, and "-20%" is a worse way to say "20% off": a
      // merchant scanning a column reads the words, and a minus sign is one character
      // wide. Zero is neither, and saying "0% off" would imply a sale that is not one.
      if (rule.percent === 0) return "No change";
      return rule.percent < 0
        ? `${strip(-rule.percent)}% off`
        : `${strip(rule.percent)}% increase`;

    case "fixed-change":
      if (rule.amount.amount === 0) return "No change";
      return rule.amount.amount < 0
        ? `${format({ ...rule.amount, amount: -rule.amount.amount })} off`
        : `${format(rule.amount)} more`;

    case "set-exact":
      return `Set to ${format(rule.amount)}`;

    case "from-import":
      // Deliberately not the file's name: a campaign priced from a spreadsheet has one
      // rule per variant, and there is no single sentence for it. Saying where the
      // prices came from is the honest summary.
      return "Prices from a file";

    default:
      return "No rule";
  }
}

/** Trailing zeros off a percentage: "12.50%" reads as more precision than was meant. */
function strip(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : String(Number(percent.toFixed(2)));
}

/**
 * What the campaign applies to.
 *
 * A segment wins outright, because a segment *replaces* the inline filter rather than
 * narrowing it — saying "Outerwear · tagged sale" for a campaign scoped by a saved
 * segment would describe a filter the campaign is ignoring.
 *
 * An empty filter is the whole catalogue, and it is worth saying so in as many words: it
 * is the scope with the largest consequence and the least visible cause.
 */
export function describeScope(ast: FilterAst | null | undefined, segmentName?: string | null): string {
  if (segmentName) return segmentName;

  const conditions = (ast?.groups ?? []).flatMap((group) => group.conditions);
  if (conditions.length === 0) return "All variants";

  const pinned = conditions.find((condition) => condition.field === "variantGid");
  if (pinned) {
    const count = Array.isArray(pinned.value) ? pinned.value.length : 1;
    return `${count} chosen ${count === 1 ? "variant" : "variants"}`;
  }

  return conditions.map(describeCondition).join(" · ");
}

function describeCondition(condition: { field: string; value: unknown }): string {
  const value = String(condition.value);

  switch (condition.field) {
    case "collection":
      return `In ${value}`;
    case "tag":
      return `Tagged ${value}`;
    case "vendor":
      return `By ${value}`;
    case "title":
      return `Title contains “${value}”`;
    default:
      // A field nobody anticipated still gets a readable phrase rather than nothing —
      // the same argument `describeAction` makes about not being a lookup table.
      return `${condition.field}: ${value}`;
  }
}

/**
 * Both sentences at once, because nothing ever wants one without the other.
 *
 * The index and the campaign page each need "what does it do" and "what to", and calling
 * two functions with two different argument shapes at both call sites is two chances to
 * pass the segment name to one and forget it for the other.
 */
export function describeCampaign(campaign: {
  rule: AdjustmentRule | null | undefined;
  ast: FilterAst | null | undefined;
  segmentName?: string | null;
}): { rule: string; scope: string } {
  return {
    rule: describeRule(campaign.rule),
    scope: describeScope(campaign.ast, campaign.segmentName),
  };
}
