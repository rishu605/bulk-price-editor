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

/**
 * The space between an amount and the word that gives it meaning.
 *
 * Non-breaking, because "25% off" is one phrase and there is no reading of it in which
 * breaking after the number helps. `s-table` has no `table-layout: fixed` and no width
 * control on a column, so the browser distributes the width and wraps whichever column
 * has the most give — and a four-letter header over a two-word value is always the one
 * with the most give. On the campaigns index the Rule column was rendering
 *
 *     25%
 *     off
 *
 * beside a scope that had taken half the table. Binding the pair is the only lever there
 * is, and it is also just correct: it says the two words are one unit, which is the same
 * reason a typesetter would do it.
 *
 * Only on the short pairs. "Set to €9.99" and "Prices from a file" are sentences, and a
 * sentence that cannot break is a column that cannot shrink.
 */
const NB = "\u00a0";

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
        ? `${strip(-rule.percent)}%${NB}off`
        : `${strip(rule.percent)}%${NB}increase`;

    case "fixed-change":
      if (rule.amount.amount === 0) return "No change";
      return rule.amount.amount < 0
        ? `${format({ ...rule.amount, amount: -rule.amount.amount })}${NB}off`
        : `${format(rule.amount)}${NB}more`;

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

  const groups = (ast?.groups ?? []).filter((group) => (group.conditions ?? []).length > 0);
  if (groups.length === 0) return "All variants";

  const conditions = groups.flatMap((group) => group.conditions);

  const pinned = conditions.find((condition) => condition.field === "variantGid");
  if (pinned) {
    const count = Array.isArray(pinned.value) ? pinned.value.length : 1;
    return `${count} chosen ${count === 1 ? "variant" : "variants"}`;
  }

  /*
   * One group per value, all on the same field, is an OR over values — and it is by far
   * the commonest scope anyone builds: "these five product types".
   *
   * Written out condition by condition it came to
   * "productType: Backpack · productType: Boots · productType: Gloves · productType:
   * Goggles · productType: Helmet", which is wrong twice over. `·` is this function's
   * spelling of AND, and no product is five types at once, so the sentence describes a
   * scope that matches nothing while the campaign it labels matched 62,535 variants.
   * And at a hundred-odd characters it was the widest cell in the campaigns table, which
   * on `s-table`'s auto layout squeezed every other column — "25% off" was wrapping onto
   * two lines to make room for a field name repeated five times.
   *
   * Listing the values once says what it means and is less than half as long.
   */
  const field = conditions[0].field;
  const oneEach =
    groups.length > 1 &&
    groups.every((group) => group.conditions.length === 1) &&
    conditions.every((condition) => condition.field === field);

  if (oneEach && field in PREFIX) {
    const values = conditions.map((condition) => String(condition.value));
    return `${PREFIX[field]} ${listOut(values)}`;
  }

  // Otherwise, the structure as it actually is: AND within a group, OR between them.
  // Flattening the two into one `·` run was what hid the case above.
  return groups
    .map((group) => group.conditions.map(describeCondition).join(" · "))
    .join(" or ");
}

/**
 * Fields whose phrase is a prefix and a value, so several values can be listed after one
 * prefix.
 *
 * `title`, `sku` and `barcode` are deliberately absent: they read as
 * `Title contains “parka”`, and a bare list appended to a quoted phrase
 * — `Title contains “parka”, boots or gloves` — reads as though only the first is quoted.
 * They fall through to the OR join below, which is longer and correct.
 */
const PREFIX: Record<string, string> = {
  collection: "In",
  tag: "Tagged",
  vendor: "By",
  productType: "Type",
  status: "Status",
};

/** "a", "a or b", "a, b or c" — the last two joined by a word rather than a comma. */
function listOut(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

function describeCondition(condition: { field: string; value: unknown }): string {
  const value = String(condition.value);

  switch (condition.field) {
    case "excludeTag":
      // Said as an exception rather than as another condition, because that is what it
      // is: "In Outerwear · except tagged no-sale" is a sentence a merchant can check
      // against what they meant.
      return `except tagged ${value}`;
    case "title":
      return `Title contains “${value}”`;
    case "sku":
      return `SKU contains “${value}”`;
    case "barcode":
      return `Barcode contains “${value}”`;
    default:
      // A field nobody anticipated still gets a readable phrase rather than nothing —
      // the same argument `describeAction` makes about not being a lookup table.
      return condition.field in PREFIX
        ? `${PREFIX[condition.field]} ${value}`
        : `${condition.field}: ${value}`;
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
