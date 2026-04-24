import { prisma } from '@/lib/prisma';
import { logEvent, maskSlackFileUrl, type LogContext } from '@/lib/observability/logger';
import { createFromSlackMessage, replaceTodayFromSlackMessage } from '@/lib/services/check-ins';
import { buildStatusText, getCurrentStatus } from '@/lib/services/rankings';
import { ensureSlackUserMembership } from '@/lib/services/users';
import {
  fetchSlackUserProfile,
  sendSlackDirectMessage,
  sendSlackMessage,
} from '@/lib/slack/client';
import { storeSlackPhotoToBlob } from '@/lib/slack/file-storage';
import { toSlackTimestampDate } from '@/lib/domain/date';

interface SlackEventFile {
  id?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
  initial_comment?: {
    comment?: string;
  };
}

interface SlackTextBlock {
  type?: string;
  text?: {
    type?: string;
    text?: string;
  };
  elements?: Array<
    | {
        type?: string;
        text?: string;
        elements?: SlackTextBlock[];
      }
    | string
  >;
}

interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  bot_id?: string;
  app_id?: string;
  user?: string;
  channel?: string;
  text?: string;
  ts?: string;
  client_msg_id?: string;
  username?: string;
  files?: SlackEventFile[];
  blocks?: SlackTextBlock[];
  message?: {
    text?: string;
    blocks?: SlackTextBlock[];
  };
}

type SlackIntent = 'checkin' | 'change' | 'admin_checkin' | 'goal_confirm';

export function analyzeSlackIntent(
  payload: Record<string, any>,
  event: SlackMessageEvent,
) {
  const texts = extractIntentTexts(payload, event);
  const intent = getIntentFromTexts(texts);

  return {
    intent,
    texts,
    reason: intent ? null : 'no_intent',
  };
}

export async function handleSlackEvent(
  payload: Record<string, any>,
  context: LogContext,
) {
  if (payload.type === 'url_verification') {
    return { challenge: payload.challenge };
  }

  if (payload.type !== 'event_callback' || !payload.event) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      reason: 'missing_event_callback_or_event',
    });
    return { ok: true, ignored: true };
  }

  const event = payload.event as SlackMessageEvent;
  const workspaceId = payload.authorizations?.[0]?.team_id ?? payload.team_id;
  const channelId = event.channel;
  const userId = event.user;

  if (!workspaceId || !channelId || !userId || isBotActorEvent(event)) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId: workspaceId ?? undefined,
      channelId: channelId ?? undefined,
      slackUserId: userId ?? undefined,
      reason: !workspaceId
        ? 'missing_workspace_id'
        : !channelId
          ? 'missing_channel_id'
          : !userId
            ? 'missing_user_id'
            : 'bot_actor_event',
    });
    return { ok: true, ignored: true };
  }

  const intentAnalysis = analyzeSlackIntent(payload, event);
  const intent = intentAnalysis.intent;
  const imageSelection = selectSupportedSlackImageFile(event.files);
  const selectedFile = imageSelection.selectedFile;
  const slackFileUrl = selectedFile?.url_private_download ?? selectedFile?.url_private;
  const mentionedUserId = extractMentionedUserId(intentAnalysis.texts[0]);
  const isMessage =
    event.type === 'message' && (!event.subtype || event.subtype === 'file_share');

  if (!isMessage || !intent) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      reason: !isMessage ? 'not_message_event' : 'no_intent',
    });
    return { ok: true, ignored: true };
  }

  const integration = await findSlackIntegration(workspaceId, channelId);
  if (!integration) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      reason: 'integration_not_found',
    });
    return { ok: true, ignored: true };
  }

  const token = process.env.SLACK_BOT_TOKEN ?? integration.botToken ?? undefined;
  const actingProfile = await fetchSlackUserProfile({
    token,
    userId,
    fallbackDisplayName: event.username?.trim() || `slack-${userId}`,
    fallbackUsername: event.username?.trim(),
  });

  if (intent === 'goal_confirm') {
    const registrationResult = await registerSlackUserFromGoalConfirm({
      workspaceId,
      channelId,
      userId,
      displayName: actingProfile.displayName,
      providerUsername: actingProfile.providerUsername,
    });

    await sendSlackMessage({
      token,
      channelId,
      threadTs: event.ts,
      text: buildGoalConfirmMessage({
        userId,
        goalTitle: registrationResult.goalTitle,
        targetCount: registrationResult.targetCount,
        penaltyText: registrationResult.penaltyText,
        isNewUser:
          registrationResult.userCreated || registrationResult.membershipCreated,
      }),
    });

    return { ok: true, registered: true };
  }

  if (intent === 'change') {
    const result = await replaceTodayFromSlackMessage({
      externalSlackId: userId,
      workspaceId,
      channelId,
      checkedAt: toSlackTimestampDate(event.ts),
    });
    if (result.status === 'replaced') {
      logEvent('info', 'slack.change_replaced', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        slackUserId: userId,
      });
    }
    await replyForChangeResult({ token, channelId, threadTs: event.ts, userId, result });
    return { ok: true, ...result };
  }

  if (imageSelection.totalFiles > 0 && imageSelection.hasMultipleSupportedFiles) {
    logEvent('info', 'slack.image_selection_multiple', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      totalFiles: imageSelection.totalFiles,
      supportedFiles: imageSelection.supportedFiles,
      selectedFile: selectedFile ? maskSlackFileUrl(slackFileUrl) : null,
    });
  }

  if (!slackFileUrl) {
    if (imageSelection.totalFiles > 0) {
      logEvent('info', 'slack.image_selection_ignored', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        totalFiles: imageSelection.totalFiles,
        supportedFiles: imageSelection.supportedFiles,
        reason: imageSelection.hasUnsupportedFiles
          ? 'unsupported_mime_type'
          : imageSelection.hasMultipleSupportedFiles
            ? 'multiple_images'
            : 'missing_image',
        file: imageSelection.firstFile
          ? maskSlackFileUrl(
              imageSelection.firstFile.url_private_download ?? imageSelection.firstFile.url_private,
            )
          : null,
      });
    }
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      reason: selectedFile ? 'unsupported_image_mime' : 'missing_image',
      file: selectedFile ? maskSlackFileUrl(selectedFile.url_private_download ?? selectedFile.url_private) : null,
    });
    await sendSlackMessage({
      token,
      channelId,
      threadTs: event.ts,
      text: imageSelection.hasUnsupportedFiles || imageSelection.hasMultipleSupportedFiles
        ? `<@${userId}> 이미지 1장만 올려주세요`
        : `<@${userId}> 사진을 함께 올려주세요`,
    });
    return { ok: true, ignored: true, reason: 'missing_image' };
  }

  const sourceMessageId = event.client_msg_id ?? event.ts ?? `${Date.now()}`;
  let photo: Awaited<ReturnType<typeof storeSlackPhotoToBlob>>;
  try {
    photo = await storeSlackPhotoToBlob({
      slackFileUrl,
      botToken: token,
      workspaceId,
      channelId,
      sourceMessageId,
      mimeType: selectedFile?.mimetype,
      fileId: selectedFile?.id ?? null,
      fileSize: selectedFile?.size ?? null,
      context: {
        ...context,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        slackUserId: userId,
      },
    });
  } catch (error) {
    logEvent('warn', 'slack.asset_upload_fallback', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      groupId: integration.groupId,
      goalId: integration.goalId,
      slackUserId: userId,
      reason: error instanceof Error ? error.message : String(error),
      fallback: true,
      file: maskSlackFileUrl(slackFileUrl),
    });
    photo = {
      blobUrl: slackFileUrl,
      slackOriginalUrl: slackFileUrl,
      mimeType: selectedFile?.mimetype,
      uploadFailed: true,
    };
  }

  const targetUserId = intent === 'admin_checkin' ? mentionedUserId : userId;
  if (intent === 'admin_checkin') {
    const adminValidation = await validateAdminProxyRequest({
      workspaceId,
      actorUserId: userId,
      targetUserId,
      groupId: integration.groupId,
    });
    if (!adminValidation.ok) {
      await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: adminValidation.message,
      });
      return { ok: true, ignored: true };
    }
  }

  try {
    const targetProfile =
      intent === 'admin_checkin' && targetUserId
        ? await fetchSlackUserProfile({
            token,
            userId: targetUserId,
            fallbackDisplayName: `slack-${targetUserId}`,
          })
        : actingProfile;

    const result = await createFromSlackMessage({
      externalSlackId: targetUserId ?? userId,
      displayName: targetProfile.displayName,
      providerUsername: targetProfile.providerUsername,
      workspaceId,
      channelId,
      sourceMessageId,
      photo,
      note: event.text,
      checkedAt: toSlackTimestampDate(event.ts),
      allowChangeCandidateOnDuplicate: intent !== 'admin_checkin',
      context: {
        ...context,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        slackUserId: userId,
      },
    });

    if (result.status === 'accepted') {
    logEvent('info', 'slack.checkin_accepted', {
      type: 'checkin',
      status: 'accepted',
      eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        slackUserId: targetUserId ?? userId,
      });
    }

    if (result.status === 'duplicate') {
    logEvent('info', 'slack.checkin_duplicate', {
      type: 'checkin',
      status: 'duplicate',
      eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        slackUserId: targetUserId ?? userId,
        candidateSaved: result.candidateSaved,
        candidateId: result.candidateId ?? null,
      });
    }

    await replyForCheckInResult({
      token,
      workspaceId,
      channelId,
      threadTs: event.ts,
      actorUserId: userId,
      targetUserId: targetUserId ?? userId,
      result,
      isAdminCheckIn: intent === 'admin_checkin',
    });

    return { ok: true, ...result };
  } catch (error) {
    logEvent('error', 'slack.checkin_db_write_failed', {
      type: 'checkin',
      status: 'db_write_failed',
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      groupId: integration.groupId,
      goalId: integration.goalId,
      slackUserId: targetUserId ?? userId,
      reason: error instanceof Error ? error.message : String(error),
      stage: 'create_or_reply',
    });
    throw error;
  }
}

export async function handleStatusCommand(payload: Record<string, string>) {
  try {
    const integration = await findSlackIntegration(payload.team_id, payload.channel_id);
    if (!integration) {
      return {
        response_type: 'in_channel',
        text: '이 채널은 아직 인증 채널로 연결되지 않았어요. DB migration/seed를 먼저 확인해주세요.',
      };
    }

    return {
      response_type: 'in_channel',
      text: await buildStatusText({
        workspaceId: payload.team_id,
        channelId: payload.channel_id,
        externalSlackId: payload.user_id,
        externalSlackUsername: payload.user_name,
      }),
    };
  } catch (error) {
    await notifyStatusCommandFailure({ payload, error, stage: 'service' });
    return {
      response_type: 'in_channel',
      text: '문제가 발생해 요청 이력을 DM으로 보냈어요. 다시 시도해주세요.',
    };
  }
}

export async function notifyStatusCommandFailure(input: {
  payload: Record<string, string>;
  error: unknown;
  stage: 'route' | 'service';
}) {
  const token = process.env.SLACK_BOT_TOKEN;
  const dmUserId = input.payload.user_id || process.env.SLACK_ADMIN_USER_ID;
  const lines = [
    '[Workout Bot] /현황 처리 실패 이력',
    `stage: ${input.stage}`,
    `time: ${new Date().toISOString()}`,
    `workspaceId: ${input.payload.team_id || '-'}`,
    `channelId: ${input.payload.channel_id || '-'}`,
    `userId: ${input.payload.user_id || '-'}`,
    `userName: ${input.payload.user_name || '-'}`,
    `command: ${input.payload.command || '-'}`,
    `error: ${input.error instanceof Error ? input.error.message : String(input.error)}`,
  ];

  console.error('Slack /현황 command failed', lines.join(' | '));
  await sendSlackDirectMessage({ token, userId: dmUserId, text: lines.join('\n') });
}

async function replyForCheckInResult(input: {
  token?: string;
  workspaceId: string;
  channelId: string;
  threadTs?: string;
  actorUserId: string;
  targetUserId: string;
  result: Awaited<ReturnType<typeof createFromSlackMessage>>;
  isAdminCheckIn: boolean;
}) {
  if (input.result.status === 'registration_required') {
    await sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: `<@${input.targetUserId}> 먼저 #목표확인을 입력해주세요`,
    });
    return;
  }

  if (input.result.status === 'accepted') {
    const status = await getCurrentStatus({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      externalSlackId: input.targetUserId,
    });
    await sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: `<@${input.targetUserId}> 인증 횟수가 반영되었어요! ${status?.me?.count ?? 1} / ${status?.targetCount ?? 1} 완료`,
    });
    await sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      text: await buildStatusText({
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        externalSlackId: input.targetUserId,
      }),
    });
    return;
  }

  if (input.result.status === 'duplicate') {
    const text = input.isAdminCheckIn
      ? `<@${input.actorUserId}> <@${input.targetUserId}>의 오늘 인증은 이미 반영되었어요`
      : input.result.candidateSaved
        ? `<@${input.actorUserId}> 오늘 인증은 이미 반영되었어요\n이 사진으로 변경하려면 #변경을 입력해주세요`
        : `<@${input.actorUserId}> 오늘 인증은 이미 반영되었어요`;
    await sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text,
    });
  }
}

function selectSupportedSlackImageFile(files?: SlackEventFile[]) {
  const totalFiles = files?.length ?? 0;
  const supportedFiles = files?.filter((file) => isSupportedSlackImageMimeType(file.mimetype)) ?? [];
  return {
    totalFiles,
    supportedFiles: supportedFiles.length,
    hasUnsupportedFiles: totalFiles > 0 && supportedFiles.length === 0,
    hasMultipleSupportedFiles: supportedFiles.length > 1,
    selectedFile: supportedFiles[0] ?? null,
    firstFile: files?.[0] ?? null,
  };
}

async function replyForChangeResult(input: {
  token?: string;
  channelId: string;
  threadTs?: string;
  userId: string;
  result: Awaited<ReturnType<typeof replaceTodayFromSlackMessage>>;
}) {
  const textByStatus = {
    replaced: `<@${input.userId}> 인증 이미지가 변경되었어요.`,
    missing_checkin: `<@${input.userId}> 오늘 변경할 인증이 없어요\n먼저 #인증과 사진을 올려주세요`,
    missing_candidate: `<@${input.userId}> 변경할 새 사진이 없어요\n새 사진을 올린 뒤 #변경을 입력해주세요`,
    ignored: `<@${input.userId}> 이 채널은 아직 인증 채널로 연결되지 않았어요.`,
  } satisfies Record<typeof input.result.status, string>;

  await sendSlackMessage({
    token: input.token,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: textByStatus[input.result.status],
  });
}

async function findSlackIntegration(workspaceId?: string, channelId?: string) {
  if (!workspaceId || !channelId) {
    return null;
  }

  return prisma.slackIntegration.findUnique({
    where: {
      workspaceId_channelId: { workspaceId, channelId },
    },
    include: { group: true, goal: true },
  });
}

async function registerSlackUserFromGoalConfirm(input: {
  workspaceId: string;
  channelId: string;
  userId: string;
  displayName: string;
  providerUsername?: string;
}) {
  const integration = await findSlackIntegration(input.workspaceId, input.channelId);
  if (!integration) {
    throw new Error('Slack integration not found for #목표확인');
  }

  const ensured = await prisma.$transaction((tx) =>
    ensureSlackUserMembership({
      tx,
      workspaceId: input.workspaceId,
      externalSlackId: input.userId,
      displayName: input.displayName,
      providerUsername: input.providerUsername,
      groupId: integration.groupId,
    }),
  );

  return {
    userCreated: ensured.userCreated,
    membershipCreated: ensured.membershipCreated,
    goalTitle: integration.goal.title,
    targetCount: integration.goal.targetCount,
    penaltyText: process.env.WEEKLY_PENALTY_TEXT?.trim() || undefined,
  };
}

async function validateAdminProxyRequest(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId?: string | null;
  groupId: string;
}) {
  if (!input.targetUserId || input.targetUserId === input.actorUserId) {
    return {
      ok: false as const,
      message: `<@${input.actorUserId}> 대신 인증할 사용자를 멘션해주세요`,
    };
  }

  const actorIdentity = await prisma.userIdentity.findUnique({
    where: {
      provider_providerUserId_providerWorkspaceId: {
        provider: 'SLACK',
        providerUserId: input.actorUserId,
        providerWorkspaceId: input.workspaceId,
      },
    },
  });

  if (!actorIdentity) {
    return {
      ok: false as const,
      message: `<@${input.actorUserId}> 관리자만 대신 인증할 수 있어요`,
    };
  }

  const actorMembership = await prisma.groupMembership.findUnique({
    where: {
      userId_groupId: {
        userId: actorIdentity.userId,
        groupId: input.groupId,
      },
    },
  });

  if (actorMembership?.role !== 'ADMIN') {
    return {
      ok: false as const,
      message: `<@${input.actorUserId}> 관리자만 대신 인증할 수 있어요`,
    };
  }

  return { ok: true as const };
}

function buildGoalConfirmMessage(input: {
  userId: string;
  goalTitle: string;
  targetCount: number;
  penaltyText?: string;
  isNewUser: boolean;
}) {
  const lines = [
    input.isNewUser
      ? `<@${input.userId}> 등록되었어요`
      : `<@${input.userId}> 이미 등록되어 있어요`,
    `현재 목표: ${input.goalTitle} ${input.targetCount}회`,
    '#인증 을 입력하고 사진을 올리면 그날의 운동 인증 완료!',
  ];

  if (input.penaltyText) {
    lines.push(`현재 패널티: ${input.penaltyText}`);
  }

  return lines.join('\n');
}

function getIntentFromTexts(texts: string[]): SlackIntent | null {
  if (texts.some((text) => text.includes('#대신인증'))) {
    return 'admin_checkin';
  }
  if (texts.some((text) => text.includes('#변경'))) {
    return 'change';
  }
  if (texts.some((text) => text.includes('#목표확인'))) {
    return 'goal_confirm';
  }
  if (texts.some((text) => containsCheckinIntent(text))) {
    return 'checkin';
  }
  return null;
}

function extractIntentTexts(payload: Record<string, any>, event: SlackMessageEvent) {
  const texts = new Set<string>();
  const candidates = [
    event.text,
    event.message?.text,
    payload.message?.text,
    ...extractFileComments(event.files),
    ...extractBlockTexts(event.blocks),
    ...extractBlockTexts(event.message?.blocks),
    ...extractBlockTexts(payload.message?.blocks),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const normalized = candidate.trim();
      if (normalized) {
        texts.add(normalized);
      }
    }
  }

  return [...texts];
}

function extractFileComments(files?: SlackEventFile[]) {
  return (
    files?.flatMap((file) => (file.initial_comment?.comment ? [file.initial_comment.comment] : [])) ?? []
  );
}

function extractBlockTexts(blocks?: SlackTextBlock[]) {
  const collected: string[] = [];

  const walk = (value: unknown) => {
    if (!value) {
      return;
    }
    if (typeof value === 'string') {
      collected.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }
    if (typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.text === 'string') {
        collected.push(record.text);
      }
      if (record.text && typeof record.text === 'object' && typeof (record.text as Record<string, unknown>).text === 'string') {
        collected.push((record.text as Record<string, unknown>).text as string);
      }
      walk(record.elements);
    }
  };

  walk(blocks);
  return collected;
}

function containsCheckinIntent(text?: string) {
  if (!text) {
    return false;
  }

  if (text.includes('#인증')) {
    return true;
  }

  return /(^|[\s(])인증($|[\s).,!?:;\]])/.test(text);
}

function extractMentionedUserId(text?: string) {
  const match = text?.match(/<@([A-Z0-9]+)>/);
  return match?.[1] ?? null;
}

function isBotActorEvent(event: SlackMessageEvent) {
  const configuredBotUserId = process.env.SLACK_BOT_USER_ID;
  return (
    event.subtype === 'bot_message' ||
    Boolean(event.bot_id) ||
    Boolean(event.app_id) ||
    (Boolean(configuredBotUserId) && event.user === configuredBotUserId)
  );
}

function isSupportedSlackImageMimeType(mimeType?: string) {
  if (!mimeType) {
    return false;
  }

  return (
    mimeType === 'image/jpeg' ||
    mimeType === 'image/jpg' ||
    mimeType === 'image/png' ||
    mimeType === 'image/webp'
  );
}
