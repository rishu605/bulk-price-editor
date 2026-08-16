/**
 * Public surface of the campaign services.
 *
 * Routes import from here so they never need to know which module a function lives
 * in, and the split can change without touching the UI.
 */

export { createCampaign, toResolvable, astOf } from "./model.server";
export { loadCandidates, productMapFor, titleMapFor } from "./candidates.server";
export { previewCampaign, type PreviewOptions } from "./preview.server";
export { runCampaign, type RunOptions } from "./run.server";
export { campaignRuns, runLedger } from "./history.server";
export type {
  CampaignInput,
  CampaignPreview,
  LedgerRow,
  PreviewRow,
  RunOutcome,
  RunSummary,
} from "./types";
