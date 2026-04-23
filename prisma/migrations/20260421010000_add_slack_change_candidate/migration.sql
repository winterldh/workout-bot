CREATE TABLE "public"."SlackChangeCandidate" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "recordDate" TIMESTAMP(3) NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackChangeCandidate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SlackChangeCandidate_workspaceId_channelId_userId_recordDate_key"
ON "public"."SlackChangeCandidate"("workspaceId", "channelId", "userId", "recordDate");

CREATE INDEX "SlackChangeCandidate_groupId_goalId_recordDate_idx"
ON "public"."SlackChangeCandidate"("groupId", "goalId", "recordDate");

ALTER TABLE "public"."SlackChangeCandidate"
ADD CONSTRAINT "SlackChangeCandidate_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."SlackChangeCandidate"
ADD CONSTRAINT "SlackChangeCandidate_goalId_fkey"
FOREIGN KEY ("goalId") REFERENCES "public"."Goal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "public"."SlackChangeCandidate"
ADD CONSTRAINT "SlackChangeCandidate_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
