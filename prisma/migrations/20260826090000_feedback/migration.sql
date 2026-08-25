-- In-app feedback from beta merchants (P4.2).
--
-- Persisted rather than emailed straight out, for two reasons. A merchant who sends
-- feedback should be able to see that it arrived, and telling them when it ships is what
-- keeps a beta cohort engaged -- neither is possible if the only copy is in somebody's
-- inbox.
--
-- Context is captured rather than asked for. "Which screen were you on" is a question
-- whose answer we already have, and every question asked is a reason not to send.
--
-- Expand-only: a new table and its indexes.
CREATE TABLE "feedback" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,

    "message" TEXT NOT NULL,
    "sentiment" TEXT NOT NULL,

    -- Captured automatically at submission.
    "route" TEXT,
    "planTier" TEXT,
    "variantCount" INTEGER,
    "actor" TEXT,

    -- Triage. Null status means nobody has looked yet.
    "status" TEXT,
    "theme" TEXT,
    "shippedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_shopId_createdAt_idx" ON "feedback"("shopId", "createdAt");
CREATE INDEX "feedback_status_idx" ON "feedback"("status");

ALTER TABLE "feedback" ADD CONSTRAINT "feedback_shopId_fkey"
  FOREIGN KEY ("shopId") REFERENCES "shops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
