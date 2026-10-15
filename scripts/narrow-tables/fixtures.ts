/**
 * The rows the narrow-table harness renders: the store #804 was reported on, as each
 * page's loader would return it.
 *
 * Typed against the loaders themselves, so a loader that changes shape fails typecheck
 * here rather than rendering a page that no longer exists. Titles and amounts are the ones
 * the issue quotes — "The Minimal Snowboard" at 708.76 read "708.7" — because a fixture of
 * short words and two-digit prices is the one that fits at every width and proves nothing.
 */

import type { useLoaderData } from "react-router";

import type { loader as campaignsLoader } from "../../app/routes/app.campaigns._index";
import type { loader as baselinesLoader } from "../../app/routes/app.prices.baselines._index";
import type { loader as driftLoader } from "../../app/routes/app.prices.drift";
import type { loader as variantsLoader } from "../../app/routes/app.prices._index";
import type { loader as liveLoader } from "../../app/routes/app.prices.live";
import type {
  LedgerRow,
  MarketPreview,
  PreviewRow,
  RunSummary,
} from "../../app/services/campaigns/types";

/** What `useLoaderData<typeof loader>()` hands the page, for the loader given. */
export type LoaderData<Loader> = ReturnType<typeof useLoaderData<Loader>>;

const ADMIN = "https://admin.shopify.com/store/boltify-apps/products/1";

/** Products from the development store, with the prices the issue quotes. */
const PRODUCTS = [
  { title: "The Minimal Snowboard", sku: "SNOW-MIN-158", price: "708.76", baseline: "885.95", jpy: "130400" },
  { title: "The Draft Snowboard", sku: "SNOW-DRAFT-162", price: "2629.95", baseline: "2629.95", jpy: "140600" },
  { title: "Gift Card · $10", sku: null, price: "8.00", baseline: "10.00", jpy: "1500" },
  { title: "The Collection Snowboard: Liquid", sku: "SNOW-LIQ-155", price: "749.95", baseline: "749.95", jpy: "116800" },
  { title: "The Multi-location Snowboard", sku: "SNOW-ML-159", price: "729.95", baseline: "811.06", jpy: "113700" },
  { title: "The Complete Snowboard - Ice", sku: "SNOW-ICE-160", price: "699.95", baseline: "699.95", jpy: "109000" },
  // The widest amounts a column has to hold: seven digits and two decimals, and a JPY
  // price in the hundreds of millions. A number has nowhere to wrap.
  { title: "The Hidden Snowboard", sku: "SNOW-HIDDEN-168W", price: "1249995.00", baseline: "1249995.00", jpy: "196000000" },
];

const gid = (index: number) => `gid://shopify/ProductVariant/4${index}0000000${index}`;

export const live: LoaderData<typeof liveLoader> = {
  rows: PRODUCTS.flatMap((product, index) => [
    {
      variantGid: gid(index),
      title: product.title,
      sku: product.sku,
      priceListGid: "",
      surface: "Base price",
      currency: "USD",
      live: product.price,
      baseline: product.baseline,
      campaignId: product.price === product.baseline ? null : "c1",
      campaignName: product.price === product.baseline ? null : "10% off everything",
      intended: product.price,
      drifted: false,
      offBaseline: product.price !== product.baseline,
      adminUrl: ADMIN,
    },
    {
      variantGid: gid(index),
      title: product.title,
      sku: product.sku,
      priceListGid: "gid://shopify/PriceList/2",
      surface: "Anchor JPY",
      currency: "JPY",
      live: product.jpy,
      baseline: product.jpy,
      campaignId: null,
      campaignName: null,
      intended: null,
      drifted: false,
      offBaseline: false,
      adminUrl: ADMIN,
    },
  ]),
  total: PRODUCTS.length * 2,
  page: 1,
  surfaces: [],
  campaigns: [],
  counts: { drifted: 0, offBaseline: 3, staleBaseline: 0 },
  selected: { q: "", surface: "any", campaign: "", state: "" },
};

export const variants: LoaderData<typeof variantsLoader> = {
  rows: PRODUCTS.map((product, index) => ({
    variantGid: gid(index),
    title: product.title,
    sku: product.sku,
    currency: "USD",
    price: product.price,
    baseline: product.baseline,
    baselineSource: "INSTALL_CAPTURE",
    compareAt: product.price === product.baseline ? null : product.baseline,
    cost: "312.40",
    atBaseline: product.price === product.baseline,
  })),
  total: PRODUCTS.length,
  page: 1,
  query: "",
  pageSize: 15,
  currency: "USD",
};

export const baselines: LoaderData<typeof baselinesLoader> = {
  rows: PRODUCTS.map((product, index) => ({
    variantGid: gid(index),
    productGid: "gid://shopify/Product/1",
    title: product.title,
    sku: product.sku,
    vendor: "Snowboard Vendor",
    baseline: product.baseline,
    live: product.price,
    source: "INSTALL_CAPTURE",
    capturedAt: "2026-09-25T10:00:00.000Z",
    diverged: product.price !== product.baseline,
    adminUrl: ADMIN,
  })),
  total: PRODUCTS.length,
  vendors: ["Snowboard Vendor"],
  sources: ["INSTALL_CAPTURE"],
  page: 1,
  filters: { divergedOnly: false },
  variantGid: null,
  history: [],
  historyTitle: null,
  timeZone: "UTC",
};

export const drift: LoaderData<typeof driftLoader> = {
  rows: PRODUCTS.slice(0, 3).map((product, index) => ({
    id: `d${index}`,
    variantGid: gid(index),
    title: product.title,
    sku: product.sku,
    observed: product.baseline,
    expected: product.price,
    currency: "USD",
    direction: product.baseline === product.price ? null : "up",
    campaignId: "c1",
    campaignName: "10% off everything",
    detectedAt: "2026-09-25T10:00:00.000Z",
    stillShown: true,
  })),
  total: 3,
  filtered: 3,
  campaigns: [{ id: "c1", name: "10% off everything", pending: 3 }],
  bulk: { id: "c1", name: "10% off everything", status: "HELD" },
  matchingCampaigns: 1,
  filters: {},
  page: 1,
  asOf: "2026-09-25T10:00:00.000Z",
  status: null,
};

export const campaigns: LoaderData<typeof campaignsLoader> = {
  view: "list",
  filters: { q: "", status: "", archived: false, page: 1 },
  calendar: null,
  list: {
    campaigns: [
      {
        id: "c1",
        name: "10% off everything",
        state: "COMPLETED",
        lifecycle: { label: "Completed", tone: "neutral" },
        attention: false,
        priority: 100,
        rule: "10% off",
        scope: "All variants",
        note: null,
        archived: false,
        createdAt: "2026-09-25T10:00:00.000Z",
        lastRun: { kind: "REVERT", status: "COMPLETED", verified: 1240, failed: 0, atShopify: null },
      },
      {
        id: "c2",
        name: "Black Friday snowboards",
        state: "ACTIVE",
        lifecycle: { label: "Active", tone: "success" },
        attention: false,
        priority: 900,
        rule: "25% off, rounded to .95",
        scope: "Collection: Winter snowboards",
        note: null,
        archived: false,
        createdAt: "2026-09-24T10:00:00.000Z",
        lastRun: { kind: "APPLY", status: "COMPLETED", verified: 38, failed: 2, atShopify: null },
      },
    ],
    total: 2,
    attentionCount: 0,
    page: 1,
    pages: 1,
  },
} as unknown as LoaderData<typeof campaignsLoader>;

/** The campaign page's tables take their rows as props, not from a loader of their own. */
export const markets: MarketPreview[] = [
  {
    priceListGid: "gid://shopify/PriceList/2",
    name: "Anchor JPY",
    currency: "JPY",
    path: "market-wide",
    explanation: "",
    clamped: 0,
    skipped: 0,
    refused: false,
  } as MarketPreview,
];

export const previewRows: PreviewRow[] = PRODUCTS.map((product, index) => ({
  variantGid: gid(index),
  title: product.title,
  before: product.baseline,
  after: product.price,
  compareAt: product.baseline,
  status: "pending",
  surfaces: {
    "gid://shopify/PriceList/2": {
      after: product.jpy,
      compareAt: null,
      status: "pending",
    },
  },
}));

export const ledgerRows: LedgerRow[] = PRODUCTS.map((product, index) => ({
  variantGid: gid(index),
  title: product.title,
  surface: "Base price",
  currency: "USD",
  priceListGid: "",
  before: product.baseline,
  intended: product.price,
  status: index === 2 ? "FAILED" : "VERIFIED",
  failureReason: index === 2 ? "Shopify refused the price: gift cards are not priced by campaigns" : null,
}));

export const runs: RunSummary[] = [
  {
    id: "r2",
    kind: "REVERT",
    status: "COMPLETED",
    planned: 1240,
    verified: 1240,
    failed: 0,
    skipped: 0,
    startedAt: "2026-09-25T10:00:00.000Z",
    finishedAt: "2026-09-25T10:04:00.000Z",
  },
  {
    id: "r1",
    kind: "APPLY",
    status: "PARTIAL",
    planned: 1240,
    verified: 1238,
    failed: 2,
    skipped: 0,
    startedAt: "2026-09-24T10:00:00.000Z",
    finishedAt: "2026-09-24T10:06:00.000Z",
  },
];
