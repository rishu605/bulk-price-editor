-- Expand only (#1093): a nullable column, which the release before this neither reads nor
-- writes. A derived market baseline records the list's percentage it was read at.
ALTER TABLE "baselines" ADD COLUMN "listAdjustmentBps" INTEGER;
