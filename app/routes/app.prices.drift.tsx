import type { ComponentProps } from "react";
import { Blank } from "../components/Blank";
import { useRef } from "react";
import type {
  ActionFunctionArgs,
  FetcherWithComponents,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import {
  pendingDrift,
  resolveDrift,
  type DriftResolution,
  type DriftRow,
} from "../services/drift.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { withGuard } from "../lib/errors/guard.server";
import { PageShell } from "../components/PageShell";
import { EmptyState } from "../components/AsyncState";
import { ActionRow } from "../components/ActionRow";
import { ShowingSome } from "../components/Pagination";
import { HelpNote } from "../components/HelpNote";
import prisma from "../db.server";

export const loader = withGuard("/app/prices/drift", async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  // The count as well as the page: a queue that shows fifteen of forty and says nothing
  // reads as forty resolved decisions when it is fifteen.
  const [events, pending] = await Promise.all([
    pendingDrift(shop.id),
    prisma.driftEvent.count({ where: { shopId: shop.id, resolution: "PENDING" } }),
  ]);

  return { events, pending };
});

export const action = withGuard("/app/prices/drift", async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);

  const form = await request.formData();
  const eventId = String(form.get("eventId"));
  const resolution = String(form.get("resolution")) as DriftResolution;

  await resolveDrift(shop.id, eventId, resolution, session.shop);

  const wording: Record<DriftResolution, string> = {
    adopt: "Adopted as the new baseline. Future campaigns compute from this price.",
    reassert: "Marked for reassertion. The campaign will rewrite this price on its next run.",
    ignore: "Ignored. The price stays as the merchant left it.",
  };

  return { ok: true, message: wording[resolution] };
});

type ActionData = { ok: boolean; message: string };

export default function DriftQueue() {
  const { events, pending } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  return (
    <PageShell heading="Price drift">
      {fetcher.data ? (
        <s-banner tone="success">
          <s-paragraph>{fetcher.data.message}</s-paragraph>
        </s-banner>
      ) : null}

      <s-section>
        {events.length === 0 ? (
          // Not a NoMatches: this page has no filters, and it is the one empty state in
          // the app that is good news. It says so, rather than reading as a page that
          // failed to load.
          <EmptyState
            title="No drift detected"
            description="Every price your campaigns set is still what they set. If somebody edits one in the Shopify admin while a campaign is running, it is held here for your decision rather than overwritten."
          />
        ) : (
          <>
            <s-paragraph>
              These prices changed outside Anchor while a campaign was running. Someone
              did that deliberately, so nothing has been overwritten — choose what
              should happen to each.
            </s-paragraph>

            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Variant</s-table-header>
                <s-table-header listSlot="labeled" format="currency">Campaign set</s-table-header>
                <s-table-header listSlot="labeled" format="currency">Now shows</s-table-header>
                <s-table-header listSlot="secondary">Campaign</s-table-header>
                <s-table-header listSlot="inline">Resolve</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {events.map((event) => (
                  <DriftDecision key={event.id} event={event} fetcher={fetcher} busy={busy} />
                ))}
              </s-table-body>
            </s-table>

            <ShowingSome
              shown={events.length}
              total={pending}
              noun="drifted prices"
              suffix="Resolve these and the next appear."
            />
          </>
        )}
      </s-section>

      <HelpNote label="What the three choices do">
        <s-paragraph>
          <strong>Keep the change</strong> — make the new price the baseline. For a
          permanent repricing.
        </s-paragraph>
        <s-paragraph>
          <strong>Put it back</strong> — rewrite the campaign price on the next run. For a
          mistake.
        </s-paragraph>
        <s-paragraph>
          <strong>Leave it for now</strong> — close the alert, change nothing.
        </s-paragraph>
        <s-paragraph>
          <s-text color="subdued">
            Only the first changes what future campaigns compute from, which is why it is
            the one marked consequential.
          </s-text>
        </s-paragraph>
      </HelpNote>
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

/**
 * The three decisions, in the words the help centre already uses for them.
 *
 * They were rendered straight out of the enum — `adopt` `reassert` `ignore`, lower case,
 * on the page whose entire job is a considered choice about somebody's storefront.
 * `docs/help/concepts/drift.md` has had merchant wording for two of them since before
 * this page existed; the page and the documentation of the page had never been read next
 * to each other.
 *
 * `tone` is doing real work in the third field rather than decorating. The aside says
 * only one of the three changes what future campaigns compute from, and until now the
 * page rendered all three identically while the panel beside it explained that one of
 * them was different. It is the same treatment Revert carries on a campaign, which is
 * also less destruction than a decision worth being sure about.
 */
const RESOLUTIONS = [
  { value: "adopt", label: "Keep the change", tone: "critical" },
  { value: "reassert", label: "Put it back", tone: "auto" },
  { value: "ignore", label: "Leave it for now", tone: "auto" },
] as const satisfies readonly {
  value: DriftResolution;
  label: string;
  tone: ComponentProps<"s-button">["tone"];
}[];

/**
 * One drifted price, and the choice about it.
 *
 * Named for the decision rather than the row, so it does not collide with the
 * `DriftRow` the service returns — one is what we know, the other is what to do.
 *
 * Its own component so that the row can own a ref. `s-button` takes no `name` or `value`,
 * so the app's pattern for a form with several submits is a hidden field the buttons set
 * before submitting — which needs a ref, and a ref created inside a `.map()` is a new ref
 * on every render.
 *
 * Worth the component rather than the three separate `fetcher.Form`s it replaces. Three
 * forms in one cell is three elements laying themselves out independently, and they
 * carried `gap="small"` — which the spacing scale documents as *larger* than `small-100`,
 * so the three halves of one decision sat further apart than the parts of any other row
 * in the app.
 */
function DriftDecision({
  event,
  fetcher,
  busy,
}: {
  event: DriftRow;
  fetcher: FetcherWithComponents<ActionData>;
  busy: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  const resolution = useRef<HTMLInputElement>(null);

  const resolve = (value: DriftResolution) => {
    if (resolution.current) resolution.current.value = value;
    form.current?.requestSubmit();
  };

  return (
    <s-table-row>
      <s-table-cell>{event.title}</s-table-cell>
      <s-table-cell>{event.expected ?? <Blank />}</s-table-cell>
      {/* Was a warning badge wrapped round the price. A badge is a status and a price is
          a value, so the column could not align with the one beside it and the number a
          merchant came here to compare rendered as a label. Every row on this page is
          drift; the page says so once, at the top, rather than once per row. */}
      <s-table-cell>{event.observed ?? <Blank />}</s-table-cell>
      <s-table-cell>{event.campaignName ?? <Blank />}</s-table-cell>
      <s-table-cell>
        <fetcher.Form method="post" ref={form}>
          <input type="hidden" name="eventId" value={event.id} />
          {/* Defaults to the choice that changes nothing. A missing or unrecognised
              intent should fall safe, the way the imports' dry run does. */}
          <input type="hidden" name="resolution" ref={resolution} value="ignore" readOnly />
          <ActionRow>
            {RESOLUTIONS.map((choice) => (
              <s-button
                key={choice.value}
                type="button"
                tone={choice.tone}
                loading={busy || undefined}
                onClick={() => resolve(choice.value)}
              >
                {choice.label}
              </s-button>
            ))}
          </ActionRow>
        </fetcher.Form>
      </s-table-cell>
    </s-table-row>
  );
}
