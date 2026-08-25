/**
 * What changed about a shop's markets since we last looked.
 *
 * Markets, catalogues and price lists are edited while campaigns are running (edge case
 * E15). A merchant adds a market on Tuesday and expects Tuesday's sale to reach it; they
 * delete one on Wednesday and a campaign that was writing prices there has nowhere to
 * write them. Neither is an error, and neither should surface as a run that failed
 * halfway with a Shopify error code about a missing price list.
 *
 * So the topology is diffed rather than merely overwritten, and each change is
 * classified by what it means for the campaigns that target it. The classification is
 * pure and lives here because deciding "this needs the merchant" is a judgement worth
 * testing without a database and without Shopify.
 *
 * A currency change deserves particular suspicion. Shopify allows it, and it silently
 * reinterprets every fixed price on the list: 2000 minor units was €20.00 and is now
 * ¥2,000. Nothing we hold is wrong afterwards, exactly — it just means something else.
 */

export interface MarketSnapshot {
  priceListGid: string;
  name: string;
  currency: string;
  adjustmentBps: number | null;
  surfaceKind: "MARKET" | "B2B";
}

export type TopologyChangeKind =
  | "added"
  | "removed"
  | "currency-changed"
  | "adjustment-changed"
  | "renamed";

export interface TopologyChange {
  kind: TopologyChangeKind;
  priceListGid: string;
  name: string;
  before?: Partial<MarketSnapshot>;
  after?: Partial<MarketSnapshot>;
}

/**
 * Diffs two topologies.
 *
 * Ordered so the destructive news comes first: a merchant reading a list of changes
 * needs "this market is gone" above "this market was renamed".
 */
export function diffTopology(
  before: readonly MarketSnapshot[],
  after: readonly MarketSnapshot[],
): TopologyChange[] {
  const previous = new Map(before.map((list) => [list.priceListGid, list]));
  const current = new Map(after.map((list) => [list.priceListGid, list]));

  const removed: TopologyChange[] = [];
  const currency: TopologyChange[] = [];
  const added: TopologyChange[] = [];
  const rest: TopologyChange[] = [];

  for (const [gid, was] of previous) {
    const now = current.get(gid);

    if (!now) {
      removed.push({ kind: "removed", priceListGid: gid, name: was.name, before: was });
      continue;
    }

    if (was.currency !== now.currency) {
      // First, and separately from the rename that usually accompanies it. This one
      // reinterprets every price already on the list rather than changing any of them.
      currency.push({
        kind: "currency-changed",
        priceListGid: gid,
        name: now.name,
        before: { currency: was.currency },
        after: { currency: now.currency },
      });
    }

    if (was.adjustmentBps !== now.adjustmentBps) {
      rest.push({
        kind: "adjustment-changed",
        priceListGid: gid,
        name: now.name,
        before: { adjustmentBps: was.adjustmentBps },
        after: { adjustmentBps: now.adjustmentBps },
      });
    }

    if (was.name !== now.name) {
      rest.push({
        kind: "renamed",
        priceListGid: gid,
        name: now.name,
        before: { name: was.name },
        after: { name: now.name },
      });
    }
  }

  for (const [gid, now] of current) {
    if (!previous.has(gid)) {
      added.push({ kind: "added", priceListGid: gid, name: now.name, after: now });
    }
  }

  return [...removed, ...currency, ...added, ...rest];
}

/**
 * Whether a change needs the merchant to decide something.
 *
 * The bar is "a campaign will now do something different from what the merchant
 * approved". A rename does not meet it. A market disappearing from under a running
 * campaign does, and so does a currency change, because every fixed price on that list
 * now means a different amount of money.
 *
 * A new market needs a decision too, but a gentler one: an existing campaign was
 * approved against the markets that existed when it was approved, so extending it is an
 * offer rather than something to do automatically. Auto-enrolling products into a
 * campaign is safe because the rule is what the merchant chose; auto-enrolling a whole
 * new market is a decision about which countries see a sale.
 */
export function needsDecision(change: TopologyChange): boolean {
  return change.kind !== "renamed" && change.kind !== "adjustment-changed";
}

/** What to tell the merchant, naming the market, the cause and what to do next. */
export function describeChange(change: TopologyChange, campaignNames: readonly string[]): string {
  const used =
    campaignNames.length === 0
      ? ""
      : ` It is targeted by ${campaignNames.slice(0, 3).join(", ")}${
          campaignNames.length > 3 ? ` and ${campaignNames.length - 3} more` : ""
        }.`;

  switch (change.kind) {
    case "removed":
      return (
        `The market "${change.name}" no longer exists in Shopify.${used} ` +
        `Prices already written there are gone with it; campaigns will skip it from now on ` +
        `unless you remove it from them.`
      );

    case "currency-changed":
      return (
        `The market "${change.name}" changed currency from ${change.before?.currency} to ` +
        `${change.after?.currency}.${used} Every price on it now means a different amount, ` +
        `so recheck it before the next run.`
      );

    case "added":
      return (
        `A new market, "${change.name}" (${change.after?.currency}), appeared in Shopify. ` +
        `No campaign prices it yet — add it to one if this sale should reach it.`
      );

    case "adjustment-changed":
      return (
        `The market "${change.name}" changed its standing percentage. Campaigns compute ` +
        `from this market's own prices, so the next run will follow the new one.`
      );

    case "renamed":
      return `The market "${change.before?.name}" is now called "${change.after?.name}".`;
  }
}
