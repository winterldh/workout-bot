ALTER TABLE "SubmissionAsset"
ADD COLUMN "blobUrl" TEXT,
ADD COLUMN "slackOriginalUrl" TEXT;

ALTER TABLE "SlackChangeCandidate"
ADD COLUMN "blobUrl" TEXT,
ADD COLUMN "slackOriginalUrl" TEXT;

UPDATE "SubmissionAsset"
SET
  "blobUrl" = COALESCE("blobUrl", "originalUrl"),
  "slackOriginalUrl" = COALESCE("slackOriginalUrl", "originalPhotoUrl");

UPDATE "SlackChangeCandidate"
SET
  "blobUrl" = COALESCE("blobUrl", "imageUrl"),
  "slackOriginalUrl" = COALESCE("slackOriginalUrl", "originalPhotoUrl");
