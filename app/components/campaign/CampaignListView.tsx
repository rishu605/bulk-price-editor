import { humanise } from "../../lib/format/label";
import { ActionRow } from "../ActionRow";
import { FilterForm } from "../FilterForm";
import { TabBar } from "../TabBar";
import { PAD, SPACE } from "../../lib/ui/spacing";
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
}: {
  list: List;
  filters: CampaignFilters;
  linkTo: (next: Record<string, string>) => string;
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

        {list.campaigns.length === 0 ? (
          <EmptyState filtered={filtered} clearHref={linkTo({ q: "", status: "" })} />
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
                    <s-table-cell>{campaign.name}</s-table-cell>
                    <s-table-cell>
                      <s-badge tone={campaign.lifecycle.tone}>
                        {campaign.lifecycle.label}
                      </s-badge>
                    </s-table-cell>
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
                      <s-button variant="tertiary" href={`/app/campaigns/${campaign.id}`}>
                        Open
                      </s-button>
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

/**
 * What the card says instead of rows.
 *
 * Two different situations, and conflating them is the usual mistake: a shop with no
 * campaigns needs to be told what a campaign *is*, and a shop whose filter matched
 * nothing needs the filter taken off. The second used to be a sentence saying "clear the
 * filters" with no way to do it.
 *
 * Laid out as an empty state rather than a loose paragraph — a title, a measure short
 * enough to read, and vertical room. A single line of body text flush against the control
 * above it reads as a caption on that control, not as the answer to "where are my rows".
 */
function EmptyState({ filtered, clearHref }: { filtered: boolean; clearHref: string }) {
  return (
    <s-box paddingBlock={PAD.block}>
      <s-stack direction="block" gap={SPACE.section}>
        <s-heading>{filtered ? "No campaigns match those filters" : "No campaigns yet"}</s-heading>

        {/* Capped rather than running the width of the card. Body copy set across a wide
            column is measurably harder to read, and this is the one block on the page
            that is nothing but body copy. */}
        <s-box maxInlineSize="520px">
          <s-paragraph>
            {filtered ? (
              <s-text>
                Nothing here matches the status and search you have set. Clearing them
                shows every campaign in the shop.
              </s-text>
            ) : (
              <s-text>
                A campaign is a rule (&ldquo;20% off this collection&rdquo;) plus the set
                of variants it applies to. Nothing is written to your storefront until you
                apply it, and you can preview the exact result first.
              </s-text>
            )}
          </s-paragraph>
        </s-box>

        {filtered ? (
          <ActionRow>
            {/* Secondary, not primary. The page's primary action is Create campaign, at
                the top of the page and still visible from here; a second black button
                would be two answers to "what should I do next". */}
            <s-button href={clearHref}>Clear filters</s-button>
          </ActionRow>
        ) : null}
      </s-stack>
    </s-box>
  );
}
