import { IdentityProvider, MembershipRole, Prisma, PrismaClient } from '@prisma/client';

type SlackDbClient = Prisma.TransactionClient | PrismaClient;

export async function getSlackRegistrationState(input: {
  db: SlackDbClient;
  workspaceId: string;
  externalSlackId: string;
  groupId: string;
}) {
  const identity = await input.db.userIdentity.findUnique({
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
    return {
      isRegistered: false as const,
      identity: null,
      user: null,
      membership: null,
    };
  }

  const membership = await input.db.groupMembership.findUnique({
    where: {
      userId_groupId: {
        userId: identity.userId,
        groupId: input.groupId,
      },
    },
  });

  return {
    isRegistered: true as const,
    identity,
    user: identity.user,
    membership,
  };
}

export async function ensureSlackUserMembership(input: {
  tx: Prisma.TransactionClient;
  workspaceId: string;
  externalSlackId: string;
  displayName: string;
  providerUsername?: string;
  groupId: string;
}) {
  const existingIdentity = await input.tx.userIdentity.findUnique({
    where: {
      provider_providerUserId_providerWorkspaceId: {
        provider: IdentityProvider.SLACK,
        providerUserId: input.externalSlackId,
        providerWorkspaceId: input.workspaceId,
      },
    },
    include: { user: true },
  });

  const user = existingIdentity
    ? await input.tx.user.update({
        where: { id: existingIdentity.userId },
        data: { displayName: input.displayName },
      })
    : await input.tx.user.create({
        data: { displayName: input.displayName },
      });

  const identity = !existingIdentity
    ? await input.tx.userIdentity.create({
        data: {
          userId: user.id,
          provider: IdentityProvider.SLACK,
          providerUserId: input.externalSlackId,
          providerWorkspaceId: input.workspaceId,
          providerUsername: input.providerUsername,
        },
      })
    : existingIdentity.providerUsername !== input.providerUsername
      ? await input.tx.userIdentity.update({
          where: { id: existingIdentity.id },
          data: { providerUsername: input.providerUsername },
        })
      : existingIdentity;

  const existingMembership = await input.tx.groupMembership.findUnique({
    where: {
      userId_groupId: {
        userId: user.id,
        groupId: input.groupId,
      },
    },
  });

  if (!existingMembership) {
    await input.tx.groupMembership.create({
      data: {
        userId: user.id,
        groupId: input.groupId,
        role: MembershipRole.MEMBER,
      },
    });
  }

  return {
    user,
    identity,
    userCreated: !existingIdentity,
    membershipCreated: !existingMembership,
  };
}

export async function registerSlackUserFromCommand(input: {
  db: PrismaClient;
  workspaceId: string;
  externalSlackId: string;
  displayName: string;
  groupId: string;
}) {
  const normalizedDisplayName = input.displayName.trim();
  if (!normalizedDisplayName) {
    return {
      status: 'invalid_name' as const,
      wasRegistered: false,
      displayNameChanged: false,
      user: null,
    };
  }

  const existing = await getSlackRegistrationState({
    db: input.db,
    workspaceId: input.workspaceId,
    externalSlackId: input.externalSlackId,
    groupId: input.groupId,
  });

  if (!existing.isRegistered) {
    const created = await input.db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { displayName: normalizedDisplayName },
      });
      await tx.userIdentity.create({
        data: {
          userId: user.id,
          provider: IdentityProvider.SLACK,
          providerUserId: input.externalSlackId,
          providerWorkspaceId: input.workspaceId,
        },
      });
      await tx.groupMembership.create({
        data: {
          userId: user.id,
          groupId: input.groupId,
          role: MembershipRole.MEMBER,
        },
      });
      return user;
    });

    return {
      status: 'registered' as const,
      wasRegistered: false,
      displayNameChanged: true,
      user: created,
    };
  }

  const needsUpdate = existing.user.displayName !== normalizedDisplayName;
  if (needsUpdate) {
    await input.db.user.update({
      where: { id: existing.user.id },
      data: { displayName: normalizedDisplayName },
    });
  }

  if (!existing.membership) {
    await input.db.groupMembership.create({
      data: {
        userId: existing.user.id,
        groupId: input.groupId,
        role: MembershipRole.MEMBER,
      },
    });
  }

  return {
    status: 'renamed' as const,
    wasRegistered: true,
    displayNameChanged: needsUpdate,
    user: needsUpdate
      ? await input.db.user.findUnique({ where: { id: existing.user.id } })
      : existing.user,
  };
}

export async function renameSlackUserFromCommand(input: {
  db: PrismaClient;
  workspaceId: string;
  externalSlackId: string;
  displayName: string;
  groupId: string;
}) {
  const normalizedDisplayName = input.displayName.trim();
  if (!normalizedDisplayName) {
    return {
      status: 'invalid_name' as const,
      updated: false,
      user: null,
    };
  }

  const existing = await getSlackRegistrationState({
    db: input.db,
    workspaceId: input.workspaceId,
    externalSlackId: input.externalSlackId,
    groupId: input.groupId,
  });

  if (!existing.isRegistered) {
    return {
      status: 'missing_registration' as const,
      updated: false,
      user: null,
    };
  }

  const updated = existing.user.displayName !== normalizedDisplayName;
  if (updated) {
    await input.db.user.update({
      where: { id: existing.user.id },
      data: { displayName: normalizedDisplayName },
    });
  }

  if (!existing.membership) {
    await input.db.groupMembership.create({
      data: {
        userId: existing.user.id,
        groupId: input.groupId,
        role: MembershipRole.MEMBER,
      },
    });
  }

  return {
    status: 'renamed' as const,
    updated,
    user: updated
      ? await input.db.user.findUnique({ where: { id: existing.user.id } })
      : existing.user,
  };
}
