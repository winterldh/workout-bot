import { IdentityProvider, MembershipRole, Prisma } from '@prisma/client';

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
