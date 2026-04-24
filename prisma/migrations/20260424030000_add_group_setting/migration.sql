-- CreateTable
CREATE TABLE "GroupSetting" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "weeklyPenaltyText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GroupSetting_groupId_key" ON "GroupSetting"("groupId");

-- AddForeignKey
ALTER TABLE "GroupSetting" ADD CONSTRAINT "GroupSetting_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
