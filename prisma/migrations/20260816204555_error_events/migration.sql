-- CreateTable
CREATE TABLE "error_events" (
    "id" TEXT NOT NULL,
    "errorId" TEXT NOT NULL,
    "shopId" TEXT,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "stack" TEXT,
    "userMessage" TEXT NOT NULL,
    "route" TEXT,
    "method" TEXT,
    "context" JSONB,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "error_events_errorId_key" ON "error_events"("errorId");

-- CreateIndex
CREATE INDEX "error_events_shopId_createdAt_idx" ON "error_events"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "error_events_code_createdAt_idx" ON "error_events"("code", "createdAt");

-- AddForeignKey
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE SET NULL ON UPDATE CASCADE;
