import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";
import { toAdminClient } from "../services/admin-client.server";
import {
  campaignRuns,
  previewCampaign,
  reinstateVariant,
  revertVariant,
  rollbackReport,
  runCampaign,
  runLedger,
} from "../services/campaigns/index.server";
import { describeSchedule, parseSchedule, scheduleWarnings } from "../lib/scheduling/window";
import { RunHistoryTable } from "../components/RunHistoryTable";
import { RunResultSection } from "../components/RunResultSection";
import { campaignResult } from "../services/campaigns/result.server";
import { RouteBoundary } from "../components/RouteBoundary";
import { reportError } from "../services/error-report.server";
import { withGuard } from "../lib/errors/guard.server";
import { actorFor } from "../lib/audit/actor";
import { isPractice } from "../services/campaigns/model.server";
import {
  canTransition,
  describeState,
  needsAttention,
  type CampaignState,
} from "../lib/lifecycle/transitions";
import { transitionHistory } from "../services/campaigns/lifecycle.server";
import { approvalFor, decideApproval, requestApproval, SelfApprovalError } from "../services/approvals.server";
import { PageShell } from "../components/PageShell";
import { CampaignTabs, currentTab, type CampaignTab } from "../components/campaign/CampaignTabs";
import { CampaignHeader } from "../components/campaign/CampaignHeader";
import { CampaignOverviewTab } from "../components/campaign/CampaignOverviewTab";
import { CampaignPreviewTab } from "../components/campaign/CampaignPreviewTab";
import { CampaignRevertTab } from "../components/campaign/CampaignRevertTab";
import { CampaignLedgerTab } from "../components/campaign/CampaignLedgerTab";
import type { CampaignDetailProps } from "../components/campaign/props";

export const loader = withGuard("/app/campaigns/$id", async ({ request, params }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const campaignId = String(params.id);

  const [preview, runs, record] = await Promise.all([
    // The client lets the review step say how each market will actually be written.
    // Without it the preview says the choice is made at run time, which is honest but
    // less useful than the answer.
    previewCampaign(shop.id, campaignId, { client: toAdminClient(admin) }),
    campaignRuns(shop.id, campaignId),
    prisma.campaign.findFirstOrThrow({
      where: { id: campaignId, shopId: shop.id },
      select: {
        schedule: true,
        autoEnroll: true,
        enrollPendingAt: true,
        status: true,
      },
    }),
  ]);

  const approval = await approvalFor(shop.id, campaignId);
  const state = record.status as CampaignState;
  const practice = isPractice(record);
  const lifecycle = describeState(state);
  const history = await transitionHistory(shop.id, campaignId, 8);

  const schedule = parseSchedule(record.schedule);
  const scheduleText = describeSchedule(schedule, shop.timezone);
  const warnings = scheduleWarnings(schedule);

  // Show the newest run's ledger inline. The first question after a run is always
  // "what exactly did it do to each variant", and making that a second click loses
  // the people who most need the answer.
  const requested = new URL(request.url).searchParams.get("run");
  const selectedRunId = requested ?? runs[0]?.id ?? null;
  const ledger = selectedRunId ? await runLedger(shop.id, selectedRunId) : [];

  // How many rows that run wrote in total, so the table can say what it is not showing.
  // The ledger is capped — `s-table` blanks the page past a few hundred cells — and a
  // capped table that says nothing reads as the whole record, on the one screen whose
  // entire job is being the record.
  const ledgerTotal = selectedRunId
    ? await prisma.variantChange.count({ where: { shopId: shop.id, runId: selectedRunId } })
    : 0;

  // What that run actually did, as opposed to what the preview said it would. The ledger
  // is the evidence; the preview is the intention, and a partial run is exactly where the
  // two stop agreeing.
  const result = selectedRunId ? await campaignResult(shop.id, selectedRunId) : null;

  // Only for a campaign that has actually written something and could still be
  // reverted. It costs a full plan, and on a draft it would be a report about
  // nothing -- the honest answer there is that there is nothing to roll back.
  const revertable = state === "ACTIVE" || state === "PARTIAL" || state === "HELD";
  const rollback =
    revertable && runs.some((run) => run.kind === "APPLY")
      ? await rollbackReport(shop.id, campaignId)
      : null;

  return {
    rollback,
    preview,
    runs,
    ledger,
    ledgerTotal,
    result,
    selectedRunId,
    scheduleText,
    timeZone: shop.timezone,
    warnings,
    autoEnroll: record.autoEnroll,
    enrollPendingAt: record.enrollPendingAt !== null,
    state,
    practice,
    lifecycle,
    approval: {
      required: approval.required,
      state: approval.required ? approval.state : "none",
      who:
        approval.required && approval.state === "approved"
          ? approval.approvedBy
          : approval.required && approval.state === "declined"
            ? approval.declinedBy
            : approval.required && approval.state === "pending"
              ? approval.requestedBy
              : null,
      note: approval.required && approval.state === "declined" ? approval.note : null,
    },
    needsAttention: needsAttention(state),
    history,
  };
});

export const action = withGuard("/app/campaigns/$id", async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session, sessionToken } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const actor = actorFor(sessionToken, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const campaignId = String(params.id);

  if (intent === "request-approval") {
    await requestApproval(shop.id, campaignId, actor);
    return { ok: true, message: "Approval requested. Somebody else needs to sign this off." };
  }

  if (intent === "approve" || intent === "decline") {
    try {
      await decideApproval(
        shop.id,
        campaignId,
        actor,
        intent === "approve" ? "approve" : "decline",
        String(form.get("note") ?? "") || undefined,
      );
      return {
        ok: true,
        message: intent === "approve" ? "Approved." : "Declined, and the campaign cannot run.",
      };
    } catch (error) {
      if (error instanceof SelfApprovalError) {
        return { ok: false, message: error.message };
      }
      throw error;
    }
  }
  const reverting = intent === "revert";

  try {
    // Reverting one variant out of a running campaign, rather than ending the whole
    // thing. The exclusion is durable, so tonight's scheduled run leaves it alone too.
    if (intent === "revert-variant" || intent === "reinstate-variant") {
      const variantGid = String(form.get("variantGid"));
      const result =
        intent === "revert-variant"
          ? await revertVariant(shop.id, String(params.id), variantGid, toAdminClient(admin), {
              actor,
              excludeOnly: form.get("excludeOnly") === "1",
            })
          : await reinstateVariant(shop.id, String(params.id), variantGid, toAdminClient(admin), {
              actor,
            });

      return {
        ok: result.outcome ? result.outcome.clean : true,
        message: result.message,
        details: result.outcome?.messages ?? [],
      };
    }

    // Resume is an ordinary apply. The resolver is idempotent, so rows already at the
    // campaign price are planned as "already correct" and cost nothing — only the ones
    // that failed last time are written again. A separate retry path would be a second
    // implementation of the same thing, free to disagree with the first.
    const result = await runCampaign(shop.id, String(params.id), toAdminClient(admin), {
      revert: reverting,
      resume: intent === "resume",
      // Rows the merchant ticked "leave as it is" in the rollback report. Only
      // meaningful on a revert; an apply has no drifted-row conversation to honour.
      skipVariantGids: reverting ? form.getAll("keep").map(String) : undefined,
    });

    const verb = reverting ? "Reverted" : intent === "resume" ? "Resumed" : "Applied";

    // Another worker already owns this occurrence, so this call wrote nothing. It is
    // clean and it verified zero rows, which would otherwise render as "Applied 0
    // variants, all verified" -- technically true and completely misleading about
    // what is happening to the merchant's prices right now.
    if (result.deferredTo) {
      return { ok: true, message: result.messages[0], details: [] };
    }

    return {
      ok: result.clean,
      message: result.clean
        ? `${verb} ${result.verified} variants, all verified.`
        : `${verb} with ${result.failed} failures and ${result.unverified} unverified. ` +
          `Nothing is hidden — resume to retry.`,
      details: result.messages,
    };
  } catch (error) {
    // A failed run is the highest-stakes error in the app: the merchant needs to know
    // their prices are intact, in words, plus a reference that leads us to the stack.
    const reported = await reportError(error, {
      shopId: shop.id,
      shop: session.shop,
      route: "/app/campaigns/$id",
      method: "POST",
      campaignId: String(params.id),
      intent,
    });

    return {
      ok: false,
      message: reported.userMessage,
      details: [`Reference ${reported.errorId}`],
      errorId: reported.errorId,
    };
  }
});

type ActionData = {
  ok: boolean;
  message: string;
  details: string[];
  errorId?: string;
};

export default function CampaignDetail() {
  const {
    rollback,
    practice,
    preview,
    runs,
    ledger,
    ledgerTotal,
    // Renamed: `result` in this component is the fetcher's reply to the last action,
    // and two different "results" on one page is how the wrong one gets rendered.
    result: runResult,
    selectedRunId,
    scheduleText,
    timeZone,
    warnings,
    autoEnroll,
    enrollPendingAt,
    lifecycle,
    approval,
    state,
    needsAttention: attention,
    history,
  } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  // Gated on the lifecycle and on guardrails, deliberately not on "would this write
  // anything". A campaign whose prices already match -- because a merchant set them by
  // hand, or because an earlier run got there first -- still needs to be applied to
  // take ownership of them. Requiring rows to write left such a campaign stuck in
  // Draft forever, which also meant nothing would ever revert those prices.
  // A practice campaign can never be applied — the run path refuses it outright. The
  // button is not merely disabled: offering a control that exists only to be refused
  // undermines the promise the merchant was given when they chose practice.
  const canApply = !practice && !preview.blocked && canTransition(state, "APPLYING");

  // Tabs a campaign has nothing for are not offered. A DRAFT campaign has no runs, and
  // a Runs tab opening onto an empty state reads as something having gone missing.
  const tabs: CampaignTab[] = [
    { id: "overview", label: "Overview", available: true },
    { id: "preview", label: "Preview", available: true },
    { id: "runs", label: "Runs", available: runs.length > 0, badge: runs.length },
    {
      id: "revert",
      label: "Revert",
      available: Boolean(rollback && rollback.counts.total > 0),
      // Drifted rows are the reason to open this tab rather than press the button, so
      // the count belongs on the label.
      badge: rollback?.counts.drifted || undefined,
    },
    { id: "ledger", label: "Ledger", available: ledger.length > 0, badge: ledger.length },
  ];
  const [params] = useSearchParams();
  const tab = currentTab(tabs, params.get("tab"));

  // One bundle rather than threading twenty props through five components. These are
  // not reusable widgets -- they are this page, split so it can be read.
  const detail = {
    rollback, practice, preview, runs, ledger, ledgerTotal, result: runResult, selectedRunId,
    scheduleText, timeZone, warnings, autoEnroll, enrollPendingAt, lifecycle, approval,
    state, needsAttention: attention, history, fetcher, busy, canApply, attention,
  } as CampaignDetailProps;


  return (
    <PageShell heading={preview.name} backTo={{ href: "/app/campaigns", label: "Campaigns" }}>
      {result ? (
        <s-banner tone={result.ok ? "success" : "critical"}>
          <s-paragraph>{result.message}</s-paragraph>
          {result.details.map((detail) => (
            <s-paragraph key={detail}>{detail}</s-paragraph>
          ))}
        </s-banner>
      ) : null}

      {attention ? (
        <s-banner tone={lifecycle.tone === "critical" ? "critical" : "warning"}>
          <s-paragraph>{lifecycle.label}</s-paragraph>
          <s-paragraph>{lifecycle.explanation}</s-paragraph>
          {lifecycle.nextAction?.intent === "drift" ? (
            <s-button href="/app/prices/drift">{lifecycle.nextAction.label}</s-button>
          ) : null}
        </s-banner>
      ) : null}

      {preview.blocked ? (
        <s-banner tone="critical">
          <s-paragraph>
            Blocked by a guardrail on {preview.blocked.variantGid}:{" "}
            {preview.blocked.reason}. No prices were changed — a blocking guardrail
            stops the whole run, not just the offending variant.
          </s-paragraph>
        </s-banner>
      ) : null}

      {/* Up here with the other banners rather than inside the actions, which is where
          it was. It qualifies the whole page — nothing on it will ever write a price —
          not the row of buttons it happened to sit above. */}
      {practice ? (
        <s-banner tone="info">
          <s-paragraph>
            This is a practice campaign. The preview is exactly what would happen, and
            nothing has been or will be written to your storefront. Create a real
            campaign with the same scope and rule when you are ready.
          </s-paragraph>
        </s-banner>
      ) : null}

      {/* Status and what to do about it, above the tabs and visible in every state.
          PARTIAL and HELD are the product's whole trust proposition; putting them inside
          a tab would be hiding exactly the states that must not be hidden. */}
      <CampaignHeader {...detail} />

      <CampaignTabs tabs={tabs} current={tab} />

      {tab === "overview" ? <CampaignOverviewTab {...detail} /> : null}
      {tab === "preview" ? <CampaignPreviewTab {...detail} /> : null}
      {tab === "runs" ? (
        <>
        {runResult ? <RunResultSection result={runResult} /> : null}

        {runs.length > 0 ? (
          <s-section heading="Run history">
            <RunHistoryTable runs={runs} selectedRunId={selectedRunId} timeZone={timeZone} />
          </s-section>
        ) : null}

        </>
      ) : null}
      {tab === "revert" ? <CampaignRevertTab {...detail} /> : null}
      {tab === "ledger" ? <CampaignLedgerTab {...detail} /> : null}
    </PageShell>
  );
}

export function ErrorBoundary() {
  return <RouteBoundary />;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
