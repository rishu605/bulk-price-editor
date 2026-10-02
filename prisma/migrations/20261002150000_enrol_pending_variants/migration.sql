-- The variants waiting behind "enrollPendingAt", so an enrolment re-apply prices those
-- and nothing else (#805). Expand only: a release one version back ignores the column
-- and runs the whole-campaign re-apply it always did.
ALTER TABLE "campaigns" ADD COLUMN     "enrollPendingVariantGids" TEXT[] DEFAULT ARRAY[]::TEXT[];
