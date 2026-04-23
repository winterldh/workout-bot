-- CreateTable
CREATE TABLE "SlackIntegration" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "channelId" TEXT NOT NULL,
  "botToken" TEXT,
  "signingSecret" TEXT,
  "autoJoinOnFirstCheckIn" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SlackIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SlackIntegration_workspaceId_channelId_key"
ON "SlackIntegration"("workspaceId", "channelId");

-- CreateIndex
CREATE INDEX "SlackIntegration_groupId_goalId_idx"
ON "SlackIntegration"("groupId", "goalId");

-- AddForeignKey
ALTER TABLE "SlackIntegration"
ADD CONSTRAINT "SlackIntegration_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "Group"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlackIntegration"
ADD CONSTRAINT "SlackIntegration_goalId_fkey"
FOREIGN KEY ("goalId") REFERENCES "Goal"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
