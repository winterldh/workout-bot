import { GoalStatus, Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';

type GroupDbClient = PrismaClient | Prisma.TransactionClient;

export type GroupRuntimeSettings = {
  activeGoal: {
    id: string;
    title: string;
    targetCount: number;
  } | null;
  weeklyPenaltyText: string | null;
};

export function formatWeeklyPenaltyDisplayText(value?: string | null) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  if (/^미달성 시\s*/.test(normalized)) {
    return normalized;
  }

  return `미달성 시 ${normalized}`;
}

export async function getGroupRuntimeSettings(input: {
  groupId: string;
  goalId?: string | null;
  db?: GroupDbClient;
}): Promise<GroupRuntimeSettings> {
  const db = input.db ?? prisma;
  const [goal, groupSetting] = await Promise.all([
    input.goalId
      ? db.goal.findUnique({
          where: { id: input.goalId },
          select: { id: true, title: true, targetCount: true, status: true },
        })
      : db.goal.findFirst({
          where: {
            groupId: input.groupId,
            status: GoalStatus.ACTIVE,
          },
          orderBy: { updatedAt: 'desc' },
          select: { id: true, title: true, targetCount: true, status: true },
        }),
    db.groupSetting.findUnique({
      where: { groupId: input.groupId },
      select: { weeklyPenaltyText: true },
    }),
  ]);

  return {
    activeGoal:
      goal && goal.status === GoalStatus.ACTIVE
        ? {
            id: goal.id,
            title: goal.title,
            targetCount: goal.targetCount,
          }
        : null,
    weeklyPenaltyText:
      groupSetting?.weeklyPenaltyText?.trim() ||
      process.env.WEEKLY_PENALTY_TEXT?.trim() ||
      null,
  };
}

export async function updateActiveGoalTargetCount(input: {
  groupId: string;
  targetCount: number;
  db?: GroupDbClient;
}) {
  const db = input.db ?? prisma;
  const activeGoal = await db.goal.findFirst({
    where: {
      groupId: input.groupId,
      status: GoalStatus.ACTIVE,
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      title: true,
      targetCount: true,
    },
  });

  if (!activeGoal) {
    return null;
  }

  return db.goal.update({
    where: { id: activeGoal.id },
    data: {
      targetCount: input.targetCount,
    },
    select: {
      id: true,
      title: true,
      targetCount: true,
    },
  });
}

export async function upsertGroupWeeklyPenaltyText(input: {
  groupId: string;
  weeklyPenaltyText: string | null;
  db?: GroupDbClient;
}) {
  const db = input.db ?? prisma;

  return db.groupSetting.upsert({
    where: {
      groupId: input.groupId,
    },
    create: {
      groupId: input.groupId,
      weeklyPenaltyText: input.weeklyPenaltyText,
    },
    update: {
      weeklyPenaltyText: input.weeklyPenaltyText,
    },
    select: {
      id: true,
      groupId: true,
      weeklyPenaltyText: true,
    },
  });
}
