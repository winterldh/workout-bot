import { CheckInRecordStatus, IdentityProvider } from '@prisma/client';
import { getWeekRange } from '@/lib/domain/date';
import { prisma } from '@/lib/prisma';
import { fetchSlackUserProfile } from '@/lib/slack/client';

export async function getCurrentStatus(input: {
  workspaceId: string;
  channelId: string;
  externalSlackId: string;
  externalSlackUsername?: string;
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

  await syncRequesterFallbackName(input);
  await syncSlackMemberDisplayNames({
    workspaceId: input.workspaceId,
    groupId: integration.groupId,
    token: process.env.SLACK_BOT_TOKEN ?? integration.botToken ?? undefined,
  });

  const range = getWeekRange(input.now ?? new Date(), integration.group.timezone);

  const [checkIns, meIdentity, memberships] = await Promise.all([
    prisma.checkInRecord.findMany({
      where: {
        goalId: integration.goalId,
        status: CheckInRecordStatus.APPROVED,
        recordDate: { gte: range.startDate, lte: range.endDate },
      },
      include: { user: true },
      orderBy: [{ recordDate: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.userIdentity.findUnique({
      where: {
        provider_providerUserId_providerWorkspaceId: {
          provider: IdentityProvider.SLACK,
          providerUserId: input.externalSlackId,
          providerWorkspaceId: input.workspaceId,
        },
      },
      include: { user: true },
    }),
    prisma.groupMembership.findMany({
      where: { groupId: integration.groupId },
      include: {
        user: {
          include: {
            identities: {
              where: {
                provider: IdentityProvider.SLACK,
                providerWorkspaceId: input.workspaceId,
              },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
    }),
  ]);

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
      const slackIdentity = membership.user.identities[0];
      const fallbackDisplayName =
        membership.user.displayName.startsWith('slack-') &&
        slackIdentity?.providerUsername?.trim()
          ? slackIdentity.providerUsername.trim()
          : membership.user.displayName;

      return {
        userId: membership.userId,
        displayName: fallbackDisplayName,
        count: counts.get(membership.userId)?.count ?? 0,
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

export async function buildStatusText(input: {
  workspaceId: string;
  channelId: string;
  externalSlackId: string;
  externalSlackUsername?: string;
}) {
  const status = await getCurrentStatus(input);
  if (!status) {
    return '이 채널은 아직 인증 채널로 연결되지 않았어요.';
  }

  const lines = ['이번 주 운동 현황'];
  if (status.ranking.length === 0) {
    lines.push('', '아직 참여자가 없어요');
    return lines.join('\n');
  }

  status.ranking.forEach((entry) => {
    lines.push(`${entry.displayName} ${entry.count} / ${entry.targetCount}`);
  });

  return lines.join('\n');
}

async function syncRequesterFallbackName(input: {
  workspaceId: string;
  externalSlackId: string;
  externalSlackUsername?: string;
}) {
  const username = input.externalSlackUsername?.trim();
  if (!username) {
    return;
  }

  const identity = await prisma.userIdentity.findUnique({
    where: {
      provider_providerUserId_providerWorkspaceId: {
        provider: IdentityProvider.SLACK,
        providerUserId: input.externalSlackId,
        providerWorkspaceId: input.workspaceId,
      },
    },
    include: { user: true },
  });

  if (!identity) {
    return;
  }

  const shouldUpdateDisplayName =
    !identity.user.displayName.trim() ||
    identity.user.displayName.startsWith('slack-');
  const shouldUpdateUsername = identity.providerUsername !== username;

  if (!shouldUpdateDisplayName && !shouldUpdateUsername) {
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (shouldUpdateDisplayName) {
      await tx.user.update({
        where: { id: identity.userId },
        data: { displayName: username },
      });
    }

    if (shouldUpdateUsername) {
      await tx.userIdentity.update({
        where: { id: identity.id },
        data: { providerUsername: username },
      });
    }
  });
}

async function syncSlackMemberDisplayNames(input: {
  workspaceId: string;
  groupId: string;
  token?: string;
}) {
  if (!input.token) {
    return;
  }

  const identities = await prisma.userIdentity.findMany({
    where: {
      provider: IdentityProvider.SLACK,
      providerWorkspaceId: input.workspaceId,
      user: {
        memberships: {
          some: { groupId: input.groupId },
        },
      },
    },
    include: { user: true },
  });

  for (const identity of identities) {
    const profile = await fetchSlackUserProfile({
      token: input.token,
      userId: identity.providerUserId,
      fallbackDisplayName: identity.user.displayName,
      fallbackUsername: identity.providerUsername ?? undefined,
    });

    if (
      profile.displayName !== identity.user.displayName ||
      profile.providerUsername !== (identity.providerUsername ?? undefined)
    ) {
      await prisma.$transaction([
        prisma.user.update({
          where: { id: identity.userId },
          data: { displayName: profile.displayName },
        }),
        prisma.userIdentity.update({
          where: { id: identity.id },
          data: { providerUsername: profile.providerUsername },
        }),
      ]);
    }
  }
}
