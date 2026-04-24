import {
  CheckInRecordStatus,
  SubmissionAssetKind,
  SubmissionSourceType,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  formatDateKey,
  normalizeRecordDate,
  normalizeRecordDateToKst,
} from '@/lib/domain/date';
import { logEvent } from '@/lib/observability/logger';
import { ensureSlackUserMembership } from '@/lib/services/users';

export async function createFromSlackMessage(input: {
  externalSlackId: string;
  displayName: string;
  providerUsername?: string;
  workspaceId: string;
  channelId: string;
  sourceMessageId: string;
  photo?: {
    blobUrl: string;
    slackOriginalUrl: string;
    mimeType?: string;
    storageKey?: string;
    uploadFailed?: boolean;
  };
  note?: string;
  checkedAt: Date;
  allowChangeCandidateOnDuplicate?: boolean;
  context?: {
    requestId?: string;
    eventId?: string;
    slackUserId?: string;
    workspaceId?: string;
    channelId?: string;
    groupId?: string;
    goalId?: string;
  };
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
    return { status: 'ignored' as const, userCreated: false, membershipCreated: false, candidateSaved: false };
  }

  const normalizedRecordDate = normalizeRecordDate(input.checkedAt, integration.group.timezone);
  logEvent('info', 'checkin.record_date_normalized', {
    eventType: 'slack_checkin',
    ...input.context,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    groupId: integration.groupId,
    goalId: integration.goalId,
    slackUserId: input.externalSlackId,
    recordDateKey: formatDateKey(input.checkedAt, integration.group.timezone),
    recordDate: normalizedRecordDate.toISOString(),
    recordDateKst: normalizeRecordDateToKst(input.checkedAt).toISOString(),
  });

  return prisma.$transaction(async (tx) => {
    const ensured = await ensureSlackUserMembership({
      tx,
      workspaceId: input.workspaceId,
      externalSlackId: input.externalSlackId,
      displayName: input.displayName,
      providerUsername: input.providerUsername,
      groupId: integration.groupId,
    });

    const existingSubmission = await tx.rawSubmission.findUnique({
      where: {
        sourceType_externalSubmissionId: {
          sourceType: SubmissionSourceType.SLACK,
          externalSubmissionId: input.sourceMessageId,
        },
      },
      include: { checkInRecords: true },
    });

    if (existingSubmission) {
      return {
        status: 'duplicate' as const,
        userCreated: ensured.userCreated,
        membershipCreated: ensured.membershipCreated,
        checkInId: existingSubmission.checkInRecords[0]?.id,
        candidateSaved: false,
      };
    }

    const duplicateRecord = await tx.checkInRecord.findUnique({
      where: {
        goalId_userId_recordDate: {
          goalId: integration.goalId,
          userId: ensured.user.id,
          recordDate: normalizedRecordDate,
        },
      },
    });

    if (duplicateRecord) {
      let candidateId: string | undefined;
      let candidateSaved = false;

      if (input.photo && input.allowChangeCandidateOnDuplicate !== false) {
        const candidate = await tx.slackChangeCandidate.upsert({
          where: {
            workspaceId_channelId_userId_recordDate: {
              workspaceId: input.workspaceId,
              channelId: input.channelId,
              userId: ensured.user.id,
              recordDate: normalizedRecordDate,
            },
          },
          create: {
            groupId: integration.groupId,
            goalId: integration.goalId,
            userId: ensured.user.id,
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            recordDate: normalizedRecordDate,
            sourceMessageId: input.sourceMessageId,
            imageUrl: input.photo.blobUrl,
            blobUrl: input.photo.blobUrl,
            originalPhotoUrl: input.photo.slackOriginalUrl,
            slackOriginalUrl: input.photo.slackOriginalUrl,
            submittedAt: input.checkedAt,
            note: input.note,
          },
          update: {
            sourceMessageId: input.sourceMessageId,
            imageUrl: input.photo.blobUrl,
            blobUrl: input.photo.blobUrl,
            originalPhotoUrl: input.photo.slackOriginalUrl,
            slackOriginalUrl: input.photo.slackOriginalUrl,
            submittedAt: input.checkedAt,
            note: input.note,
          },
        });
        candidateId = candidate.id;
        candidateSaved = true;
        logEvent('info', 'checkin.change_candidate_upserted', {
          eventType: 'slack_checkin',
          ...input.context,
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          slackUserId: ensured.user.id,
          candidateId,
        });
      }

      return {
        status: 'duplicate' as const,
        userCreated: ensured.userCreated,
        membershipCreated: ensured.membershipCreated,
        checkInId: duplicateRecord.id,
        candidateSaved,
        candidateId,
      };
    }

    const rawSubmission = await tx.rawSubmission.create({
      data: {
        groupId: integration.groupId,
        userId: ensured.user.id,
        goalId: integration.goalId,
        identityId: ensured.identity.id,
        sourceType: SubmissionSourceType.SLACK,
        externalSubmissionId: input.sourceMessageId,
        submittedAt: input.checkedAt,
        note: input.note,
        rawPayload: {
          workspaceId: input.workspaceId,
          channelId: input.channelId,
        },
      },
    });

    if (input.photo) {
      await tx.submissionAsset.create({
        data: {
          rawSubmissionId: rawSubmission.id,
          kind: SubmissionAssetKind.IMAGE,
          mimeType: input.photo.mimeType ?? 'image/jpeg',
          originalUrl: input.photo.blobUrl,
          blobUrl: input.photo.blobUrl,
          originalPhotoUrl: input.photo.slackOriginalUrl,
          slackOriginalUrl: input.photo.slackOriginalUrl,
          storageKey: input.photo.storageKey,
          metadata: input.photo.uploadFailed
            ? { blobUploadFailed: true }
            : undefined,
        },
      });
    }

    const checkIn = await tx.checkInRecord.create({
      data: {
        groupId: integration.groupId,
        userId: ensured.user.id,
        goalId: integration.goalId,
        rawSubmissionId: rawSubmission.id,
        status: CheckInRecordStatus.APPROVED,
        recordAt: input.checkedAt,
        recordDate: normalizedRecordDate,
        note: input.note,
      },
    });

    await tx.slackChangeCandidate.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        userId: ensured.user.id,
        recordDate: normalizedRecordDate,
      },
    });

    return {
      status: 'accepted' as const,
      userCreated: ensured.userCreated,
      membershipCreated: ensured.membershipCreated,
      checkInId: checkIn.id,
      candidateSaved: false,
    };
  });
}

export async function replaceTodayFromSlackMessage(input: {
  externalSlackId: string;
  workspaceId: string;
  channelId: string;
  checkedAt: Date;
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
    return { status: 'ignored' as const };
  }

  const normalizedRecordDate = normalizeRecordDate(input.checkedAt, integration.group.timezone);

  return prisma.$transaction(async (tx) => {
    const identity = await tx.userIdentity.findUnique({
      where: {
        provider_providerUserId_providerWorkspaceId: {
          provider: 'SLACK',
          providerUserId: input.externalSlackId,
          providerWorkspaceId: input.workspaceId,
        },
      },
    });

    if (!identity) {
      return { status: 'missing_checkin' as const };
    }

    const [candidate, existingCheckIn] = await Promise.all([
      tx.slackChangeCandidate.findUnique({
        where: {
          workspaceId_channelId_userId_recordDate: {
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            userId: identity.userId,
            recordDate: normalizedRecordDate,
          },
        },
      }),
      tx.checkInRecord.findUnique({
        where: {
          goalId_userId_recordDate: {
            goalId: integration.goalId,
            userId: identity.userId,
            recordDate: normalizedRecordDate,
          },
        },
        include: { rawSubmission: true },
      }),
    ]);

    if (!existingCheckIn?.rawSubmissionId || !existingCheckIn.rawSubmission) {
      return { status: 'missing_checkin' as const };
    }

    if (!candidate) {
      return { status: 'missing_candidate' as const };
    }

    await tx.rawSubmission.update({
      where: { id: existingCheckIn.rawSubmissionId },
      data: {
        externalSubmissionId: candidate.sourceMessageId,
        submittedAt: candidate.submittedAt,
        rawPayload: {
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          mode: 'change',
          candidateSourceMessageId: candidate.sourceMessageId,
        },
      },
    });

    await tx.submissionAsset.deleteMany({
      where: { rawSubmissionId: existingCheckIn.rawSubmissionId },
    });

    await tx.submissionAsset.create({
      data: {
        rawSubmissionId: existingCheckIn.rawSubmissionId,
        kind: SubmissionAssetKind.IMAGE,
        mimeType: 'image/jpeg',
        originalUrl: candidate.blobUrl ?? candidate.imageUrl,
        blobUrl: candidate.blobUrl ?? candidate.imageUrl,
        originalPhotoUrl: candidate.slackOriginalUrl ?? candidate.originalPhotoUrl,
        slackOriginalUrl: candidate.slackOriginalUrl ?? candidate.originalPhotoUrl,
      },
    });

    await tx.checkInRecord.update({
      where: { id: existingCheckIn.id },
      data: { recordAt: candidate.submittedAt },
    });

    await tx.slackChangeCandidate.delete({ where: { id: candidate.id } });

    return { status: 'replaced' as const, checkInId: existingCheckIn.id };
  });
}
