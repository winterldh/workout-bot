import { Prisma, SubmissionAssetStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logEvent, type LogContext } from '@/lib/observability/logger';
import { storeSlackPhotoToBlob } from '@/lib/slack/file-storage';
import { sendSlackDirectMessage } from '@/lib/slack/client';
import { updateSlackSubmissionAsset } from '@/lib/services/check-ins';

type ClaimedSubmissionAsset = {
  id: string;
  rawSubmissionId: string;
};

type SubmissionAssetRecord = {
  id: string;
  rawSubmissionId: string;
  assetStatus: SubmissionAssetStatus;
  assetRetryCount: number;
  assetLastError: string | null;
  assetLockedAt: Date | null;
  assetProcessedAt: Date | null;
  assetNextRetryAt: Date | null;
  mimeType: string | null;
  blobUrl: string | null;
  originalPhotoUrl: string | null;
  slackOriginalUrl: string | null;
  storageKey: string | null;
  metadata: Prisma.JsonValue | null;
  rawSubmission: {
    id: string;
    groupId: string;
    submittedAt: Date;
    sourceType: string;
    externalSubmissionId: string | null;
    rawPayload: Prisma.JsonValue | null;
    user: { displayName: string } | null;
  };
};

const CLAIM_BATCH_LIMIT = 10;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;

export async function processPendingSubmissionAssets(input?: {
  limit?: number;
  workspaceId?: string;
  channelId?: string;
}) {
  const limit = Math.max(1, Math.min(input?.limit ?? CLAIM_BATCH_LIMIT, 50));
  const claimed = await claimPendingSubmissionAssets(limit, input?.workspaceId, input?.channelId);

  let processedCount = 0;
  let failedCount = 0;

  for (const item of claimed) {
    const result = await processPendingSubmissionAsset(item).catch((error) => {
      failedCount += 1;
      logEvent('error', 'slack.pending_asset_processing_failed', {
        eventType: 'pending_asset',
        submissionAssetId: item.id,
        rawSubmissionId: item.rawSubmissionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    });

    if (result.ok) {
      processedCount += 1;
    }
  }

  return {
    claimedCount: claimed.length,
    processedCount,
    failedCount,
  };
}

async function claimPendingSubmissionAssets(
  limit: number,
  workspaceId?: string,
  channelId?: string,
) {
  const cutoff = new Date(Date.now() - PROCESSING_LEASE_MS);

  const whereClauses: Prisma.Sql[] = [
    Prisma.sql`(
      "assetStatus" = ${SubmissionAssetStatus.PENDING}::"SubmissionAssetStatus"
      OR ("assetStatus" = ${SubmissionAssetStatus.PROCESSING}::"SubmissionAssetStatus" AND ("assetLockedAt" IS NULL OR "assetLockedAt" < ${cutoff}))
      OR ("assetStatus" = ${SubmissionAssetStatus.ASSET_FAILED}::"SubmissionAssetStatus" AND ("assetNextRetryAt" IS NULL OR "assetNextRetryAt" <= NOW()))
    )`,
    Prisma.sql`"blobUrl" IS NULL`,
  ];

  if (workspaceId) {
    whereClauses.push(Prisma.sql`rs."rawPayload" ->> 'workspaceId' = ${workspaceId}`);
  }

  if (channelId) {
    whereClauses.push(Prisma.sql`rs."rawPayload" ->> 'channelId' = ${channelId}`);
  }

  const rows = await prisma.$queryRaw<ClaimedSubmissionAsset[]>(Prisma.sql`
    WITH candidate AS (
      SELECT asset."id", asset."rawSubmissionId"
      FROM "SubmissionAsset" asset
      JOIN "RawSubmission" rs ON rs."id" = asset."rawSubmissionId"
      WHERE ${Prisma.join(whereClauses, ' AND ')}
      ORDER BY asset."createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SubmissionAsset" AS asset
    SET
      "assetStatus" = ${SubmissionAssetStatus.PROCESSING}::"SubmissionAssetStatus",
      "assetLockedAt" = NOW(),
      "assetRetryCount" = asset."assetRetryCount" + 1,
      "assetLastError" = NULL,
      "updatedAt" = NOW()
    FROM candidate
    WHERE asset."id" = candidate."id"
    RETURNING asset."id", asset."rawSubmissionId";
  `);

  return rows;
}

async function processPendingSubmissionAsset(item: ClaimedSubmissionAsset) {
  const asset = await prisma.submissionAsset.findFirst({
    where: {
      id: item.id,
    },
    include: {
      rawSubmission: {
        include: {
          user: {
            select: {
              displayName: true,
            },
          },
        },
      },
    },
  }) as SubmissionAssetRecord | null;

  if (!asset || !asset.rawSubmission) {
    await finalizeAssetFailure(item.id, {
      reason: 'missing_submission_asset',
      lastError: 'missing_submission_asset',
    });
    return { ok: false as const };
  }

  const rawPayload = asRecord(asset.rawSubmission.rawPayload);
  const workspaceId = pickString(rawPayload.workspaceId) ?? pickString(rawPayload.team_id);
  const channelId = pickString(rawPayload.channelId);
  const sourceMessageId = pickString(rawPayload.sourceMessageId) ?? asset.rawSubmission.externalSubmissionId ?? asset.rawSubmission.id;
  const photo = asRecord(rawPayload.photo);
  const slackFileUrl =
    pickString(photo.slackOriginalUrl) ??
    pickString(photo.url_private_download) ??
    pickString(photo.url_private) ??
    asset.slackOriginalUrl ??
    asset.originalPhotoUrl ??
    null;

  if (!workspaceId || !channelId || !slackFileUrl) {
    await finalizeAssetFailure(item.id, {
      reason: 'invalid_asset_payload',
      lastError: 'invalid_asset_payload',
      workspaceId: workspaceId ?? undefined,
      channelId: channelId ?? undefined,
    });
    await notifyOwnerIfPossible({
      workspaceId,
      channelId,
      text: buildAssetFailureAlertText({
        displayName:
          asset.rawSubmission.user?.displayName ??
          asset.rawSubmission.externalSubmissionId ??
          asset.rawSubmission.id,
        channelId: channelId ?? '-',
        recordDate: asset.rawSubmission.submittedAt.toISOString(),
      }),
      logReason: 'invalid_asset_payload',
    });
    return { ok: false as const };
  }

  const integration = await prisma.slackIntegration.findUnique({
    where: {
      workspaceId_channelId: {
        workspaceId,
        channelId,
      },
    },
    include: {
      group: true,
      goal: true,
    },
  });

  if (!integration) {
    await finalizeAssetFailure(item.id, {
      reason: 'integration_not_found',
      lastError: 'integration_not_found',
      workspaceId,
      channelId,
    });
    return { ok: false as const };
  }

  const photoResult = await storeSlackPhotoToBlob({
    slackFileUrl,
    botToken: integration.botToken ?? process.env.SLACK_BOT_TOKEN ?? undefined,
    workspaceId,
    channelId,
    sourceMessageId,
    mimeType: pickString(photo.mimeType) ?? asset.mimeType ?? undefined,
    fileId: pickString(photo.id) ?? undefined,
    fileSize: typeof photo.size === 'number' ? photo.size : null,
    context: {
      workspaceId,
      channelId,
      groupId: asset.rawSubmission.groupId,
      rawSubmissionId: asset.rawSubmission.id,
      submissionAssetId: asset.id,
    },
  });

  await updateSlackSubmissionAsset({
    rawSubmissionId: asset.rawSubmissionId,
    blobUrl: photoResult.blobUrl,
    storageKey: photoResult.storageKey,
    mimeType: photoResult.mimeType ?? asset.mimeType ?? null,
    slackOriginalUrl: photoResult.slackOriginalUrl,
    assetStatus: photoResult.blobUrl
      ? SubmissionAssetStatus.ASSET_SAVED
      : SubmissionAssetStatus.ASSET_FAILED,
    assetRetryCount: asset.assetRetryCount,
    assetLastError: photoResult.blobUrl ? null : photoResult.uploadFailed ? 'asset_upload_failed' : 'asset_upload_failed',
    assetLockedAt: null,
    assetProcessedAt: photoResult.blobUrl ? new Date() : asset.assetProcessedAt ?? null,
    assetNextRetryAt: photoResult.blobUrl ? null : nextRetryAtForAttempt(asset.assetRetryCount),
  });

  if (!photoResult.blobUrl) {
    await finalizeAssetFailure(item.id, {
      reason: 'asset_upload_failed',
      lastError: 'asset_upload_failed',
      workspaceId,
      channelId,
    });
    await notifyOwnerIfPossible({
      workspaceId,
      channelId,
      text: buildAssetFailureAlertText({
        displayName:
          asset.rawSubmission.user?.displayName ??
          asset.rawSubmission.externalSubmissionId ??
          asset.rawSubmission.id,
        channelId,
        recordDate: asset.rawSubmission.submittedAt.toISOString(),
      }),
      logReason: 'asset_upload_failed',
    });
    return { ok: false as const };
  }

  logEvent('info', 'slack.pending_asset_saved', {
    eventType: 'pending_asset',
    workspaceId,
    channelId,
    rawSubmissionId: asset.rawSubmissionId,
    submissionAssetId: asset.id,
    assetStatus: 'ASSET_SAVED',
  });

  return { ok: true as const };
}

async function finalizeAssetFailure(
  submissionAssetId: string,
  input: {
    reason: string;
    lastError: string;
    workspaceId?: string;
    channelId?: string;
  },
) {
  const retryCount = await getAssetRetryCount(submissionAssetId);
  await prisma.submissionAsset.update({
    where: { id: submissionAssetId },
    data: {
      assetStatus: SubmissionAssetStatus.ASSET_FAILED,
      assetLastError: input.lastError,
      assetLockedAt: null,
      assetNextRetryAt: nextRetryAtForAttempt(retryCount),
    },
  });

  logEvent('warn', 'slack.pending_asset_failed', {
    eventType: 'pending_asset',
    submissionAssetId,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    reason: input.reason,
  });
}

async function getAssetRetryCount(submissionAssetId: string) {
  const asset = await prisma.submissionAsset.findUnique({
    where: { id: submissionAssetId },
    select: { assetRetryCount: true },
  });
  return asset?.assetRetryCount ?? 0;
}

async function notifyOwnerIfPossible(input: {
  workspaceId?: string | null;
  channelId?: string | null;
  text: string;
  logReason: string;
}) {
  const ownerUserId = process.env.SLACK_OWNER_USER_ID?.trim();
  if (!ownerUserId) {
    logEvent('warn', 'slack.pending_asset_owner_alert_skipped', {
      eventType: 'pending_asset',
      workspaceId: input.workspaceId ?? undefined,
      channelId: input.channelId ?? undefined,
      reason: 'missing_owner_user_id',
      logReason: input.logReason,
    });
    return;
  }

  await sendSlackDirectMessage({
    token: process.env.SLACK_BOT_TOKEN ?? undefined,
    userId: ownerUserId,
    text: input.text,
  });
}

function buildAssetFailureAlertText(input: {
  displayName: string;
  channelId: string;
  recordDate: string;
}) {
  return [
    '[운영 알림]',
    '사진 저장에 실패했어요.',
    '',
    `유저: ${input.displayName}`,
    `채널: ${input.channelId}`,
    `기록일: ${input.recordDate}`,
    '',
    '원본 Slack 파일 URL은 남아 있습니다.',
  ].join('\n');
}

function nextRetryAtForAttempt(attempts: number) {
  const backoffMinutes = Math.min(15, Math.max(1, attempts) * 2);
  return new Date(Date.now() + backoffMinutes * 60 * 1000);
}

function asRecord(value: Prisma.JsonValue | null | undefined) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
