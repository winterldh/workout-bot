import { put } from '@vercel/blob';
import { logEvent, maskSlackFileUrl, type LogContext } from '@/lib/observability/logger';

export interface StoredSlackPhoto {
  blobUrl: string;
  slackOriginalUrl: string;
  mimeType?: string;
  storageKey?: string;
  uploadFailed?: boolean;
}

const SLACK_IMAGE_MIME_ALLOWLIST = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const SLACK_DOWNLOAD_TIMEOUT_MS = 10_000;
const BLOB_UPLOAD_TIMEOUT_MS = 15_000;

export async function storeSlackPhotoToBlob(input: {
  slackFileUrl: string;
  botToken?: string | null;
  workspaceId: string;
  channelId: string;
  sourceMessageId: string;
  mimeType?: string;
  fileId?: string | null;
  fileSize?: number | null;
  context?: LogContext;
}): Promise<StoredSlackPhoto> {
  if (!input.botToken) {
    logEvent('warn', 'slack.asset_upload_fallback', {
      type: 'asset_upload',
      status: 'fallback',
      eventType: 'slack_checkin',
      ...input.context,
      channelId: input.channelId,
      workspaceId: input.workspaceId,
      fileId: input.fileId ?? null,
      mimeType: input.mimeType ?? null,
      reason: 'missing_bot_token',
      fallback: true,
      file: maskSlackFileUrl(input.slackFileUrl),
    });
    return fallbackStoredPhoto(input, true, 'missing_bot_token');
  }

  if (!isSupportedImageMimeType(input.mimeType)) {
    logEvent('warn', 'slack.asset_upload_fallback', {
      type: 'asset_upload',
      status: 'fallback',
      eventType: 'slack_checkin',
      ...input.context,
      channelId: input.channelId,
      workspaceId: input.workspaceId,
      fileId: input.fileId ?? null,
      reason: 'unsupported_mime_type',
      mimeType: input.mimeType ?? null,
      fallback: true,
      file: maskSlackFileUrl(input.slackFileUrl),
    });
    return fallbackStoredPhoto(input, true, 'unsupported_mime_type');
  }

  if (typeof input.fileSize === 'number' && input.fileSize > 10 * 1024 * 1024) {
    logEvent('warn', 'slack.asset_upload_fallback', {
      type: 'asset_upload',
      status: 'fallback',
      eventType: 'slack_checkin',
      ...input.context,
      channelId: input.channelId,
      workspaceId: input.workspaceId,
      fileId: input.fileId ?? null,
      reason: 'file_too_large',
      fileSize: input.fileSize,
      fallback: true,
      file: maskSlackFileUrl(input.slackFileUrl),
    });
    return fallbackStoredPhoto(input, true, 'file_too_large');
  }

  try {
    const downloadSignal = createTimeoutSignal(SLACK_DOWNLOAD_TIMEOUT_MS);
    const response = await fetch(input.slackFileUrl, {
      headers: {
        Authorization: `Bearer ${input.botToken}`,
      },
      signal: downloadSignal.signal,
    }).finally(() => clearTimeout(downloadSignal.timeout));

    if (!response.ok) {
      logEvent('warn', 'slack.asset_upload_fallback', {
        type: 'asset_upload',
        status: 'fallback',
        eventType: 'slack_checkin',
        ...input.context,
        channelId: input.channelId,
        workspaceId: input.workspaceId,
        fileId: input.fileId ?? null,
        mimeType: input.mimeType ?? null,
        reason: 'slack_download_failed',
        httpStatus: response.status,
        statusText: response.statusText,
        fallback: true,
        file: maskSlackFileUrl(input.slackFileUrl),
      });
      return fallbackStoredPhoto(input, true, 'slack_download_failed');
    }

    const contentType =
      response.headers.get('content-type') ?? input.mimeType ?? 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();
    const extension = extensionFromContentType(contentType);
    const pathname = [
      'slack-checkins',
      sanitizePathPart(input.workspaceId),
      sanitizePathPart(input.channelId),
      `${sanitizePathPart(input.sourceMessageId)}${extension}`,
    ].join('/');

    const uploadSignal = createTimeoutSignal(BLOB_UPLOAD_TIMEOUT_MS);
    const blob = await put(pathname, new Blob([arrayBuffer], { type: contentType }), {
      access: 'public',
      addRandomSuffix: true,
      contentType,
      abortSignal: uploadSignal.signal,
    }).finally(() => clearTimeout(uploadSignal.timeout));

    logEvent('info', 'slack.asset_upload_success', {
      type: 'asset_upload',
      status: 'success',
      eventType: 'slack_checkin',
      ...input.context,
      channelId: input.channelId,
      workspaceId: input.workspaceId,
      fileId: input.fileId ?? null,
      mimeType: contentType,
      file: maskSlackFileUrl(input.slackFileUrl),
      blobUrl: blob.url,
    });

    return {
      blobUrl: blob.url,
      slackOriginalUrl: input.slackFileUrl,
      mimeType: contentType,
      storageKey: blob.pathname,
    };
  } catch (error) {
    logEvent('warn', 'slack.asset_upload_fallback', {
      type: 'asset_upload',
      status: 'fallback',
      eventType: 'slack_checkin',
      ...input.context,
      channelId: input.channelId,
      workspaceId: input.workspaceId,
      fileId: input.fileId ?? null,
      mimeType: input.mimeType ?? null,
      reason: error instanceof Error ? error.message : String(error),
      fallback: true,
      file: maskSlackFileUrl(input.slackFileUrl),
    });
    return fallbackStoredPhoto(input, true, error instanceof Error ? error.message : String(error));
  }
}

function fallbackStoredPhoto(
  input: {
    slackFileUrl: string;
    mimeType?: string;
  },
  uploadFailed: boolean,
  reason?: string,
): StoredSlackPhoto {
  return {
    blobUrl: input.slackFileUrl,
    slackOriginalUrl: input.slackFileUrl,
    mimeType: input.mimeType,
    uploadFailed,
  };
}

function sanitizePathPart(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isSupportedImageMimeType(mimeType?: string) {
  if (!mimeType) {
    return false;
  }

  return SLACK_IMAGE_MIME_ALLOWLIST.has(mimeType.toLowerCase());
}

function extensionFromContentType(contentType: string) {
  if (contentType.includes('png')) {
    return '.png';
  }
  if (contentType.includes('webp')) {
    return '.webp';
  }
  if (contentType.includes('gif')) {
    return '.gif';
  }
  return '.jpg';
}

function createTimeoutSignal(timeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, timeout };
}
