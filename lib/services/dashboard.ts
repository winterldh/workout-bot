import { CheckInRecordStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';

export async function getDashboardSummary(input: {
  workspaceId?: string;
  channelId?: string;
}) {
  const integration =
    input.workspaceId && input.channelId
      ? await prisma.slackIntegration.findUnique({
          where: {
            workspaceId_channelId: {
              workspaceId: input.workspaceId,
              channelId: input.channelId,
            },
          },
          include: { group: true, goal: true },
        })
      : await prisma.slackIntegration.findFirst({
          include: { group: true, goal: true },
          orderBy: { createdAt: 'asc' },
        });

  if (!integration) {
    return {
      configured: false,
      summary: {
        totalCheckIns: 0,
        memberCount: 0,
        recentCheckIns: [],
      },
    };
  }

  const [memberCount, totalCheckIns, recentCheckIns] = await Promise.all([
    prisma.groupMembership.count({ where: { groupId: integration.groupId } }),
    prisma.checkInRecord.count({
      where: {
        goalId: integration.goalId,
        status: CheckInRecordStatus.APPROVED,
      },
    }),
    prisma.checkInRecord.findMany({
      where: {
        goalId: integration.goalId,
        status: CheckInRecordStatus.APPROVED,
      },
      include: {
        user: true,
        rawSubmission: {
          include: {
            assets: {
              take: 1,
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
      orderBy: { recordAt: 'desc' },
      take: 10,
    }),
  ]);

  return {
    configured: true,
    integration: {
      workspaceId: integration.workspaceId,
      channelId: integration.channelId,
      groupName: integration.group.name,
      goalRoomName: integration.goal.title,
    },
    summary: {
      totalCheckIns,
      memberCount,
      recentCheckIns: recentCheckIns.map((checkIn) => ({
        id: checkIn.id,
        displayName: checkIn.user.displayName,
        checkedAt: checkIn.recordAt,
        imageUrl:
          checkIn.rawSubmission?.assets[0]?.blobUrl ??
          checkIn.rawSubmission?.assets[0]?.originalUrl ??
          null,
        note: checkIn.note,
      })),
    },
  };
}
