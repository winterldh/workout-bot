import { SlackEventReceiptStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logEvent, maskSlackFileUrl, type LogContext } from '@/lib/observability/logger';
import { createFromSlackMessage, replaceTodayFromSlackMessage } from '@/lib/services/check-ins';
import {
  buildChannelStatusText,
  buildGoalConfirmText,
  buildHelpText,
  buildStatusText,
  buildThreadStatusText,
  formatProgressBar,
  getCurrentStatus,
} from '@/lib/services/rankings';
import {
  getSlackRegistrationState,
  registerSlackUserFromCommand,
  renameSlackUserFromCommand,
  ensureSlackUserMembership,
} from '@/lib/services/users';
import { formatSlackMention, sendSlackDirectMessage, sendSlackMessage } from '@/lib/slack/client';
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
  thread_ts?: string;
  client_msg_id?: string;
  username?: string;
  files?: SlackEventFile[];
  blocks?: SlackTextBlock[];
  message?: {
    text?: string;
    blocks?: SlackTextBlock[];
  };
}

type SlackIntent = 'register' | 'checkin' | 'change' | 'admin_checkin' | 'goal_confirm' | 'status' | 'help';

export function analyzeSlackIntent(
  payload: Record<string, any>,
  event: SlackMessageEvent,
  botUserId?: string,
) {
  const texts = extractIntentTexts(payload, event);
  const commandText = findMentionedCommandText(texts, botUserId);
  const normalizedCommandText = commandText ? stripBotMention(commandText, botUserId) : '';
  const intent = commandText ? getIntentFromCommandText(normalizedCommandText) : null;

  return {
    intent,
    texts,
    commandText: normalizedCommandText,
    reason: intent ? null : commandText ? 'unrecognized_command' : 'no_bot_mention',
  };
}

type SlackEventReceiptRecord = {
  eventId: string;
  status: SlackEventReceiptStatus;
};

async function claimSlackEventReceipt(input: {
  eventId?: string;
  requestId?: string;
  retryNum?: string | null;
  retryReason?: string | null;
  workspaceId: string;
  channelId: string;
  slackUserId?: string;
  eventType: string;
}) {
  if (!input.eventId) {
    return { receipt: null as SlackEventReceiptRecord | null, duplicate: false };
  }

  try {
    const receipt = await prisma.slackEventReceipt.create({
      data: {
        eventId: input.eventId,
        requestId: input.requestId,
        workspaceId: input.workspaceId,
        channelId: input.channelId,
        slackUserId: input.slackUserId,
        eventType: input.eventType,
        retryNum: toPositiveInteger(input.retryNum),
        retryReason: input.retryReason ?? null,
        status: SlackEventReceiptStatus.PROCESSING,
      },
      select: {
        eventId: true,
        status: true,
      },
    });

    return { receipt, duplicate: false };
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const receipt = await prisma.slackEventReceipt.findUnique({
        where: { eventId: input.eventId },
        select: { eventId: true, status: true },
      });
      return { receipt, duplicate: true };
    }

    throw error;
  }
}

async function finalizeSlackEventReceipt(input: {
  eventId?: string;
  status: SlackEventReceiptStatus;
  intent?: string | null;
  ignoredReason?: string | null;
  error?: string | null;
  processedAt?: Date;
}) {
  if (!input.eventId) {
    return;
  }

  await prisma.slackEventReceipt.update({
    where: { eventId: input.eventId },
    data: {
      status: input.status,
      intent: input.intent ?? undefined,
      ignoredReason: input.ignoredReason ?? undefined,
      error: input.error ?? undefined,
      processedAt: input.processedAt ?? new Date(),
    },
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002',
  );
}

function toPositiveInteger(value?: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
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
  const botUserId = process.env.SLACK_BOT_USER_ID?.trim();
  const ignoredActorReason = getIgnoredActorEventReason(event);
  const isChannelContext =
    typeof channelId === 'string' && (channelId.startsWith('C') || channelId.startsWith('G'));
  const isThreadReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);

  if (!workspaceId || !channelId || !userId || ignoredActorReason || !isChannelContext) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId: workspaceId ?? undefined,
      channelId: channelId ?? undefined,
      slackUserId: userId ?? undefined,
      ignoredReason: ignoredActorReason ?? null,
      reason: !workspaceId
        ? 'missing_workspace_id'
        : !channelId
          ? 'missing_channel_id'
          : !userId
            ? 'missing_user_id'
            : !isChannelContext
              ? 'non_channel_context'
            : ignoredActorReason ?? 'bot_actor_event',
    });
    return { ok: true, ignored: true };
  }

  if (isThreadReply) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      ignoredReason: 'thread_reply',
      reason: 'thread_reply',
    });
    return { ok: true, ignored: true };
  }

  if (!botUserId) {
    logEvent('warn', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      ignoredReason: 'missing_bot_user_id',
      reason: 'missing_bot_user_id',
    });
    return { ok: true, ignored: true };
  }

  const intentAnalysis = analyzeSlackIntent(payload, event, botUserId);
  const intent = intentAnalysis.intent;
  const commandText = intentAnalysis.commandText;
  const hasMention = Boolean(commandText || intentAnalysis.reason !== 'no_bot_mention');
  const imageSelection = selectSupportedSlackImageFile(event.files);
  const selectedFile = imageSelection.selectedFile;
  const slackFileUrl = selectedFile?.url_private_download ?? selectedFile?.url_private;
  const mentionedUserId = extractMentionedUserId(commandText);
  const isMessage = event.type === 'message' && isSupportedMessageSubtype(event.subtype);

  if (!isMessage) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      ignoredReason: getIgnoredMessageSubtypeReason(event.subtype),
      reason: 'not_message_event',
    });
    return { ok: true, ignored: true };
  }

  if (!hasMention) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      ignoredReason: 'no_bot_mention',
      reason: 'no_bot_mention',
    });
    return { ok: true, ignored: true };
  }

  const receiptClaim = await claimSlackEventReceipt({
    eventId: payload.event_id ?? undefined,
    requestId: context.requestId,
    retryNum: context.retryNum,
    retryReason: context.retryReason,
    workspaceId,
    channelId,
    slackUserId: userId,
    eventType: event.type ?? 'message',
  });

  if (receiptClaim.duplicate) {
    logEvent('info', 'slack.event_duplicate_ignored', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      intent,
      receiptStatus: receiptClaim.receipt?.status ?? 'PROCESSING',
      ignoredReason: 'duplicate_event_id',
      reason: 'duplicate_event_id',
      replyStatus: 'skipped',
    });
    return { ok: true, ignored: true, reason: 'duplicate_event_id' };
  }

  if (receiptClaim.receipt) {
    logEvent('info', 'slack.event_receipt_claimed', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      intent,
      receiptStatus: receiptClaim.receipt.status,
    });
  }

  const integration = await findSlackIntegration(workspaceId, channelId);
    if (!integration) {
      logEvent('info', 'slack.ignored_event', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        receiptStatus: receiptClaim.receipt?.status ?? null,
        ignoredReason: 'integration_not_found',
        reason: 'integration_not_found',
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: SlackEventReceiptStatus.SKIPPED,
        intent,
        ignoredReason: 'integration_not_found',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, ignored: true };
    }

    const registrationState = await getSlackRegistrationState({
      db: prisma,
      workspaceId,
      externalSlackId: userId,
      groupId: integration.groupId,
    });

    const token = process.env.SLACK_BOT_TOKEN ?? integration.botToken ?? undefined;
    const goalInfo = {
      goalTitle: integration.goal.title,
      targetCount: integration.goal.targetCount,
      penaltyText: process.env.WEEKLY_PENALTY_TEXT?.trim() || undefined,
    };
    const mention = formatSlackMention(botUserId);
    const isFirstInteraction = !registrationState.isRegistered;
    const onboardingText = buildFirstVisitText(mention);
    const shortGuideText = buildShortGuideText(mention);
    if (intent === 'help') {
      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: buildHelpText(botUserId),
      });

      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        replyStatus: replied ? 'sent' : 'failed',
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent,
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, replied: true };
    }

    if (!intent) {
      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: shortGuideText,
      });

      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent: null,
        replyStatus: replied ? 'sent' : 'failed',
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        ignoredReason: 'unrecognized_command',
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent: null,
        ignoredReason: 'unrecognized_command',
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent: null,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, replied: true };
    }

    if (intent === 'status') {
      const status = await getCurrentStatus({
        workspaceId,
        channelId,
        externalSlackId: userId,
      });

      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: buildThreadStatusText(status),
      });

      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        replyStatus: replied ? 'sent' : 'failed',
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent,
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, replied: true };
    }

    if (intent === 'register') {
      const registrationName = parseRegistrationName(commandText);
      if (registrationName) {
        if (registrationState.isRegistered) {
          await renameSlackUserFromCommand({
            db: prisma,
            workspaceId,
            externalSlackId: userId,
            displayName: registrationName,
            groupId: integration.groupId,
          });
        } else {
          await registerSlackUserFromCommand({
            db: prisma,
            workspaceId,
            externalSlackId: userId,
            displayName: registrationName,
            groupId: integration.groupId,
          });
        }
      }

      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: registrationName
          ? registrationState.isRegistered
            ? buildRegistrationRenameText({ displayName: registrationName })
            : buildRegistrationSuccessText({
                displayName: registrationName,
                mention,
                ...goalInfo,
              })
          : buildRegistrationNamePromptText(mention),
      });

      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        replyStatus: replied ? 'sent' : 'failed',
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent,
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });

      return { ok: true, registered: true };
    }

    if (!registrationState.isRegistered) {
      if (intent === 'checkin' && !slackFileUrl) {
        const replied = await sendSlackMessage({
          token,
          channelId,
          threadTs: event.ts,
          text: buildMissingImageText(mention),
        });

        logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          replyStatus: replied ? 'sent' : 'failed',
          receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
          ignoredReason: 'missing_image',
        });
        await finalizeSlackEventReceipt({
          eventId: payload.event_id ?? undefined,
          status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
          intent,
          ignoredReason: 'missing_image',
          error: replied ? null : 'reply_failed',
        }).catch((error) => {
          logEvent('warn', 'slack.event_receipt_finalize_failed', {
            eventType: 'slack_checkin',
            ...context,
            workspaceId,
            channelId,
            slackUserId: userId,
            intent,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
        return { ok: true, ignored: true, reason: 'missing_image' };
      }

      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text:
          intent === 'goal_confirm'
            ? buildRegistrationPromptText(goalInfo, mention)
            : buildRegistrationPromptText(goalInfo, mention),
      });

      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        replyStatus: replied ? 'sent' : 'failed',
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        ignoredReason: 'registration_required',
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'registration_required',
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, ignored: true, reason: 'registration_required' };
    }

  if (intent === 'goal_confirm') {
    const status = await getCurrentStatus({
      workspaceId,
      channelId,
      externalSlackId: userId,
    });

    const replied = await sendSlackMessage({
      token,
      channelId,
      threadTs: event.ts,
      text: status && status.me
        ? buildGoalConfirmText({
            goalTitle: goalInfo.goalTitle,
            targetCount: goalInfo.targetCount,
            penaltyText: goalInfo.penaltyText,
            displayName: status.me.displayName,
            count: status.me.count,
          })
        : `${buildGoalInfoText(goalInfo)}\n\n이번 주 현황을 불러오지 못했어요. 잠시 후 다시 시도해주세요.`,
    });

    logEvent('info', 'slack.reply_sent', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      intent,
      receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      replyStatus: replied ? 'sent' : 'failed',
      ignoredReason: registrationState.isRegistered ? null : 'registration_required',
    });

    await finalizeSlackEventReceipt({
      eventId: payload.event_id ?? undefined,
      status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      intent,
      error: replied ? null : 'reply_failed',
    }).catch((error) => {
      logEvent('warn', 'slack.event_receipt_finalize_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        reason: error instanceof Error ? error.message : String(error),
      });
    });

    return { ok: true, replied: true };
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

    const replied = await replyForChangeResult({
      token,
      channelId,
      threadTs: event.ts,
      userId,
      result,
    });
    logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      intent,
      receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      replyStatus: replied ? 'sent' : 'failed',
    });
    await finalizeSlackEventReceipt({
      eventId: payload.event_id ?? undefined,
      status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      intent,
      error: replied ? null : 'reply_failed',
    }).catch((error) => {
      logEvent('warn', 'slack.event_receipt_finalize_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
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
    const replied = await sendSlackMessage({
      token,
      channelId,
      threadTs: event.ts,
      text:
        imageSelection.hasUnsupportedFiles || imageSelection.hasMultipleSupportedFiles
          ? `${mention} 이미지 1장만 올려주세요`
          : buildMissingImageText(mention),
    });
    logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      slackUserId: userId,
      intent,
      receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      replyStatus: replied ? 'sent' : 'failed',
      ignoredReason:
        imageSelection.hasUnsupportedFiles || imageSelection.hasMultipleSupportedFiles
          ? 'unsupported_or_multiple_image'
          : 'missing_image',
    });
    await finalizeSlackEventReceipt({
      eventId: payload.event_id ?? undefined,
      status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      intent,
      ignoredReason:
        imageSelection.hasUnsupportedFiles || imageSelection.hasMultipleSupportedFiles
          ? 'unsupported_or_multiple_image'
          : 'missing_image',
      error: replied ? null : 'reply_failed',
    }).catch((error) => {
      logEvent('warn', 'slack.event_receipt_finalize_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        reason: error instanceof Error ? error.message : String(error),
      });
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
  let targetDisplayName = registrationState.user.displayName;
  if (intent === 'admin_checkin') {
    if (!targetUserId) {
      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: `<@${userId}> 대신 인증할 사용자를 멘션해주세요`,
      });
      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        replyStatus: replied ? 'sent' : 'failed',
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        ignoredReason: 'missing_target_user',
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'missing_target_user',
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, ignored: true };
    }

    const targetRegistrationState = await getSlackRegistrationState({
      db: prisma,
      workspaceId,
      externalSlackId: targetUserId,
      groupId: integration.groupId,
    });
    if (!targetRegistrationState.isRegistered || !targetRegistrationState.user) {
      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: `<@${targetUserId}>님은 아직 등록되지 않았어요. 먼저 \`${mention} 닉네임 설정 이름\`으로 등록해주세요.`,
      });
      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        replyStatus: replied ? 'sent' : 'failed',
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        ignoredReason: 'target_registration_required',
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'target_registration_required',
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, ignored: true };
    }
    targetDisplayName = targetRegistrationState.user.displayName;

    const adminValidation = await validateAdminProxyRequest({
      workspaceId,
      actorUserId: userId,
      targetUserId,
      groupId: integration.groupId,
    });
    if (!adminValidation.ok) {
      const replied = await sendSlackMessage({
        token,
        channelId,
        threadTs: event.ts,
        text: adminValidation.message,
      });
      logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: userId,
        intent,
        receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        replyStatus: replied ? 'sent' : 'failed',
        ignoredReason: 'admin_validation_failed',
      });
      await finalizeSlackEventReceipt({
        eventId: payload.event_id ?? undefined,
        status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'admin_validation_failed',
        error: replied ? null : 'reply_failed',
      }).catch((error) => {
        logEvent('warn', 'slack.event_receipt_finalize_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          slackUserId: userId,
          intent,
          reason: error instanceof Error ? error.message : String(error),
        });
      });
      return { ok: true, ignored: true };
    }
  }

  try {
    const result = await createFromSlackMessage({
      externalSlackId: targetUserId ?? userId,
      displayName: targetDisplayName,
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

    let currentStatusForAccepted: Awaited<ReturnType<typeof getCurrentStatus>> | null = null;
    if (result.status === 'accepted') {
      currentStatusForAccepted = await getCurrentStatus({
        workspaceId,
        channelId,
        externalSlackId: targetUserId ?? userId,
      }).catch((error) => {
        logEvent('warn', 'slack.current_status_load_failed', {
          eventType: 'slack_checkin',
          ...context,
          workspaceId,
          channelId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          slackUserId: targetUserId ?? userId,
          reason: error instanceof Error ? error.message : String(error),
          stage: 'accepted_reply',
        });
        return null;
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

    const replied = await replyForCheckInResult({
      token,
      workspaceId,
      channelId,
      threadTs: event.ts,
      actorUserId: userId,
      targetUserId: targetUserId ?? userId,
      displayName: targetDisplayName,
      mention,
      goalInfo,
      result,
      isAdminCheckIn: intent === 'admin_checkin',
      currentStatus: currentStatusForAccepted ?? undefined,
    });

    if (result.status === 'accepted' && currentStatusForAccepted) {
      const channelUpdateText = buildChannelStatusText(currentStatusForAccepted);
      const channelUpdateSent = await sendSlackMessage({
        token,
        channelId,
        text: channelUpdateText,
      });
      logEvent(channelUpdateSent ? 'info' : 'warn', channelUpdateSent ? 'slack.channel_update_sent' : 'slack.channel_update_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        slackUserId: targetUserId ?? userId,
        intent,
        replyStatus: channelUpdateSent ? 'sent' : 'failed',
      });
    }

    logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
      eventType: 'slack_checkin',
      ...context,
      workspaceId,
      channelId,
      groupId: integration.groupId,
      goalId: integration.goalId,
      slackUserId: targetUserId ?? userId,
      intent,
      receiptStatus: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      replyStatus: replied ? 'sent' : 'failed',
    });
    await finalizeSlackEventReceipt({
      eventId: payload.event_id ?? undefined,
      status: replied ? SlackEventReceiptStatus.COMPLETED : SlackEventReceiptStatus.FAILED,
      intent,
      error: replied ? null : 'reply_failed',
    }).catch((error) => {
      logEvent('warn', 'slack.event_receipt_finalize_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        slackUserId: targetUserId ?? userId,
        intent,
        reason: error instanceof Error ? error.message : String(error),
      });
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
    await finalizeSlackEventReceipt({
      eventId: payload.event_id ?? undefined,
      status: SlackEventReceiptStatus.FAILED,
      intent,
      error: error instanceof Error ? error.message : String(error),
    }).catch((finalizeError) => {
      logEvent('warn', 'slack.event_receipt_finalize_failed', {
        eventType: 'slack_checkin',
        ...context,
        workspaceId,
        channelId,
        slackUserId: targetUserId ?? userId,
        intent,
        reason: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
      });
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
  displayName: string;
  mention: string;
  goalInfo: {
    goalTitle: string;
    targetCount: number;
    penaltyText?: string;
  };
  result: Awaited<ReturnType<typeof createFromSlackMessage>>;
  isAdminCheckIn: boolean;
  currentStatus?: Awaited<ReturnType<typeof getCurrentStatus>>;
}) {
  if (input.result.status === 'registration_required') {
    return sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: buildRegistrationPromptText(input.goalInfo, input.mention),
    });
  }

  if (input.result.status === 'accepted') {
    return sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text: buildCheckInSuccessText({
        displayName: input.displayName,
        currentStatus: input.currentStatus,
      }),
    });
  }

  if (input.result.status === 'duplicate') {
    const text = input.isAdminCheckIn
      ? `<@${input.actorUserId}> <@${input.targetUserId}>의 오늘 인증은 이미 반영되었어요`
      : `오늘은 이미 인증 완료했어요 🙂\n사진을 바꾸려면 ${input.mention} 변경 을 사용해주세요`;
    return sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.threadTs,
      text,
    });
  }

  return false;
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

  return sendSlackMessage({
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

function getIntentFromCommandText(text: string): SlackIntent | null {
  const normalized = text.trim();
  if (!normalized) {
    return 'help';
  }

  if (/^(help|도움말)$/i.test(normalized)) {
    return 'help';
  }

  if (/^(현황)(?:\s+.*)?$/.test(normalized)) {
    return 'status';
  }

  if (/^(목표확인)(?:\s+.*)?$/.test(normalized)) {
    return 'goal_confirm';
  }

  if (/^(닉네임\s*설정|등록)(?:\s+.+)?$/.test(normalized)) {
    return 'register';
  }

  if (/^(변경)(?:\s+.*)?$/.test(normalized)) {
    return 'change';
  }

  if (/^(대신인증)(?:\s+.*)?$/.test(normalized) || normalized.includes('#대신인증')) {
    return 'admin_checkin';
  }

  if (containsCheckinIntent(normalized)) {
    return 'checkin';
  }

  return null;
}

function parseRegistrationName(text: string) {
  const normalized = stripBotMention(text, process.env.SLACK_BOT_USER_ID?.trim());
  const match = normalized.match(/^(?:닉네임\s*설정|등록)\s+(.+)$/);
  return match?.[1]?.trim() ?? '';
}

function findMentionedCommandText(texts: string[], botUserId?: string) {
  if (!botUserId) {
    return null;
  }

  return texts.find((text) => containsBotMention(text, botUserId)) ?? null;
}

function stripBotMention(text: string, botUserId?: string) {
  if (!botUserId) {
    return text.trim();
  }

  const mentionPattern = new RegExp(`<@${escapeRegExp(botUserId)}>`, 'g');
  return text.replace(mentionPattern, ' ').replace(/\s+/g, ' ').trim();
}

function containsBotMention(text: string, botUserId?: string) {
  if (!botUserId) {
    return false;
  }

  return text.includes(`<@${botUserId}>`);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildGoalInfoText(input: {
  goalTitle: string;
  targetCount: number;
  penaltyText?: string;
}) {
  const lines = [`현재 목표: ${input.goalTitle}`];
  if (input.penaltyText) {
    lines.push(`미달성 시 패널티: ${input.penaltyText}`);
  }
  return lines.join('\n');
}

function buildFirstVisitText(mention: string) {
  return [
    '처음 오셨네요 👋',
    '',
    '닉네임을 먼저 설정해주세요 🙂',
    '',
    `${mention} 닉네임 설정 홍길동`,
    '',
    '설정 후 운동 인증을 시작할 수 있어요 💪',
  ].join('\n');
}

function buildShortGuideText(mention: string) {
  return [
    '사용 방법이 필요하신가요? 🙂',
    '',
    '아래처럼 입력해 주세요 👇',
    '',
    `${mention} 닉네임 설정 홍길동`,
    `${mention} 인증 + 사진`,
    `${mention} 목표확인`,
  ].join('\n');
}

function buildMissingImageText(mention: string) {
  return [
    '사진을 함께 올려주세요 📸',
    '',
    '예:',
    `${mention} 인증 + 사진`,
  ].join('\n');
}

function buildRegistrationNamePromptText(mention: string) {
  return [
    '이름을 함께 입력해주세요.',
    '',
    '예:',
    `${mention} 닉네임 설정 홍길동`,
  ].join('\n');
}

function buildRegistrationPromptText(
  input: {
    goalTitle: string;
    targetCount: number;
    penaltyText?: string;
  },
  mention: string,
) {
  return [
    buildGoalInfoText(input),
    '',
    '처음 1회만 닉네임을 설정해주세요 🙂',
    '',
    `${mention} 닉네임 설정 홍길동`,
    '',
    '설정 후 바로 인증하실 수 있어요 💪',
  ].join('\n');
}

function buildRegistrationSuccessText(input: {
  displayName: string;
  mention: string;
  goalTitle: string;
  targetCount: number;
  penaltyText?: string;
}) {
  return [
    `${input.displayName}님, 설정 완료됐어요 👋`,
    '',
    buildGoalInfoText(input),
    '',
    `앞으로는 ${input.mention} 인증 + 사진을 함께 올리면 인증됩니다.`,
  ].join('\n');
}

function buildRegistrationRenameText(input: { displayName: string }) {
  return `이름이 ${input.displayName}님으로 변경되었습니다.`;
}

function buildCheckInSuccessText(input: {
  displayName: string;
  currentStatus?: Awaited<ReturnType<typeof getCurrentStatus>> | null;
}) {
  if (!input.currentStatus || !input.currentStatus.me) {
    return `${input.displayName}님, 오늘 인증 완료 💪`;
  }

  const remaining = Math.max(input.currentStatus.targetCount - input.currentStatus.me.count, 0);
  return [
    `${input.displayName}님, 오늘 인증 완료 💪`,
    '',
    '이번 주 진행도',
    `${formatProgressBar(input.currentStatus.me.count, input.currentStatus.targetCount)} ${input.currentStatus.me.count}/${input.currentStatus.targetCount}`,
    '',
    remaining > 0 ? `목표까지 ${remaining}회 남았어요` : '목표 달성했어요 🎉',
  ].join('\n');
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

function isSupportedMessageSubtype(subtype?: string) {
  return !subtype || subtype === 'file_share';
}

function getIgnoredMessageSubtypeReason(subtype?: string) {
  if (!subtype) {
    return null;
  }

  if (subtype === 'file_share') {
    return null;
  }

  return subtype;
}

function getIgnoredActorEventReason(event: SlackMessageEvent) {
  const configuredBotUserId = process.env.SLACK_BOT_USER_ID;

  if (event.subtype === 'message_changed') {
    return 'message_changed';
  }
  if (event.subtype === 'message_deleted') {
    return 'message_deleted';
  }
  if (event.subtype === 'message_replied') {
    return 'message_replied';
  }
  if (event.subtype === 'bot_message') {
    return 'bot_message';
  }
  if (event.subtype && !isSupportedMessageSubtype(event.subtype)) {
    return `subtype_${event.subtype}`;
  }
  if (event.bot_id) {
    return 'bot_id';
  }
  if (event.app_id) {
    return 'app_id';
  }
  if (Boolean(configuredBotUserId) && event.user === configuredBotUserId) {
    return 'configured_bot_user';
  }

  return null;
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
