type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  eventId?: string;
  retryNum?: string | null;
  retryReason?: string | null;
  receiptId?: string;
  workspaceId?: string;
  channelId?: string;
  groupId?: string;
  goalId?: string;
  slackUserId?: string;
  checkInRecordId?: string;
  rawSubmissionId?: string;
  submissionAssetId?: string;
  candidateId?: string;
  intent?: string | null;
  ignoredReason?: string | null;
  replyStatus?: string | null;
  receiptStatus?: string | null;
  assetStatus?: string | null;
  sourceMessageId?: string | null;
}

export function logEvent(
  level: LogLevel,
  message: string,
  context: LogContext & Record<string, unknown> = {},
) {
  const payload = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...context,
  };

  const output = JSON.stringify(payload);
  if (level === 'error') {
    console.error(output);
    return;
  }

  if (level === 'warn') {
    console.warn(output);
    return;
  }

  if (level === 'info') {
    console.info(output);
    return;
  }

  console.log(output);
}

export function maskSlackFileUrl(url?: string | null) {
  if (!url) {
    return null;
  }

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const fileId = parts.find((part) => /^F[A-Z0-9]+$/i.test(part)) ?? null;
    const basename = parts.at(-1) ?? null;

    return {
      host: parsed.hostname,
      fileId,
      basename,
    };
  } catch {
    return {
      host: null,
      fileId: null,
      basename: null,
    };
  }
}
