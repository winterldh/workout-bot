import {
  GoalPeriodUnit,
  GoalStatus,
  IdentityProvider,
  PrismaClient,
} from '@prisma/client';
import { TestEnv } from './test-env';

function startOfTodayUtc() {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function addUtcDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export async function resetTestDatabase(prisma: PrismaClient) {
  await prisma.slackChangeCandidate.deleteMany();
  await prisma.slackIntegration.deleteMany();
  await prisma.checkInRecord.deleteMany();
  await prisma.submissionAsset.deleteMany();
  await prisma.rawSubmission.deleteMany();
  await prisma.userIdentity.deleteMany();
  await prisma.groupMembership.deleteMany();
  await prisma.goal.deleteMany();
  await prisma.group.deleteMany();
  await prisma.user.deleteMany();
}

export async function bootstrapDefaultSlackIntegration(
  prisma: PrismaClient,
  env: TestEnv,
) {
  const owner = await prisma.user.create({
    data: {
      displayName: 'MVP 운영봇',
    },
  });

  const group = await prisma.group.create({
    data: {
      slug: env.groupSlug,
      name: env.groupName,
      timezone: env.groupTimezone,
      creatorUserId: owner.id,
    },
  });

  const today = startOfTodayUtc();
  const goal = await prisma.goal.create({
    data: {
      groupId: group.id,
      title: env.goalTitle,
      status: GoalStatus.ACTIVE,
      startsAt: addUtcDays(today, -7),
      endsAt: addUtcDays(today, 28),
      targetCount: 7,
      periodUnit: GoalPeriodUnit.DAY,
      periodValue: 7,
    },
  });

  const integration = await prisma.slackIntegration.create({
    data: {
      groupId: group.id,
      goalId: goal.id,
      workspaceId: env.workspaceId,
      channelId: env.channelId,
      botToken: env.slackBotToken,
      signingSecret: env.slackSigningSecret,
      autoJoinOnFirstCheckIn: true,
    },
  });

  return {
    owner,
    group,
    goal,
    integration,
  };
}

export async function ensureOperationalSlackIntegration(
  prisma: PrismaClient,
  env: TestEnv,
) {
  let group = await prisma.group.findUnique({
    where: {
      slug: env.groupSlug,
    },
  });

  if (!group) {
    const owner = await prisma.user.create({
      data: {
        displayName: 'MVP 운영봇',
      },
    });

    group = await prisma.group.create({
      data: {
        slug: env.groupSlug,
        name: env.groupName,
        timezone: env.groupTimezone,
        creatorUserId: owner.id,
      },
    });
  } else {
    group = await prisma.group.update({
      where: {
        id: group.id,
      },
      data: {
        name: env.groupName,
        timezone: env.groupTimezone,
      },
    });
  }

  const today = startOfTodayUtc();
  const existingGoal = await prisma.goal.findFirst({
    where: {
      groupId: group.id,
      title: env.goalTitle,
      status: GoalStatus.ACTIVE,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  const goal = existingGoal
    ? await prisma.goal.update({
        where: {
          id: existingGoal.id,
        },
        data: {
          title: env.goalTitle,
          status: GoalStatus.ACTIVE,
          startsAt: addUtcDays(today, -7),
          endsAt: addUtcDays(today, 28),
        },
      })
    : await prisma.goal.create({
        data: {
          groupId: group.id,
          title: env.goalTitle,
          status: GoalStatus.ACTIVE,
          startsAt: addUtcDays(today, -7),
          endsAt: addUtcDays(today, 28),
          targetCount: 7,
          periodUnit: GoalPeriodUnit.DAY,
          periodValue: 7,
        },
      });

  const integration = await prisma.slackIntegration.upsert({
    where: {
      workspaceId_channelId: {
        workspaceId: env.workspaceId,
        channelId: env.channelId,
      },
    },
    create: {
      groupId: group.id,
      goalId: goal.id,
      workspaceId: env.workspaceId,
      channelId: env.channelId,
      botToken: env.slackBotToken,
      signingSecret: env.slackSigningSecret,
      autoJoinOnFirstCheckIn: true,
    },
    update: {
      groupId: group.id,
      goalId: goal.id,
      botToken: env.slackBotToken,
      signingSecret: env.slackSigningSecret,
      autoJoinOnFirstCheckIn: true,
    },
  });

  return {
    group,
    goal,
    integration,
  };
}

export async function resetScenarioFixtureData(
  prisma: PrismaClient,
  env: TestEnv,
) {
  const group = await prisma.group.findUnique({
    where: {
      slug: env.groupSlug,
    },
  });

  if (!group) {
    await prisma.slackIntegration.deleteMany({
      where: {
        workspaceId: env.workspaceId,
        channelId: env.channelId,
      },
    });
    await prisma.slackChangeCandidate.deleteMany({
      where: {
        workspaceId: env.workspaceId,
        channelId: env.channelId,
      },
    });
    return;
  }

  const memberships = await prisma.groupMembership.findMany({
    where: {
      groupId: group.id,
    },
    select: {
      userId: true,
    },
  });

  const userIds = memberships.map((membership) => membership.userId);
  const goalIds = (
    await prisma.goal.findMany({
      where: {
        groupId: group.id,
      },
      select: {
        id: true,
      },
    })
  ).map((goal) => goal.id);

  await prisma.slackChangeCandidate.deleteMany({
    where: {
      groupId: group.id,
    },
  });
  await prisma.checkInRecord.deleteMany({
    where: {
      groupId: group.id,
    },
  });
  await prisma.submissionAsset.deleteMany({
    where: {
      rawSubmission: {
        groupId: group.id,
      },
    },
  });
  await prisma.rawSubmission.deleteMany({
    where: {
      groupId: group.id,
    },
  });
  await prisma.slackIntegration.deleteMany({
    where: {
      groupId: group.id,
    },
  });
  await prisma.groupMembership.deleteMany({
    where: {
      groupId: group.id,
    },
  });

  if (goalIds.length > 0) {
    await prisma.goal.deleteMany({
      where: {
        id: {
          in: goalIds,
        },
      },
    });
  }

  await prisma.group.delete({
    where: {
      id: group.id,
    },
  });

  if (userIds.length > 0) {
    await prisma.userIdentity.deleteMany({
      where: {
        userId: {
          in: userIds,
        },
        providerWorkspaceId: env.workspaceId,
      },
    });
    await prisma.user.deleteMany({
      where: {
        id: {
          in: userIds,
        },
      },
    });
  }
}

export async function prepareSlackFixtureDatabase(
  prisma: PrismaClient,
  env: TestEnv,
) {
  await resetTestDatabase(prisma);
  return bootstrapDefaultSlackIntegration(prisma, env);
}

export async function findSlackIdentity(
  prisma: PrismaClient,
  input: { workspaceId: string; externalSlackId: string },
) {
  return prisma.userIdentity.findUnique({
    where: {
      provider_providerUserId_providerWorkspaceId: {
        provider: IdentityProvider.SLACK,
        providerUserId: input.externalSlackId,
        providerWorkspaceId: input.workspaceId,
      },
    },
    include: {
      user: true,
    },
  });
}
