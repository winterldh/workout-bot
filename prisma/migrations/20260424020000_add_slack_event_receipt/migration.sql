CREATE TYPE "SlackEventReceiptStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED', 'SKIPPED');

CREATE TABLE "SlackEventReceipt" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "requestId" TEXT,
  "workspaceId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "slackUserId" TEXT,
  "eventType" TEXT NOT NULL,
  "intent" TEXT,
  "status" "SlackEventReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
  "retryNum" INTEGER,
  "retryReason" TEXT,
  "ignoredReason" TEXT,
  "error" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SlackEventReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackEventReceipt_eventId_key" ON "SlackEventReceipt"("eventId");
CREATE INDEX "SlackEventReceipt_workspaceId_channelId_createdAt_idx" ON "SlackEventReceipt"("workspaceId", "channelId", "createdAt");
