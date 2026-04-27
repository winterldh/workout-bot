import {
  CheckInRecordStatus,
  IdentityProvider,
  SubmissionAssetStatus,
  SubmissionSourceType,
} from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logEvent } from '@/lib/observability/logger';

type TimelineIntegration = {
  workspaceId: string;
  channelId: string;
  groupId: string;
  goalId: string;
  group: { name: string };
  goal: { title: string; targetCount: number };
};

type TimelineAsset = {
  id: string;
  blobUrl: string | null;
  assetStatus: SubmissionAssetStatus;
  assetRetryCount: number;
  assetLastError: string | null;
  assetProcessedAt: Date | null;
  createdAt: Date;
  originalPhotoUrl: string | null;
  slackOriginalUrl: string | null;
};

type TimelineRawSubmission = {
  id: string;
  submittedAt: Date;
  note: string | null;
  user: { displayName: string };
  identity: { providerUserId: string | null } | null;
  checkInRecords: Array<{
    id: string;
    status: CheckInRecordStatus;
    recordAt: Date;
    recordDate: Date;
    note: string | null;
    rejectedReason: string | null;
  }>;
  assets: TimelineAsset[];
};

type TimelineChangeCandidate = {
  id: string;
  submittedAt: Date;
  note: string | null;
  blobUrl: string | null;
  imageUrl: string;
  slackOriginalUrl: string | null;
  originalPhotoUrl: string | null;
  user: {
    displayName: string;
    identities: Array<{ providerUserId: string }>;
  };
  recordDate: Date;
};

export type CheckInTimelineItem = {
  id: string;
  kind: 'checkin' | 'duplicate' | 'rejected' | 'pending';
  displayName: string;
  slackUserId: string | null;
  checkedAt: Date;
  recordDate: Date;
  countIncluded: boolean;
  duplicate: boolean;
  rejected: boolean;
  assetStatus: SubmissionAssetStatus | 'NONE';
  imageUrl: string | null;
  imageUrlHost: string | null;
  originalPhotoUrl: string | null;
  retryCount: number;
  lastError: string | null;
  note: string | null;
  statusLabel: string;
  assetLabel: string;
  source: 'raw_submission' | 'change_candidate';
  rawSubmissionId?: string;
  candidateId?: string;
  recordId?: string;
};

export async function getCheckInTimeline(input: {
  workspaceId?: string;
  channelId?: string;
  limit?: number;
}) {
  try {
    const integration = await loadIntegration(input.workspaceId, input.channelId);

    if (!integration) {
      return buildTimelineFallback(false);
    }

    const limit = Math.max(1, Math.min(input.limit ?? 24, 50));
    const [rawSubmissions, candidates] = await Promise.all([
      prisma.rawSubmission.findMany({
        where: {
          groupId: integration.groupId,
          goalId: integration.goalId,
          sourceType: SubmissionSourceType.SLACK,
        },
        select: {
          id: true,
          submittedAt: true,
          note: true,
          user: {
            select: {
              displayName: true,
            },
          },
          identity: {
            select: {
              providerUserId: true,
            },
          },
          checkInRecords: {
            select: {
              id: true,
              status: true,
              recordAt: true,
              recordDate: true,
              note: true,
              rejectedReason: true,
            },
            orderBy: { createdAt: 'asc' },
          },
          assets: {
            select: {
              id: true,
              blobUrl: true,
              assetStatus: true,
              assetRetryCount: true,
              assetLastError: true,
              assetProcessedAt: true,
              createdAt: true,
              originalPhotoUrl: true,
              slackOriginalUrl: true,
            },
            orderBy: { createdAt: 'asc' },
          },
        },
        orderBy: { submittedAt: 'desc' },
        take: limit,
      }) as Promise<TimelineRawSubmission[]>,
      prisma.slackChangeCandidate.findMany({
        where: {
          workspaceId: integration.workspaceId,
          channelId: integration.channelId,
          goalId: integration.goalId,
        },
        select: {
          id: true,
          submittedAt: true,
          note: true,
          blobUrl: true,
          originalPhotoUrl: true,
          slackOriginalUrl: true,
          recordDate: true,
          user: {
            select: {
              displayName: true,
              identities: {
                where: {
                  provider: IdentityProvider.SLACK,
                  providerWorkspaceId: integration.workspaceId,
                },
                select: {
                  providerUserId: true,
                },
                take: 1,
              },
            },
          },
        },
        orderBy: { submittedAt: 'desc' },
        take: limit,
      }) as Promise<TimelineChangeCandidate[]>,
    ]);

    const items = [
      ...rawSubmissions.map((rawSubmission) => buildRawSubmissionItem(rawSubmission)),
      ...candidates.map((candidate) => buildChangeCandidateItem(candidate)),
    ].sort((left, right) => {
      const timeDiff = right.checkedAt.getTime() - left.checkedAt.getTime();
      if (timeDiff !== 0) {
        return timeDiff;
      }
      return right.id.localeCompare(left.id);
    });

    return {
      configured: true,
      integration: {
        workspaceId: integration.workspaceId,
        channelId: integration.channelId,
        groupName: integration.group.name,
        goalRoomName: integration.goal.title,
        targetCount: integration.goal.targetCount,
      },
      summary: {
        totalCount: items.length,
        approvedCount: items.filter((item) => item.countIncluded).length,
        pendingAssetCount: items.filter((item) =>
          item.assetStatus === SubmissionAssetStatus.PENDING ||
          item.assetStatus === SubmissionAssetStatus.PROCESSING,
        ).length,
        duplicateCount: items.filter((item) => item.duplicate).length,
        rejectedCount: items.filter((item) => item.rejected).length,
      },
      items,
    };
  } catch (error) {
    logEvent('error', 'timeline_load_failed', {
      event: 'timeline_load_failed',
      stage: 'getCheckInTimeline',
      reason: error instanceof Error ? error.message : String(error),
    });
    return buildTimelineFallback(true);
  }
}

function buildRawSubmissionItem(rawSubmission: TimelineRawSubmission): CheckInTimelineItem {
  const latestRecord = rawSubmission.checkInRecords[0] ?? null;
  const latestAsset = rawSubmission.assets[0] ?? null;
  const imageUrl = sanitizeBrowserImageUrl(latestAsset?.blobUrl);
  const assetStatus = resolveDisplayAssetStatus(
    latestAsset?.assetStatus,
    imageUrl,
    latestAsset?.assetLastError ?? null,
  );

  const rejected = latestRecord?.status === CheckInRecordStatus.REJECTED;
  const countIncluded = latestRecord?.status === CheckInRecordStatus.APPROVED;

  return {
    id: `raw-${rawSubmission.id}`,
    kind: rejected ? 'rejected' : countIncluded ? 'checkin' : 'pending',
    displayName: rawSubmission.user.displayName,
    slackUserId: rawSubmission.identity?.providerUserId ?? null,
    checkedAt: latestRecord?.recordAt ?? rawSubmission.submittedAt,
    recordDate: latestRecord?.recordDate ?? rawSubmission.submittedAt,
    countIncluded,
    duplicate: false,
    rejected,
    assetStatus,
    imageUrl,
    imageUrlHost: getUrlHost(imageUrl),
    originalPhotoUrl: latestAsset?.originalPhotoUrl ?? latestAsset?.slackOriginalUrl ?? null,
    retryCount: latestAsset?.assetRetryCount ?? 0,
    lastError: latestAsset?.assetLastError ?? null,
    note: latestRecord?.note ?? rawSubmission.note,
    statusLabel: rejected
      ? '거절됨'
      : countIncluded
        ? assetStatus === SubmissionAssetStatus.ASSET_SAVED && !imageUrl
          ? '이미지 URL 없음'
          : '인증 완료'
        : latestAsset?.assetStatus === SubmissionAssetStatus.ASSET_FAILED
          ? '이미지 저장 실패'
          : latestAsset?.assetStatus === SubmissionAssetStatus.PROCESSING
            ? '이미지 처리중'
            : assetStatus === SubmissionAssetStatus.ASSET_SAVED && !imageUrl
              ? '이미지 URL 없음'
            : '처리중',
    assetLabel: getAssetLabel(assetStatus, latestAsset?.assetLastError ?? null, imageUrl),
    source: 'raw_submission',
    rawSubmissionId: rawSubmission.id,
    recordId: latestRecord?.id ?? undefined,
  };
}

function buildChangeCandidateItem(candidate: TimelineChangeCandidate): CheckInTimelineItem {
  const slackUserId = candidate.user.identities[0]?.providerUserId ?? null;
  const imageUrl = sanitizeBrowserImageUrl(candidate.blobUrl);
  const assetStatus = resolveDisplayAssetStatus(
    candidate.blobUrl ? SubmissionAssetStatus.ASSET_SAVED : SubmissionAssetStatus.PENDING,
    imageUrl,
    null,
  );

  return {
    id: `candidate-${candidate.id}`,
    kind: 'duplicate',
    displayName: candidate.user.displayName,
    slackUserId,
    checkedAt: candidate.submittedAt,
    recordDate: candidate.recordDate,
    countIncluded: false,
    duplicate: true,
    rejected: false,
    assetStatus,
    imageUrl,
    imageUrlHost: getUrlHost(imageUrl),
    originalPhotoUrl: candidate.originalPhotoUrl ?? candidate.slackOriginalUrl ?? null,
    retryCount: 0,
    lastError: null,
    note: candidate.note,
    statusLabel: '카운트 제외',
    assetLabel: getAssetLabel(assetStatus, null, imageUrl),
    source: 'change_candidate',
    candidateId: candidate.id,
  };
}

function getAssetLabel(
  status: SubmissionAssetStatus | 'NONE',
  lastError: string | null,
  imageUrl: string | null,
) {
  if (status === SubmissionAssetStatus.ASSET_SAVED) {
    if (!imageUrl) {
      return '이미지 URL 없음';
    }
    return '이미지 저장 완료';
  }
  if (status === SubmissionAssetStatus.PROCESSING) {
    return '이미지 처리중';
  }
  if (status === SubmissionAssetStatus.ASSET_FAILED) {
    return lastError ? `이미지 저장 실패 · ${lastError}` : '이미지 저장 실패';
  }
  if (status === SubmissionAssetStatus.PENDING) {
    return '이미지 처리중';
  }
  return '이미지 없음';
}

function resolveDisplayAssetStatus(
  status: SubmissionAssetStatus | null | undefined,
  imageUrl: string | null,
  lastError: string | null,
): SubmissionAssetStatus | 'NONE' {
  if (!status) {
    return imageUrl ? SubmissionAssetStatus.ASSET_SAVED : SubmissionAssetStatus.PENDING;
  }

  if (status === SubmissionAssetStatus.ASSET_SAVED && !imageUrl) {
    return SubmissionAssetStatus.ASSET_FAILED;
  }

  if (status === SubmissionAssetStatus.ASSET_FAILED && !lastError && !imageUrl) {
    return SubmissionAssetStatus.ASSET_FAILED;
  }

  return status;
}

function sanitizeBrowserImageUrl(url?: string | null) {
  const host = getUrlHost(url);
  if (!url || !host) {
    return null;
  }

  if (isSlackPrivateHost(host)) {
    return null;
  }

  return url;
}

function getUrlHost(url?: string | null) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function isSlackPrivateHost(host: string) {
  return host === 'files.slack.com' || host.endsWith('.slack.com') || host.includes('slack.com');
}

async function loadIntegration(workspaceId?: string, channelId?: string): Promise<TimelineIntegration | null> {
  return workspaceId && channelId
    ? prisma.slackIntegration.findUnique({
        where: {
          workspaceId_channelId: {
            workspaceId,
            channelId,
          },
        },
        include: {
          group: {
            select: {
              name: true,
            },
          },
          goal: {
            select: {
              title: true,
              targetCount: true,
            },
          },
        },
      })
    : prisma.slackIntegration.findFirst({
        include: {
          group: {
            select: {
              name: true,
            },
          },
          goal: {
            select: {
              title: true,
              targetCount: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      });
}

function buildTimelineFallback(configured: boolean) {
  return {
    configured,
    integration: configured
      ? undefined
      : {
          workspaceId: '',
          channelId: '',
          groupName: '확인 필요',
          goalRoomName: '확인 필요',
          targetCount: 0,
        },
    summary: {
      totalCount: 0,
      approvedCount: 0,
      pendingAssetCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
    },
    items: [] as CheckInTimelineItem[],
  };
}
