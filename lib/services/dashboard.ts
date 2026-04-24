import { CheckInRecordStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logEvent } from '@/lib/observability/logger';

export async function getDashboardSummary(input: {
  workspaceId?: string;
  channelId?: string;
}) {
  try {
    const integration =
      input.workspaceId && input.channelId
        ? await prisma.slackIntegration.findUnique({
            where: {
              workspaceId_channelId: {
                workspaceId: input.workspaceId,
                channelId: input.channelId,
              },
            },
            select: {
              id: true,
              workspaceId: true,
              channelId: true,
              groupId: true,
              goalId: true,
              group: {
                select: {
                  name: true,
                },
              },
              goal: {
                select: {
                  title: true,
                },
              },
            },
          })
        : await prisma.slackIntegration.findFirst({
            select: {
              id: true,
              workspaceId: true,
              channelId: true,
              groupId: true,
              goalId: true,
              group: {
                select: {
                  name: true,
                },
              },
              goal: {
                select: {
                  title: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          });

    if (!integration) {
      return buildDashboardFallback(false);
    }

    const memberCount = await prisma.groupMembership.count({
      where: { groupId: integration.groupId },
    });

    const totalCheckIns = await prisma.checkInRecord.count({
      where: {
        goalId: integration.goalId,
        status: CheckInRecordStatus.APPROVED,
      },
    });

    const recentCheckIns = await prisma.checkInRecord.findMany({
      where: {
        goalId: integration.goalId,
        status: CheckInRecordStatus.APPROVED,
      },
      select: {
        id: true,
        recordAt: true,
        note: true,
        user: {
          select: {
            displayName: true,
          },
        },
      },
      orderBy: { recordAt: 'desc' },
      take: 10,
    });

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
          imageUrl: null,
          note: checkIn.note,
        })),
      },
    };
  } catch (error) {
    logEvent('error', 'dashboard_load_failed', {
      event: 'dashboard_load_failed',
      stage: 'getDashboardSummary',
      reason: error instanceof Error ? error.message : String(error),
    });
    return buildDashboardFallback(true);
  }
}

function buildDashboardFallback(configured: boolean) {
  return {
    configured,
    integration: configured
      ? undefined
      : {
          workspaceId: '',
          channelId: '',
          groupName: '확인 필요',
          goalRoomName: '확인 필요',
        },
    summary: {
      totalCheckIns: 0,
      memberCount: 0,
      recentCheckIns: [],
    },
  };
}
