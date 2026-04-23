-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'LOCKED');

-- AlterTable
ALTER TABLE "Goal"
ADD COLUMN "status" "GoalStatus" NOT NULL DEFAULT 'DRAFT';

-- CreateIndex
CREATE INDEX "Goal_groupId_status_idx" ON "Goal"("groupId", "status");

-- Deduplicate legacy normalized records before enforcing per-day uniqueness
DELETE FROM "CheckInRecord"
WHERE "id" IN (
  SELECT "id"
  FROM (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "goalId", "userId", "recordDate"
        ORDER BY "createdAt" ASC, "id" ASC
      ) AS row_num
    FROM "CheckInRecord"
  ) ranked
  WHERE ranked.row_num > 1
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckInRecord_goalId_userId_recordDate_key"
ON "CheckInRecord"("goalId", "userId", "recordDate");
