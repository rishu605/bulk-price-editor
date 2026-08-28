import { humanise } from "../../lib/format/label";
import { ActionRow } from "../ActionRow";
import { FilterForm } from "../FilterForm";
import type { listCampaigns, CampaignFilters } from "../../services/campaigns/list.server";

type List = Awaited<ReturnType<typeof listCampaigns>>;

/** Filters offered as chips. "Needs a decision" is not a status — it spans several. */
const STATUS_CHIPS = [
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
  return (
    <s-section>
      {/* FilterForm rather than a native form element: a plain GET submit replaces the
          whole query string, including the `host` and `id_token` App Bridge put there,
          and the merchant gets a blank page with nothing in the console. It also merges
          rather than replaces, so the view and status already in the URL survive a
          search. */}
      <FilterForm fields={["q"]}>
        <s-stack direction="inline" gap="base">
          <s-search-field
            name="q"
            label="Search campaigns"
            value={filters.q}
            placeholder="Search by name"
          />
          <s-button type="submit">Search</s-button>
        </s-stack>
      </FilterForm>

      <s-stack direction="inline" gap="small-200">
        {STATUS_CHIPS.map((chip) =>
          chip.value === filters.status ? (
            <s-badge key={chip.value || "all"} tone="info">
              {chip.label}
            </s-badge>
          ) : (
            <s-button
              key={chip.value || "all"}
              variant="tertiary"
              href={linkTo({ status: chip.value })}
            >
              {chip.label}
            </s-button>
          ),
        )}
      </s-stack>

      {list.campaigns.length === 0 ? (
        <s-paragraph>
          {filters.q || filters.status ? (
            <s-text>
              No campaigns match that. Clear the filters to see all{" "}
              {list.attentionCount > 0 ? "campaigns, including the ones needing a decision" : "campaigns"}.
            </s-text>
          ) : (
            <s-text>
              No campaigns yet. A campaign is a rule (&ldquo;20% off this
              collection&rdquo;) plus the set of variants it applies to. Nothing is
              written to your storefront until you apply it, and you can preview the
              exact result first.
            </s-text>
          )}
        </s-paragraph>
      ) : (
        <>
          <s-table>
            <s-table-header-row>
              <s-table-header>Campaign</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Priority</s-table-header>
              <s-table-header>Last run</s-table-header>
              <s-table-header></s-table-header>
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
    </s-section>
  );
}
