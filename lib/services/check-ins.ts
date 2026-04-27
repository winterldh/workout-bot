import {
  CheckInRecordStatus,
  MembershipRole,
  SubmissionAssetKind,
  SubmissionAssetStatus,
  SubmissionSourceType,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import {
  formatDateKey,
  normalizeRecordDate,
  normalizeRecordDateToKst,
} from '@/lib/domain/date';
import { logEvent } from '@/lib/observability/logger';
import { getSlackRegistrationState } from '@/lib/services/users';

type SlackCheckInPhotoInput = {
  blobUrl?: string | null;
  slackOriginalUrl?: string | null;
  mimeType?: string;
  storageKey?: string;
  uploadFailed?: boolean;
};

export async function createFromSlackMessage(input: {
  externalSlackId: string;
  displayName: string;
  providerUsername?: string;
  workspaceId: string;
  channelId: string;
  sourceMessageId: string;
  photo?: SlackCheckInPhotoInput;
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

  const registrationState = await getSlackRegistrationState({
    db: prisma,
    workspaceId: input.workspaceId,
    externalSlackId: input.externalSlackId,
    groupId: integration.groupId,
  });

  if (!registrationState.isRegistered || !registrationState.user || !registrationState.identity) {
    return {
      status: 'registration_required' as const,
      userCreated: false,
      membershipCreated: false,
      candidateSaved: false,
    };
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
    const user = registrationState.user!;
    const identity = registrationState.identity!;

    const existingMembership = await tx.groupMembership.findUnique({
      where: {
        userId_groupId: {
          userId: user.id,
          groupId: integration.groupId,
        },
      },
    });

    if (!existingMembership) {
      await tx.groupMembership.create({
        data: {
          userId: user.id,
          groupId: integration.groupId,
          role: MembershipRole.MEMBER,
        },
      });
    }

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
        userCreated: false,
        membershipCreated: !existingMembership,
        checkInId: existingSubmission.checkInRecords[0]?.id,
        candidateSaved: false,
      };
    }

    const duplicateRecord = await tx.checkInRecord.findUnique({
      where: {
        goalId_userId_recordDate: {
          goalId: integration.goalId,
          userId: user.id,
          recordDate: normalizedRecordDate,
        },
      },
    });

    if (duplicateRecord) {
      let candidateId: string | undefined;
      let candidateSaved = false;

      if (input.photo && input.allowChangeCandidateOnDuplicate !== false) {
        const candidateBlobUrl = input.photo.blobUrl ?? input.photo.slackOriginalUrl ?? null;
        const candidateOriginalUrl = input.photo.slackOriginalUrl ?? candidateBlobUrl;
        const candidate = await tx.slackChangeCandidate.upsert({
          where: {
            workspaceId_channelId_userId_recordDate: {
              workspaceId: input.workspaceId,
              channelId: input.channelId,
              userId: user.id,
              recordDate: normalizedRecordDate,
            },
          },
          create: {
            groupId: integration.groupId,
            goalId: integration.goalId,
            userId: user.id,
            workspaceId: input.workspaceId,
            channelId: input.channelId,
            recordDate: normalizedRecordDate,
            sourceMessageId: input.sourceMessageId,
            imageUrl: candidateBlobUrl ?? '',
            blobUrl: candidateBlobUrl,
            originalPhotoUrl: candidateOriginalUrl,
            slackOriginalUrl: candidateOriginalUrl,
            submittedAt: input.checkedAt,
            note: input.note,
          },
          update: {
            sourceMessageId: input.sourceMessageId,
            imageUrl: candidateBlobUrl ?? '',
            blobUrl: candidateBlobUrl,
            originalPhotoUrl: candidateOriginalUrl,
            slackOriginalUrl: candidateOriginalUrl,
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
          slackUserId: user.id,
          candidateId,
        });
      }

      return {
        status: 'duplicate' as const,
        userCreated: false,
        membershipCreated: !existingMembership,
        checkInId: duplicateRecord.id,
        candidateSaved,
        candidateId,
      };
    }

    const submissionBlobUrl = input.photo?.blobUrl ?? input.photo?.slackOriginalUrl ?? null;
    const submissionOriginalUrl = input.photo?.slackOriginalUrl ?? submissionBlobUrl;

    const rawSubmission = await tx.rawSubmission.create({
      data: {
        groupId: integration.groupId,
        userId: user.id,
        goalId: integration.goalId,
        identityId: identity.id,
        sourceType: SubmissionSourceType.SLACK,
        externalSubmissionId: input.sourceMessageId,
        submittedAt: input.checkedAt,
        note: input.note,
        rawPayload: {
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          sourceMessageId: input.sourceMessageId,
          photo: input.photo
            ? {
                blobUrl: input.photo.blobUrl ?? null,
                slackOriginalUrl: input.photo.slackOriginalUrl ?? null,
                mimeType: input.photo.mimeType ?? null,
                storageKey: input.photo.storageKey ?? null,
                uploadFailed: Boolean(input.photo.uploadFailed),
              }
            : null,
          assetStatus: input.photo
            ? input.photo.uploadFailed
              ? 'ASSET_FAILED'
              : input.photo.blobUrl
                ? 'ASSET_SAVED'
                : 'PENDING'
            : null,
        },
      },
    });

    let submissionAssetId: string | undefined;
    if (input.photo) {
    const submissionAssetStatus = input.photo?.uploadFailed
      ? SubmissionAssetStatus.ASSET_FAILED
      : input.photo?.blobUrl
        ? SubmissionAssetStatus.ASSET_SAVED
        : SubmissionAssetStatus.PENDING;

    const submissionAsset = await tx.submissionAsset.create({
        data: {
          rawSubmissionId: rawSubmission.id,
          kind: SubmissionAssetKind.IMAGE,
          mimeType: input.photo.mimeType ?? 'image/jpeg',
          originalUrl: submissionBlobUrl,
          blobUrl: input.photo.uploadFailed ? null : input.photo.blobUrl ?? null,
          assetStatus: submissionAssetStatus,
          assetRetryCount: 0,
          assetLastError: input.photo.uploadFailed ? 'asset_upload_failed' : null,
          assetLockedAt: null,
          assetProcessedAt: input.photo?.blobUrl ? new Date() : null,
          assetNextRetryAt: null,
          originalPhotoUrl: submissionOriginalUrl,
          slackOriginalUrl: submissionOriginalUrl,
          storageKey: input.photo.storageKey,
          metadata: input.photo.uploadFailed
            ? { blobUploadFailed: true, blobStatus: 'failed' }
            : { blobStatus: input.photo.blobUrl ? 'done' : 'pending' },
        },
        select: { id: true },
      });
      submissionAssetId = submissionAsset.id;
    }

    const checkIn = await tx.checkInRecord.create({
      data: {
        groupId: integration.groupId,
        userId: user.id,
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
        userId: user.id,
        recordDate: normalizedRecordDate,
      },
    });

    return {
      status: 'accepted' as const,
      userCreated: false,
      membershipCreated: !existingMembership,
      checkInId: checkIn.id,
      rawSubmissionId: rawSubmission.id,
      submissionAssetId,
      candidateSaved: false,
    };
  });
}

export async function updateSlackSubmissionAsset(input: {
  rawSubmissionId: string;
  blobUrl: string | null;
  storageKey?: string;
  uploadFailed?: boolean;
  mimeType?: string | null;
  slackOriginalUrl?: string | null;
  assetStatus?: SubmissionAssetStatus;
  assetRetryCount?: number;
  assetLastError?: string | null;
  assetLockedAt?: Date | null;
  assetProcessedAt?: Date | null;
  assetNextRetryAt?: Date | null;
}) {
  const resolvedAssetStatus = input.blobUrl
    ? SubmissionAssetStatus.ASSET_SAVED
    : SubmissionAssetStatus.ASSET_FAILED;

  const updated = await prisma.submissionAsset.updateMany({
    where: {
      rawSubmissionId: input.rawSubmissionId,
    },
    data: {
      blobUrl: input.blobUrl,
      storageKey: input.storageKey ?? undefined,
      mimeType: input.mimeType ?? undefined,
      originalUrl: input.blobUrl ?? input.slackOriginalUrl ?? undefined,
      originalPhotoUrl: input.slackOriginalUrl ?? input.blobUrl ?? undefined,
      slackOriginalUrl: input.slackOriginalUrl ?? input.blobUrl ?? undefined,
      assetStatus: resolvedAssetStatus,
      assetRetryCount: input.assetRetryCount ?? undefined,
      assetLastError:
        input.assetLastError ??
        (input.blobUrl ? null : input.uploadFailed ? 'asset_upload_failed' : 'missing_public_image_url'),
      assetLockedAt: input.assetLockedAt ?? null,
      assetProcessedAt:
        input.assetProcessedAt ??
        (input.blobUrl ? new Date() : undefined),
      assetNextRetryAt: input.assetNextRetryAt ?? undefined,
      metadata: input.uploadFailed
        ? { blobUploadFailed: true, blobStatus: 'failed' }
        : input.blobUrl
          ? { blobStatus: 'done' }
          : { blobStatus: 'pending' },
    },
  });

  return updated;
}

export async function updateSlackChangeCandidateAsset(input: {
  candidateId: string;
  blobUrl: string | null;
  uploadFailed?: boolean;
  mimeType?: string | null;
  slackOriginalUrl?: string | null;
}) {
  return prisma.slackChangeCandidate.update({
    where: {
      id: input.candidateId,
    },
    data: {
      blobUrl: input.blobUrl,
      imageUrl: input.blobUrl ?? input.slackOriginalUrl ?? '',
      originalPhotoUrl: input.slackOriginalUrl ?? input.blobUrl ?? undefined,
      slackOriginalUrl: input.slackOriginalUrl ?? input.blobUrl ?? undefined,
    },
    select: {
      id: true,
    },
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
