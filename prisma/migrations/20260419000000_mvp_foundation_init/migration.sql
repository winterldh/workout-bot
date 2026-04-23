-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('MEMBER', 'ADMIN');

-- CreateEnum
CREATE TYPE "IdentityProvider" AS ENUM ('SLACK', 'WEB');

-- CreateEnum
CREATE TYPE "SubmissionSourceType" AS ENUM ('SLACK', 'WEB');

-- CreateEnum
CREATE TYPE "CheckInRecordStatus" AS ENUM ('APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "GoalPeriodUnit" AS ENUM ('HOUR', 'DAY', 'WEEK');

-- CreateEnum
CREATE TYPE "SubmissionAssetKind" AS ENUM ('IMAGE', 'VIDEO', 'FILE');

-- CreateTable
CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Group" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "timezone" TEXT NOT NULL DEFAULT 'Asia/Seoul',
  "creatorUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserIdentity" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" "IdentityProvider" NOT NULL,
  "providerUserId" TEXT NOT NULL,
  "providerWorkspaceId" TEXT,
  "providerUsername" TEXT,
  "profile" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMembership" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "targetCount" INTEGER NOT NULL,
  "periodUnit" "GoalPeriodUnit" NOT NULL DEFAULT 'DAY',
  "periodValue" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RawSubmission" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "userId" TEXT,
  "identityId" TEXT,
  "goalId" TEXT,
  "sourceType" "SubmissionSourceType" NOT NULL,
  "externalSubmissionId" TEXT,
  "submittedAt" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "rawPayload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RawSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAsset" (
  "id" TEXT NOT NULL,
  "rawSubmissionId" TEXT NOT NULL,
  "kind" "SubmissionAssetKind" NOT NULL DEFAULT 'IMAGE',
  "mimeType" TEXT,
  "originalUrl" TEXT,
  "storageKey" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubmissionAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckInRecord" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "goalId" TEXT NOT NULL,
  "rawSubmissionId" TEXT,
  "status" "CheckInRecordStatus" NOT NULL DEFAULT 'APPROVED',
  "recordAt" TIMESTAMP(3) NOT NULL,
  "recordDate" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "rejectedAt" TIMESTAMP(3),
  "rejectedReason" TEXT,
  "rejectedByMembershipId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CheckInRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Group_slug_key" ON "Group"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_provider_providerUserId_providerWorkspaceId_key"
ON "UserIdentity"("provider", "providerUserId", "providerWorkspaceId");

-- CreateIndex
CREATE INDEX "UserIdentity_userId_idx" ON "UserIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMembership_userId_groupId_key"
ON "GroupMembership"("userId", "groupId");

-- CreateIndex
CREATE INDEX "GroupMembership_groupId_role_idx" ON "GroupMembership"("groupId", "role");

-- CreateIndex
CREATE INDEX "Goal_groupId_startsAt_endsAt_idx" ON "Goal"("groupId", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "RawSubmission_sourceType_externalSubmissionId_key"
ON "RawSubmission"("sourceType", "externalSubmissionId");

-- CreateIndex
CREATE INDEX "RawSubmission_groupId_submittedAt_idx" ON "RawSubmission"("groupId", "submittedAt");

-- CreateIndex
CREATE INDEX "SubmissionAsset_rawSubmissionId_idx" ON "SubmissionAsset"("rawSubmissionId");

-- CreateIndex
CREATE INDEX "CheckInRecord_goalId_status_recordDate_idx"
ON "CheckInRecord"("goalId", "status", "recordDate");

-- CreateIndex
CREATE INDEX "CheckInRecord_groupId_userId_recordDate_idx"
ON "CheckInRecord"("groupId", "userId", "recordDate");

-- CreateIndex
CREATE INDEX "CheckInRecord_rawSubmissionId_idx" ON "CheckInRecord"("rawSubmissionId");

-- AddForeignKey
ALTER TABLE "Group"
ADD CONSTRAINT "Group_creatorUserId_fkey"
FOREIGN KEY ("creatorUserId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserIdentity"
ADD CONSTRAINT "UserIdentity_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership"
ADD CONSTRAINT "GroupMembership_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMembership"
ADD CONSTRAINT "GroupMembership_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "Group"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal"
ADD CONSTRAINT "Goal_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "Group"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawSubmission"
ADD CONSTRAINT "RawSubmission_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "Group"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawSubmission"
ADD CONSTRAINT "RawSubmission_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawSubmission"
ADD CONSTRAINT "RawSubmission_identityId_fkey"
FOREIGN KEY ("identityId") REFERENCES "UserIdentity"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RawSubmission"
ADD CONSTRAINT "RawSubmission_goalId_fkey"
FOREIGN KEY ("goalId") REFERENCES "Goal"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAsset"
ADD CONSTRAINT "SubmissionAsset_rawSubmissionId_fkey"
FOREIGN KEY ("rawSubmissionId") REFERENCES "RawSubmission"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord"
ADD CONSTRAINT "CheckInRecord_groupId_fkey"
FOREIGN KEY ("groupId") REFERENCES "Group"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord"
ADD CONSTRAINT "CheckInRecord_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord"
ADD CONSTRAINT "CheckInRecord_goalId_fkey"
FOREIGN KEY ("goalId") REFERENCES "Goal"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord"
ADD CONSTRAINT "CheckInRecord_rawSubmissionId_fkey"
FOREIGN KEY ("rawSubmissionId") REFERENCES "RawSubmission"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckInRecord"
ADD CONSTRAINT "CheckInRecord_rejectedByMembershipId_fkey"
FOREIGN KEY ("rejectedByMembershipId") REFERENCES "GroupMembership"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
