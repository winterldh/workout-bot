import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { buildWeeklyReportText } from '@/lib/services/reports';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const workspaceId =
    searchParams.get('workspaceId') ?? process.env.ALLOWED_SLACK_WORKSPACE_ID;
  const channelId =
    searchParams.get('channelId') ?? process.env.ALLOWED_SLACK_CHANNEL_ID;

  const integration =
    workspaceId && channelId
      ? await prisma.slackIntegration.findUnique({
          where: {
            workspaceId_channelId: { workspaceId, channelId },
          },
          include: { group: true },
        })
      : await prisma.slackIntegration.findFirst({
          include: { group: true },
          orderBy: { createdAt: 'asc' },
        });

  if (!integration) {
    return NextResponse.json({ configured: false, text: '' });
  }

  const text = await buildWeeklyReportText({
    groupId: integration.groupId,
    goalId: integration.goalId,
    timeZone: integration.group.timezone,
    now: new Date(),
  });

  return NextResponse.json({ configured: true, text });
}
