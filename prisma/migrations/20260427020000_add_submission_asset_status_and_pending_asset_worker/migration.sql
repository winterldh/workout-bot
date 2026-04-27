CREATE TYPE "SubmissionAssetStatus" AS ENUM ('PENDING', 'PROCESSING', 'ASSET_SAVED', 'ASSET_FAILED');

ALTER TABLE "SubmissionAsset"
ADD COLUMN "assetStatus" "SubmissionAssetStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN "assetRetryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "assetLastError" TEXT,
ADD COLUMN "assetLockedAt" TIMESTAMP(3),
ADD COLUMN "assetProcessedAt" TIMESTAMP(3),
ADD COLUMN "assetNextRetryAt" TIMESTAMP(3);

UPDATE "SubmissionAsset"
SET
  "assetStatus" = CASE
    WHEN "blobUrl" IS NOT NULL THEN 'ASSET_SAVED'
    WHEN COALESCE(("metadata"->>'blobStatus'), '') = 'done' THEN 'ASSET_SAVED'
    WHEN COALESCE(("metadata"->>'blobStatus'), '') = 'failed' THEN 'ASSET_FAILED'
    ELSE 'PENDING'
  END::"SubmissionAssetStatus",
  "assetRetryCount" = COALESCE("assetRetryCount", 0),
  "assetLastError" = CASE
    WHEN COALESCE(("metadata"->>'blobStatus'), '') = 'failed' THEN COALESCE("assetLastError", 'asset_upload_failed')
    ELSE "assetLastError"
  END,
  "assetProcessedAt" = CASE
    WHEN "blobUrl" IS NOT NULL AND "assetProcessedAt" IS NULL THEN "createdAt"
    ELSE "assetProcessedAt"
  END;

CREATE INDEX "SubmissionAsset_assetStatus_assetNextRetryAt_assetLockedAt_idx"
  ON "SubmissionAsset"("assetStatus", "assetNextRetryAt", "assetLockedAt");
