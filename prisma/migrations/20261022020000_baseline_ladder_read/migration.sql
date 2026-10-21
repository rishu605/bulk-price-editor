-- Expand only (#1103): a nullable column the release before this neither reads nor writes.
-- Null on every existing row: whether its quantity ladder was read is not known.
ALTER TABLE "baselines" ADD COLUMN "ladderRead" BOOLEAN;
