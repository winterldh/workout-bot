ALTER TYPE "SlackEventReceiptStatus" ADD VALUE IF NOT EXISTS 'RECEIVED';
ALTER TYPE "SlackEventReceiptStatus" ADD VALUE IF NOT EXISTS 'ACKED';

ALTER TABLE "SlackEventReceipt"
ADD COLUMN IF NOT EXISTS "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS "ackAt" TIMESTAMP(3);

ALTER TABLE "SlackEventReceipt"
ALTER COLUMN "status" SET DEFAULT 'RECEIVED';

UPDATE "SlackEventReceipt"
SET "receivedAt" = COALESCE("startedAt", "createdAt")
WHERE "receivedAt" IS NULL;

CREATE TYPE "SlackEventJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');
CREATE TYPE "SlackEventJobResultStatus" AS ENUM ('ACCEPTED', 'DUPLICATE', 'IGNORED', 'REPLIED');

CREATE TABLE "SlackEventJob" (
  "id" TEXT NOT NULL,
  "receiptId" TEXT,
  "eventId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "slackUserId" TEXT,
  "groupId" TEXT,
  "goalId" TEXT,
  "intent" TEXT,
  "resultStatus" "SlackEventJobResultStatus",
  "payload" JSONB NOT NULL,
  "status" "SlackEventJobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lockedAt" TIMESTAMP(3),
  "processingStartedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "nextRetryAt" TIMESTAMP(3),
  "lastError" TEXT,
  "checkInRecordId" TEXT,
  "rawSubmissionId" TEXT,
  "submissionAssetId" TEXT,
  "changeCandidateId" TEXT,
  "replySentAt" TIMESTAMP(3),
  "channelStatusSentAt" TIMESTAMP(3),
  "assetUploadedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SlackEventJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackEventJob_receiptId_key" ON "SlackEventJob"("receiptId");
CREATE UNIQUE INDEX "SlackEventJob_eventId_key" ON "SlackEventJob"("eventId");
CREATE UNIQUE INDEX "SlackEventReceipt_workspaceId_eventId_key" ON "SlackEventReceipt"("workspaceId", "eventId");
CREATE UNIQUE INDEX "SlackEventJob_workspaceId_eventId_key" ON "SlackEventJob"("workspaceId", "eventId");
CREATE INDEX "SlackEventJob_status_nextRetryAt_lockedAt_idx" ON "SlackEventJob"("status", "nextRetryAt", "lockedAt");
CREATE INDEX "SlackEventJob_workspaceId_channelId_status_createdAt_idx" ON "SlackEventJob"("workspaceId", "channelId", "status", "createdAt");
CREATE INDEX "SlackEventJob_groupId_status_createdAt_idx" ON "SlackEventJob"("groupId", "status", "createdAt");

ALTER TABLE "SlackEventJob"
ADD CONSTRAINT "SlackEventJob_receiptId_fkey"
FOREIGN KEY ("receiptId") REFERENCES "SlackEventReceipt"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
