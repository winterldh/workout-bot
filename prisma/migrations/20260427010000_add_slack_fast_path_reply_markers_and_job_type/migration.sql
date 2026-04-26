CREATE TYPE "SlackEventJobType" AS ENUM ('CHECKIN_ASSET_UPLOAD', 'NICKNAME_SAVE', 'ADMIN_ALERT', 'RECOVERY');

ALTER TABLE "SlackEventReceipt"
ADD COLUMN "replyAttemptedAt" TIMESTAMP(3),
ADD COLUMN "replySentAt" TIMESTAMP(3),
ADD COLUMN "replySlackTs" TEXT;

ALTER TABLE "SlackEventJob"
ADD COLUMN "jobType" "SlackEventJobType";

CREATE INDEX "SlackEventJob_jobType_status_nextRetryAt_lockedAt_idx"
  ON "SlackEventJob" ("jobType", "status", "nextRetryAt", "lockedAt");
