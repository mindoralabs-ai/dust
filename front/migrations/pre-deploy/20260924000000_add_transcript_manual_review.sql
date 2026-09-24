-- Keep an ambiguous paid embedding out of the normal transcript retry loop
-- while preserving an explicit operator reconciliation marker.
ALTER TABLE "labs_transcripts_histories"
  ADD COLUMN "manualReviewRequired" BOOLEAN NOT NULL DEFAULT false;
