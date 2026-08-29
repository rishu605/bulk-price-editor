import type { useFetcher } from "react-router";

import { humanise } from "../../lib/format/label";
import { ActionRow } from "../ActionRow";
import { EmptyState, NoMatches } from "../AsyncState";
import { FilterForm } from "../FilterForm";
import { TabBar } from "../TabBar";
import { SPACE } from "../../lib/ui/spacing";
import type { listCampaigns, CampaignFilters } from "../../services/campaigns/list.server";

type List = Awaited<ReturnType<typeof listCampaigns>>;

/** The status filters. "Needs a decision" is not a status — it spans several. */
const STATUSES = [
  { value: "", label: "All" },
  { value: "attention", label: "Needs a decision" },
  { value: "DRAFT", label: "Draft" },
  { value: "SCHEDULED", label: "Scheduled" },
  { value: "ACTIVE", label: "Active" },
  { value: "COMPLETED", label: "Completed" },
];

/**
 * The campaigns list.
 *
 * Gains what an index needs and had none of: search, status filters, and paging. The
 * page previously loaded every campaign a shop had ever created, unpaged — fine at
 * twelve, not at a few hundred, and the row that needs a decision is the one that gets
 * lost first.
 *
 * ## The order of the controls
 *
 * Status, then search, then rows. The status tabs choose a set; the search narrows the set
 * that was chosen. Written the other way round — as it was — the search box sits above the
 * thing that decides what it is searching, and reads as searching all campaigns.
 *
 * They are laid out on the card's section rhythm, so the two controls and the table are
 * three separately readable blocks rather than one run of stuff. The previous version set
 * no rhythm at all and let the filters land directly under the Search button, close enough
 * to read as part of it.
 *
 * ## Why the statuses are a tab bar and not a row of pills
 *
 * They were a row of pills for one iteration, on the reasoning that two tab bars on one
 * page — list-versus-calendar above, all-versus-draft here — would be two identical
 * controls answering different questions. Rendered, that was the smaller problem: six
 * bordered pills do not fit the column beside the aside, so "Completed" wrapped onto a
 * line of its own, and a filled pill next to an outlined one is a weak enough "selected"
 * signal that the row read as six buttons rather than one choice.
 *
 * Tabs are text and an underline. They fit, and the underline is unambiguous. The two bars
 * are told apart by where they are — one above the card on the page's grey, one inside the
 * card — and by the glyphs the view switcher carries, which is how the admin's own index
 * pages do it.
 */
export function CampaignListView({
  list,
  filters,
  linkTo,
  fetcher,
}: {
  list: List;
  filters: CampaignFilters;
  linkTo: (next: Record<string, string>) => string;
  /**
   * The route's fetcher, for the one control here that writes.
   *
   * Handed down rather than reached for, the same way the campaign page's sections take
   * theirs. A component that calls `useFetcher` itself cannot be rendered outside a data
   * router, which is how every one of these is tested — and the hook would tie a
   * presentational component to the route that happens to own it today.
   */
  fetcher: Pick<ReturnType<typeof useFetcher>, "Form">;
}) {
  const filtered = Boolean(filters.q || filters.status);

  return (
    <s-section>
      <s-stack direction="block" gap={SPACE.section}>
        <TabBar
          label="Campaigns by status"
          tabs={STATUSES.map((status) => ({
            label: status.label,
            href: linkTo({ status: status.value }),
            current: status.value === filters.status,
            // The one count worth carrying on a filter: it is the reason to press it, and
            // it is counted across the shop rather than the filtered page, so an unrelated
            // filter cannot hide a campaign that needs a decision.
            badge: status.value === "attention" ? list.attentionCount : undefined,
          }))}
        />

        {/* FilterForm rather than a native form element: a plain GET submit replaces the
            whole query string, including the `host` and `id_token` App Bridge put there,
            and the merchant gets a blank page with nothing in the console. It also merges
            rather than replaces, so the view and status already in the URL survive a
            search. */}
        <FilterForm fields={["q"]}>
          {/* A grid, not an inline stack. The stack put the button *after* a field that
              takes the full width, so it wrapped onto its own line and sat under the
              field's left edge looking like an orphan. Here the field takes what is left
              and the button takes what it needs, on one baseline. */}
          <s-grid gridTemplateColumns="1fr auto" gap={SPACE.item} alignItems="center">
            <s-search-field
              name="q"
              label="Search campaigns"
              // The label is the placeholder's job here. Rendered above the field it
              // pushed the field down relative to the button beside it, and a labelled
              // box that already says "Search by name" inside it says it twice.
              labelAccessibilityVisibility="exclusive"
              value={filters.q}
              placeholder="Search campaigns by name"
            />
            <s-button type="submit" icon="search">
              Search
            </s-button>
          </s-grid>
        </FilterForm>

        {/* Not a seventh status tab. Archiving is a filing decision and the tabs are the
            lifecycle; folding them together would mean giving up the status filter to
            look in the archive, and "archived" would have to claim to be a state a
            campaign can be in. A merchant looking for an archived campaign is usually
            looking for a finished one, so both controls have to work at once. */}
        <ActionRow>
          <s-button
            variant="tertiary"
            icon="archive"
            href={linkTo({ archived: filters.archived ? "" : "1" })}
          >
            {filters.archived ? "Show active campaigns" : "Show archived"}
          </s-button>
        </ActionRow>

        {list.campaigns.length === 0 ? (
          filters.archived ? (
            <EmptyState
              title="Nothing archived"
              description="Archiving takes a campaign out of this list and leaves everything else alone — its runs, its ledger and any prices it has live. Nothing here is ever deleted."
            />
          ) : filtered ? (
            <NoMatches
              noun="campaigns"
              description="Nothing here matches the status and search you have set. Clearing them shows every campaign in the shop."
              clearHref={linkTo({ q: "", status: "", archived: "" })}
            />
          ) : (
            <EmptyState
              title="No campaigns yet"
              description="A campaign is a rule (“20% off this collection”) plus the set of variants it applies to. Nothing is written to your storefront until you apply it, and you can preview the exact result first."
            />
          )
        ) : (
          <>
            {/* Every header says what it becomes when the table collapses to a list.
                `s-table` chooses between a grid and stacked key-value pairs itself —
                `variant` on App Home only offers `auto` and `list`, so there is no way to
                pin the grid — and at this column's width the two are close enough that the
                same page renders both ways on consecutive reloads.

                That is Polaris' call to make. What was ours is that the collapsed form was
                unreadable: every column defaults to `labeled`, so three campaigns became
                fifteen "Priority 900" rows and the name had no more weight than the
                priority. Designating them makes the stacked form a real list row — the
                name is the row, the status badge sits with it, and Open stays on the same
                line — so whichever way it lands, it looks like a decision. */}
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Campaign</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                {/* What it does, and what to. The list said everything *about* a campaign
                    — name, status, priority, last run — and nothing about what it is.
                    Sami renders exactly these two columns; NA writes the row as a
                    sentence. Either way the index answers "what is this" without opening
                    anything.
                    
                    `inline` for the rule, because collapsed it belongs on the same line
                    as the name — "Autumn sale · 20% off" is the row. The scope is
                    `labeled`: it is longer, and a scope stacked under its own label reads
                    better than one run on after the rule. */}
                <s-table-header listSlot="inline">Rule</s-table-header>
                <s-table-header listSlot="labeled">Applies to</s-table-header>
                {/* Right-aligned in the grid, because it is a number. */}
                <s-table-header listSlot="labeled" format="numeric">
                  Priority
                </s-table-header>
                <s-table-header listSlot="labeled">Last run</s-table-header>
                <s-table-header listSlot="inline"></s-table-header>
              </s-table-header-row>
              <s-table-body>
                {list.campaigns.map((campaign) => (
                  <s-table-row key={campaign.id}>
                    <s-table-cell>
                      {campaign.name}
                      {/* Only in the archive view, where every row has it, and on a
                          campaign that turns up in a search from the active list —
                          which is the case that would otherwise be confusing, because
                          the row looks live and is not in the list. */}
                      {campaign.archived ? <s-badge tone="neutral">Archived</s-badge> : null}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={campaign.lifecycle.tone}>
                        {campaign.lifecycle.label}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{campaign.rule}</s-table-cell>
                    <s-table-cell>{campaign.scope}</s-table-cell>
                    <s-table-cell>{campaign.priority}</s-table-cell>
                    <s-table-cell>
                      {campaign.lastRun
                        ? `${humanise(campaign.lastRun.kind)} · ${humanise(campaign.lastRun.status)} · ${campaign.lastRun.verified} verified${
                            campaign.lastRun.failed > 0
                              ? `, ${campaign.lastRun.failed} failed`
                              : ""
                          }`
                        : "—"}
                    </s-table-cell>
                    <s-table-cell>
                      <ActionRow>
                        {/* Duplicate is not recurrence, which we already have. It is how
                            next month's different sale gets built out of last month's
                            sale that worked, and the row is where a merchant is when
                            they recognise the one that worked. */}
                        <fetcher.Form method="post">
                          <input type="hidden" name="intent" value="duplicate" />
                          <input type="hidden" name="campaignId" value={campaign.id} />
                          <s-button type="submit" variant="tertiary" icon="duplicate">
                            Duplicate
                          </s-button>
                        </fetcher.Form>
                        <s-button variant="tertiary" href={`/app/campaigns/${campaign.id}`}>
                          Open
                        </s-button>
                      </ActionRow>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>

            {list.pages > 1 ? (
              <ActionRow>
                {list.page > 1 ? (
                  <s-button icon="chevron-left" href={linkTo({ page: String(list.page - 1) })}>
                    Previous
                  </s-button>
                ) : null}
                {/* Tabular figures: the page number changes in place, and proportional
                    digits make the sentence around it jump every time it does. */}
                <s-text color="subdued" fontVariantNumeric="tabular-nums">
                  Page {list.page} of {list.pages} · {list.total} campaigns
                </s-text>
                {list.page < list.pages ? (
                  <s-button icon="chevron-right" href={linkTo({ page: String(list.page + 1) })}>
                    Next
                  </s-button>
                ) : null}
              </ActionRow>
            ) : null}
          </>
        )}
      </s-stack>
    </s-section>
  );
}
