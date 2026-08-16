-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PlanTier" AS ENUM ('FREE', 'GROWTH', 'MARKETS', 'WHOLESALE');

-- CreateEnum
CREATE TYPE "VariantStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DRAFT');

-- CreateEnum
CREATE TYPE "SurfaceKind" AS ENUM ('BASE', 'MARKET', 'B2B');

-- CreateEnum
CREATE TYPE "BaselineSource" AS ENUM ('INSTALL_CAPTURE', 'RECAPTURE', 'CSV_IMPORT', 'DRIFT_ADOPTION', 'AUTO_ENROLL');

-- CreateEnum
CREATE TYPE "SegmentKind" AS ENUM ('DYNAMIC', 'FROZEN');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'APPLYING', 'ACTIVE', 'HELD', 'REVERTING', 'COMPLETED', 'PARTIAL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('APPLY', 'REVERT', 'REASSERT', 'ENROLL');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('PLANNING', 'QUEUED', 'EXECUTING', 'VERIFYING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WritePath" AS ENUM ('SYNC', 'BULK');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('PENDING', 'WRITING', 'APPLIED', 'VERIFIED', 'FAILED', 'SKIPPED', 'CLAMPED', 'REVERTED');

-- CreateEnum
CREATE TYPE "DriftResolution" AS ENUM ('PENDING', 'ADOPTED', 'REASSERTED', 'IGNORED');

-- CreateEnum
CREATE TYPE "RoundingMode" AS ENUM ('CHARM', 'STEP');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "BulkOpKind" AS ENUM ('QUERY', 'MUTATION');

-- CreateEnum
CREATE TYPE "BulkOpStatus" AS ENUM ('CREATED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shops" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "accessTokenEnc" TEXT,
    "scopes" TEXT,
    "planTier" "PlanTier" NOT NULL DEFAULT 'FREE',
    "variantCap" INTEGER,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "initialSyncCompletedAt" TIMESTAMP(3),

    CONSTRAINT "shops_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_index" (
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "productGid" TEXT NOT NULL,
    "sku" TEXT,
    "barcode" TEXT,
    "title" TEXT,
    "price" BIGINT,
    "compareAt" BIGINT,
    "cost" BIGINT,
    "currency" TEXT,
    "inventoryQty" INTEGER,
    "status" "VariantStatus" NOT NULL DEFAULT 'ACTIVE',
    "vendor" TEXT,
    "productType" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "collections" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remoteUpdatedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "variant_index_pkey" PRIMARY KEY ("shopId","variantGid")
);

-- CreateTable
CREATE TABLE "price_surface_entries" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "surfaceKind" "SurfaceKind" NOT NULL,
    "priceListGid" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "livePrice" BIGINT,
    "liveCompareAt" BIGINT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_surface_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "baselines" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "surfaceKind" "SurfaceKind" NOT NULL,
    "priceListGid" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "basePrice" BIGINT NOT NULL,
    "baseCompareAt" BIGINT,
    "cost" BIGINT,
    "source" "BaselineSource" NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedBy" TEXT,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "baselines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SegmentKind" NOT NULL DEFAULT 'DYNAMIC',
    "filterAst" JSONB NOT NULL DEFAULT '{}',
    "frozenVariantGids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "ruleRows" JSONB NOT NULL DEFAULT '[]',
    "surfaces" JSONB NOT NULL DEFAULT '{}',
    "compareAtPolicy" JSONB NOT NULL DEFAULT '{"kind":"leave"}',
    "compareAtViolationPolicy" TEXT NOT NULL DEFAULT 'clear',
    "roundingProfileId" TEXT,
    "guardrails" JSONB,
    "guardrailViolationPolicy" TEXT NOT NULL DEFAULT 'clamp',
    "schedule" JSONB NOT NULL DEFAULT '{}',
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "tagKit" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoEnroll" BOOLEAN NOT NULL DEFAULT true,
    "excludedVariantGids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_runs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'PLANNING',
    "occurrenceKey" TEXT NOT NULL,
    "writePath" "WritePath",
    "plannedRows" INTEGER NOT NULL DEFAULT 0,
    "verifiedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "variant_changes" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "surfaceKind" "SurfaceKind" NOT NULL,
    "priceListGid" TEXT NOT NULL DEFAULT '',
    "currency" TEXT NOT NULL,
    "beforePrice" BIGINT,
    "beforeCompareAt" BIGINT,
    "intendedPrice" BIGINT,
    "intendedCompareAt" BIGINT,
    "intendedCompareAtSet" BOOLEAN NOT NULL DEFAULT false,
    "appliedPrice" BIGINT,
    "verifiedPrice" BIGINT,
    "status" "ChangeStatus" NOT NULL DEFAULT 'PENDING',
    "failureReason" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "appliedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "variant_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "write_intents" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "surfaceKind" "SurfaceKind" NOT NULL,
    "priceListGid" TEXT NOT NULL DEFAULT '',
    "valueHash" TEXT NOT NULL,
    "writtenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "write_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "drift_events" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantGid" TEXT NOT NULL,
    "surfaceKind" "SurfaceKind" NOT NULL,
    "priceListGid" TEXT NOT NULL DEFAULT '',
    "campaignId" TEXT,
    "observedPrice" BIGINT,
    "expectedPrice" BIGINT,
    "currency" TEXT NOT NULL,
    "resolution" "DriftResolution" NOT NULL DEFAULT 'PENDING',
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "drift_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rounding_profiles" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "mode" "RoundingMode" NOT NULL,
    "ending" INTEGER,
    "step" INTEGER,
    "direction" TEXT NOT NULL DEFAULT 'nearest',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rounding_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "shopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failureReason" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bulk_operations" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "runId" TEXT,
    "shopifyGid" TEXT NOT NULL,
    "kind" "BulkOpKind" NOT NULL,
    "status" "BulkOpStatus" NOT NULL DEFAULT 'CREATED',
    "stagedUploadPath" TEXT,
    "resultUrl" TEXT,
    "objectCount" BIGINT,
    "errorCode" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "lastPolledAt" TIMESTAMP(3),

    CONSTRAINT "bulk_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CampaignSegments" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CampaignSegments_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "shops_domain_key" ON "shops"("domain");

-- CreateIndex
CREATE INDEX "shops_uninstalledAt_idx" ON "shops"("uninstalledAt");

-- CreateIndex
CREATE INDEX "variant_index_shopId_productGid_idx" ON "variant_index"("shopId", "productGid");

-- CreateIndex
CREATE INDEX "variant_index_shopId_sku_idx" ON "variant_index"("shopId", "sku");

-- CreateIndex
CREATE INDEX "variant_index_shopId_price_idx" ON "variant_index"("shopId", "price");

-- CreateIndex
CREATE INDEX "variant_index_shopId_status_idx" ON "variant_index"("shopId", "status");

-- CreateIndex
CREATE INDEX "variant_index_shopId_deletedAt_idx" ON "variant_index"("shopId", "deletedAt");

-- CreateIndex
CREATE INDEX "price_surface_entries_shopId_surfaceKind_idx" ON "price_surface_entries"("shopId", "surfaceKind");

-- CreateIndex
CREATE INDEX "price_surface_entries_shopId_priceListGid_idx" ON "price_surface_entries"("shopId", "priceListGid");

-- CreateIndex
CREATE UNIQUE INDEX "price_surface_entries_shopId_variantGid_surfaceKind_priceLi_key" ON "price_surface_entries"("shopId", "variantGid", "surfaceKind", "priceListGid");

-- CreateIndex
CREATE INDEX "baselines_shopId_variantGid_surfaceKind_idx" ON "baselines"("shopId", "variantGid", "surfaceKind");

-- CreateIndex
CREATE INDEX "baselines_shopId_supersededAt_idx" ON "baselines"("shopId", "supersededAt");

-- CreateIndex
CREATE INDEX "segments_shopId_kind_idx" ON "segments"("shopId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "segments_shopId_name_key" ON "segments"("shopId", "name");

-- CreateIndex
CREATE INDEX "campaigns_shopId_status_idx" ON "campaigns"("shopId", "status");

-- CreateIndex
CREATE INDEX "campaigns_shopId_startAt_idx" ON "campaigns"("shopId", "startAt");

-- CreateIndex
CREATE INDEX "campaigns_shopId_endAt_idx" ON "campaigns"("shopId", "endAt");

-- CreateIndex
CREATE INDEX "campaign_runs_shopId_status_idx" ON "campaign_runs"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_runs_campaignId_occurrenceKey_kind_key" ON "campaign_runs"("campaignId", "occurrenceKey", "kind");

-- CreateIndex
CREATE INDEX "variant_changes_shopId_status_idx" ON "variant_changes"("shopId", "status");

-- CreateIndex
CREATE INDEX "variant_changes_runId_status_idx" ON "variant_changes"("runId", "status");

-- CreateIndex
CREATE INDEX "variant_changes_shopId_variantGid_idx" ON "variant_changes"("shopId", "variantGid");

-- CreateIndex
CREATE UNIQUE INDEX "variant_changes_runId_variantGid_surfaceKind_priceListGid_key" ON "variant_changes"("runId", "variantGid", "surfaceKind", "priceListGid");

-- CreateIndex
CREATE INDEX "write_intents_shopId_variantGid_valueHash_idx" ON "write_intents"("shopId", "variantGid", "valueHash");

-- CreateIndex
CREATE INDEX "write_intents_writtenAt_idx" ON "write_intents"("writtenAt");

-- CreateIndex
CREATE INDEX "drift_events_shopId_resolution_idx" ON "drift_events"("shopId", "resolution");

-- CreateIndex
CREATE INDEX "drift_events_shopId_variantGid_idx" ON "drift_events"("shopId", "variantGid");

-- CreateIndex
CREATE INDEX "rounding_profiles_shopId_currency_idx" ON "rounding_profiles"("shopId", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "rounding_profiles_shopId_name_key" ON "rounding_profiles"("shopId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_webhookId_key" ON "webhook_events"("webhookId");

-- CreateIndex
CREATE INDEX "webhook_events_shopDomain_topic_idx" ON "webhook_events"("shopDomain", "topic");

-- CreateIndex
CREATE INDEX "webhook_events_status_receivedAt_idx" ON "webhook_events"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "bulk_operations_shopifyGid_key" ON "bulk_operations"("shopifyGid");

-- CreateIndex
CREATE INDEX "bulk_operations_shopId_status_idx" ON "bulk_operations"("shopId", "status");

-- CreateIndex
CREATE INDEX "audit_log_shopId_createdAt_idx" ON "audit_log"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_shopId_action_idx" ON "audit_log"("shopId", "action");

-- CreateIndex
CREATE INDEX "_CampaignSegments_B_index" ON "_CampaignSegments"("B");

-- AddForeignKey
ALTER TABLE "variant_index" ADD CONSTRAINT "variant_index_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_surface_entries" ADD CONSTRAINT "price_surface_entries_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "baselines" ADD CONSTRAINT "baselines_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_roundingProfileId_fkey" FOREIGN KEY ("roundingProfileId") REFERENCES "rounding_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_runs" ADD CONSTRAINT "campaign_runs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_runs" ADD CONSTRAINT "campaign_runs_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_changes" ADD CONSTRAINT "variant_changes_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "variant_changes" ADD CONSTRAINT "variant_changes_runId_fkey" FOREIGN KEY ("runId") REFERENCES "campaign_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_intents" ADD CONSTRAINT "write_intents_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_events" ADD CONSTRAINT "drift_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "drift_events" ADD CONSTRAINT "drift_events_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rounding_profiles" ADD CONSTRAINT "rounding_profiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_runId_fkey" FOREIGN KEY ("runId") REFERENCES "campaign_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignSegments" ADD CONSTRAINT "_CampaignSegments_A_fkey" FOREIGN KEY ("A") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignSegments" ADD CONSTRAINT "_CampaignSegments_B_fkey" FOREIGN KEY ("B") REFERENCES "segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints and indexes Prisma cannot express declaratively.
-- ---------------------------------------------------------------------------

-- Exactly one CURRENT baseline per variant per surface.
--
-- Baselines are append-only: a recapture supersedes the previous row rather than
-- updating it, so the history of a variant's reference price survives. That makes
-- the uniqueness conditional -- superseded rows may repeat freely, current ones
-- must not. A plain unique constraint cannot express "where supersededAt is null".
--
-- This is the guarantee the entire product rests on: if two current baselines
-- existed for one variant, campaign maths would be non-deterministic.
CREATE UNIQUE INDEX "baselines_current_unique"
  ON "baselines" ("shopId", "variantGid", "surfaceKind", "priceListGid")
  WHERE "supersededAt" IS NULL;

-- Array containment lookups for the filter engine (P3.1). Without GIN, filtering
-- 500K variants by tag or collection is a sequential scan, and the live match count
-- has a 1.5s p95 budget.
CREATE INDEX "variant_index_tags_gin" ON "variant_index" USING GIN ("tags");
CREATE INDEX "variant_index_collections_gin" ON "variant_index" USING GIN ("collections");

-- Case-insensitive prefix search on SKU and title for the picker and filter builder.
CREATE INDEX "variant_index_sku_lower" ON "variant_index" (LOWER("sku"));
CREATE INDEX "variant_index_title_lower" ON "variant_index" (LOWER("title"));

-- Drift queue and resume paths read only the unfinished rows, which are a tiny
-- fraction of a large ledger. Partial indexes keep those reads cheap regardless of
-- how much history has accumulated.
CREATE INDEX "variant_changes_unverified"
  ON "variant_changes" ("runId", "status")
  WHERE "status" NOT IN ('VERIFIED', 'SKIPPED', 'REVERTED');

CREATE INDEX "drift_events_pending"
  ON "drift_events" ("shopId", "detectedAt")
  WHERE "resolution" = 'PENDING';

-- The poll fallback for a missed bulk_operations/finish webhook (edge case E13)
-- scans only in-flight operations.
CREATE INDEX "bulk_operations_in_flight"
  ON "bulk_operations" ("shopId", "lastPolledAt")
  WHERE "status" IN ('CREATED', 'RUNNING');
