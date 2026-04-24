import { CheckInRecordStatus, IdentityProvider } from '@prisma/client';
import { getWeekRange } from '@/lib/domain/date';
import { prisma } from '@/lib/prisma';

export async function getCurrentStatus(input: {
  workspaceId: string;
  channelId: string;
  externalSlackId: string;
  now?: Date;
}) {
  const integration = await prisma.slackIntegration.findUnique({
    where: {
      workspaceId_channelId: {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
      },
    },
    include: { group: true, goal: true },
  });

  if (!integration) {
    return null;
  }

  const range = getWeekRange(input.now ?? new Date(), integration.group.timezone);

  const checkIns = await prisma.checkInRecord.findMany({
    where: {
      goalId: integration.goalId,
      status: CheckInRecordStatus.APPROVED,
      recordDate: { gte: range.startDate, lte: range.endDate },
    },
    select: {
      userId: true,
      user: { select: { displayName: true } },
    },
    orderBy: [{ recordDate: 'asc' }, { createdAt: 'asc' }],
  });

  const meIdentity = await prisma.userIdentity.findUnique({
    where: {
      provider_providerUserId_providerWorkspaceId: {
        provider: IdentityProvider.SLACK,
        providerUserId: input.externalSlackId,
        providerWorkspaceId: input.workspaceId,
      },
    },
    select: {
      userId: true,
      user: { select: { displayName: true } },
    },
  });

  const memberships = await prisma.groupMembership.findMany({
    where: { groupId: integration.groupId },
    select: {
      userId: true,
      user: { select: { displayName: true } },
    },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  });

  const counts = new Map<string, { displayName: string; count: number }>();
  for (const checkIn of checkIns) {
    const current = counts.get(checkIn.userId) ?? {
      displayName: checkIn.user.displayName,
      count: 0,
    };
    current.count += 1;
    counts.set(checkIn.userId, current);
  }

  const ranking = memberships
    .map((membership) => {
      const count = counts.get(membership.userId)?.count ?? 0;
      return {
        userId: membership.userId,
        displayName: membership.user.displayName,
        count,
        targetCount: integration.goal.targetCount,
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.displayName.localeCompare(right.displayName),
    );

  const myRank = ranking.findIndex((entry) => entry.userId === meIdentity?.userId);

  return {
    groupName: integration.group.name,
    goalTitle: integration.goal.title,
    targetCount: integration.goal.targetCount,
    totalCheckIns: checkIns.length,
    participantCount: ranking.filter((entry) => entry.count > 0).length,
    ranking,
    me: meIdentity
      ? {
          displayName: meIdentity.user.displayName,
          count: ranking[myRank]?.count ?? 0,
          rank: myRank >= 0 ? myRank + 1 : null,
        }
      : null,
  };
}

export function formatProgressBar(count: number, targetCount: number) {
  const safeTargetCount = Math.max(0, targetCount);
  const safeCount = Math.max(0, count);
  const filled = Math.min(safeCount, safeTargetCount);
  const empty = Math.max(safeTargetCount - filled, 0);
  const bar = `${'◼︎'.repeat(filled)}${'◻︎'.repeat(empty)}`;
  return safeTargetCount > 0 && safeCount >= safeTargetCount ? `${bar} 달성!` : bar;
}

export function buildGoalInfoText(input: {
  goalTitle: string;
  targetCount: number;
  penaltyText?: string;
}) {
  const lines = [`현재 목표: ${input.goalTitle}`];
  lines.push(`미달성 시 패널티: ${input.penaltyText ?? '없음'}`);
  return lines.join('\n');
}

export function buildHelpText() {
  return [
    '사용 방법',
    '',
    '@봇',
    '@봇 닉네임 설정 홍길동',
    '@봇 인증 + 이미지',
    '@봇 변경 + 이미지',
    '@봇 목표확인',
    '@봇 현황',
  ].join('\n');
}

export function buildGoalConfirmText(input: {
  goalTitle: string;
  targetCount: number;
  penaltyText?: string;
  displayName: string;
  count: number;
}) {
  const remaining = Math.max(input.targetCount - input.count, 0);
  return [
    buildGoalInfoText(input),
    '',
    `${input.displayName}님 이번 주`,
    formatProgressLine(input.count, input.targetCount),
    '',
    remaining > 0 ? `목표까지 ${remaining}회 남았어요 💪` : '목표 달성했어요 🎉',
  ].join('\n');
}

export function buildThreadStatusText(input: Awaited<ReturnType<typeof getCurrentStatus>>) {
  if (!input) {
    return '이 채널은 아직 인증 채널로 연결되지 않았어요.';
  }

  const lines = ['📊 현재 인증 현황', ''];
  if (input.ranking.length === 0) {
    lines.push('아직 참여자가 없어요');
    return lines.join('\n');
  }

  input.ranking.forEach((entry) => {
    lines.push(`${entry.displayName}  ${formatProgressLine(entry.count, entry.targetCount)}`);
  });

  return lines.join('\n');
}

export function buildChannelStatusText(input: Awaited<ReturnType<typeof getCurrentStatus>>) {
  if (!input) {
    return '이 채널은 아직 인증 채널로 연결되지 않았어요.';
  }

  const lines = ['📊 이번 주 운동 인증 현황', ''];
  if (input.ranking.length === 0) {
    lines.push('아직 참여자가 없어요');
    return lines.join('\n');
  }

  input.ranking.forEach((entry) => {
    lines.push(`${entry.displayName}  ${formatProgressLine(entry.count, entry.targetCount)}`);
  });

  return lines.join('\n');
}

export function formatProgressLine(count: number, targetCount: number) {
  const progressBar = formatProgressBar(count, targetCount);
  return count >= targetCount && targetCount > 0
    ? progressBar
    : `${progressBar} ${count}/${targetCount}`;
}

export async function buildStatusText(input: {
  workspaceId: string;
  channelId: string;
  externalSlackId: string;
  now?: Date;
}) {
  return buildThreadStatusText(await getCurrentStatus(input));
}
