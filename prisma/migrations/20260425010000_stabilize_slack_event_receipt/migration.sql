ALTER TYPE "SlackEventReceiptStatus" RENAME VALUE 'COMPLETED' TO 'DONE';

ALTER TABLE "SlackEventReceipt"
ADD COLUMN "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "finishedAt" TIMESTAMP(3),
ADD COLUMN "lastError" TEXT,
ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;

UPDATE "SlackEventReceipt"
SET "startedAt" = COALESCE("processedAt", "createdAt"),
    "finishedAt" = "processedAt",
    "lastError" = "error"
WHERE "startedAt" IS NOT NULL;
