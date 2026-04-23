CREATE TYPE "WeeklyReportRunStatus" AS ENUM ('RUNNING', 'SENT', 'FAILED', 'SKIPPED');

CREATE TABLE "WeeklyReportRun" (
  "id" TEXT NOT NULL,
  "runKey" TEXT NOT NULL,
  "status" "WeeklyReportRunStatus" NOT NULL DEFAULT 'RUNNING',
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WeeklyReportRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WeeklyReportRun_runKey_key" ON "WeeklyReportRun"("runKey");
