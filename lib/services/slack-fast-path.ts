import { SlackEventJobStatus, SlackEventJobType, SlackEventReceiptStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { logEvent, type LogContext } from '@/lib/observability/logger';
import {
  claimSlackEventReceipt,
  finalizeSlackEventReceipt,
  analyzeSlackIntent,
} from '@/lib/services/slack';
import {
  buildGoalConfirmText,
  buildGoalInfoText,
  buildThreadStatusText,
  formatProgressBar,
  getCurrentStatus,
} from '@/lib/services/rankings';
import {
  enqueueSlackBackgroundJob,
} from '@/lib/services/slack-event-jobs';
import { getSlackRegistrationState } from '@/lib/services/users';
import { createFromSlackMessage } from '@/lib/services/check-ins';
import { postSlackMessage, formatSlackMention } from '@/lib/slack/client';
import { toSlackTimestampDate } from '@/lib/domain/date';

type SlackEventFile = {
  id?: string;
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

type SlackMessageEvent = {
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
};

type FastPathInput = {
  payload: Record<string, any>;
  requestId: string;
  retryNum?: string | null;
  retryReason?: string | null;
};

const REPLY_STALE_MS = 2 * 60 * 1000;

export async function processSlackFastPath(input: FastPathInput) {
  if (input.payload.type !== 'event_callback' || !input.payload.event) {
    return { ok: true, ignored: true as const };
  }

  const event = input.payload.event as SlackMessageEvent;
  const workspaceId = input.payload.authorizations?.[0]?.team_id ?? input.payload.team_id;
  const channelId = event.channel;
  const slackUserId = event.user;
  const botUserId = process.env.SLACK_BOT_USER_ID?.trim();

  const isChannelContext =
    typeof channelId === 'string' && (channelId.startsWith('C') || channelId.startsWith('G'));
  const isDirectMessageContext = typeof channelId === 'string' && channelId.startsWith('D');
  const isThreadReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  const ignoredActorReason = getIgnoredActorEventReason(event, botUserId);

  if (!workspaceId || !channelId || !slackUserId || ignoredActorReason || (!isChannelContext && !isDirectMessageContext)) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      workspaceId: workspaceId ?? undefined,
      channelId: channelId ?? undefined,
      slackUserId: slackUserId ?? undefined,
      ignoredReason: ignoredActorReason ?? null,
      reason: !workspaceId
        ? 'missing_workspace_id'
        : !channelId
          ? 'missing_channel_id'
          : !slackUserId
            ? 'missing_user_id'
            : !isChannelContext && !isDirectMessageContext
              ? 'invalid_context'
              : ignoredActorReason ?? 'bot_actor_event',
    });
    return { ok: true, ignored: true as const };
  }

  if (isThreadReply) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      workspaceId,
      channelId,
      slackUserId,
      ignoredReason: 'thread_reply',
      reason: 'thread_reply',
    });
    return { ok: true, ignored: true as const };
  }

  if (!botUserId) {
    logEvent('warn', 'slack.ignored_event', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      workspaceId,
      channelId,
      slackUserId,
      ignoredReason: 'missing_bot_user_id',
      reason: 'missing_bot_user_id',
    });
    return { ok: true, ignored: true as const };
  }

  const intentAnalysis = analyzeSlackIntent(input.payload, event, botUserId, {
    allowNoMention: isDirectMessageContext,
  });
  const intent = intentAnalysis.intent;
  const commandText = intentAnalysis.commandText;
  const hasMention = isDirectMessageContext
    ? true
    : Boolean(commandText || intentAnalysis.reason !== 'no_bot_mention');

  if (!hasMention) {
    logEvent('info', 'slack.ignored_event', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      workspaceId,
      channelId,
      slackUserId,
      ignoredReason: 'no_bot_mention',
      reason: 'no_bot_mention',
    });
    return { ok: true, ignored: true as const };
  }

  const receiptClaim = await claimSlackEventReceipt({
    eventId: input.payload.event_id ?? undefined,
    requestId: input.requestId,
    retryNum: input.retryNum,
    retryReason: input.retryReason,
    workspaceId,
    channelId,
    slackUserId,
    eventType: event.type ?? 'message',
  });

  if (receiptClaim.processing) {
    logEvent('info', 'slack.receipt_processing', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      workspaceId,
      channelId,
      slackUserId,
      intent,
      receiptStatus: receiptClaim.receipt?.status ?? 'PROCESSING',
      reason: 'processing_in_progress',
    });
    return { ok: true, ignored: true as const };
  }

  if (receiptClaim.staleRetry) {
    logEvent('info', 'slack.receipt_stale_retry', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      workspaceId,
      channelId,
      slackUserId,
      intent,
      receiptStatus: receiptClaim.receipt?.status ?? 'PROCESSING',
      retryCount: receiptClaim.receipt?.retryCount ?? 0,
    });
  }

  if (receiptClaim.duplicate) {
    logEvent('info', 'slack.receipt_duplicate_done', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      workspaceId,
      channelId,
      slackUserId,
      intent,
      receiptStatus: receiptClaim.receipt?.status ?? 'PROCESSING',
      ignoredReason: 'duplicate_event_id',
      reason: 'duplicate_event_id',
      replyStatus: 'skipped',
    });
    return { ok: true, ignored: true as const };
  }

  const receipt = receiptClaim.receipt;
  if (!receipt) {
    return { ok: true, ignored: true as const };
  }

  logEvent('info', 'slack.event_receipt_claimed', {
    eventType: 'slack_fast_path',
    requestId: input.requestId,
    workspaceId,
    channelId,
    slackUserId,
    intent,
    receiptStatus: receipt.status,
  });

  const integration = await prisma.slackIntegration.findUnique({
    where: {
      workspaceId_channelId: {
        workspaceId,
        channelId,
      },
    },
    include: { group: true, goal: true },
  });

  if (!integration) {
    await finalizeSlackEventReceipt({
      eventId: input.payload.event_id ?? undefined,
      status: SlackEventReceiptStatus.DONE,
      intent,
      ignoredReason: 'integration_not_found',
      processedAt: new Date(),
    }).catch((error) => {
      logEvent('warn', 'slack.event_receipt_finalize_failed', {
        eventType: 'slack_fast_path',
        requestId: input.requestId,
        workspaceId,
        channelId,
        slackUserId,
        intent,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
    return { ok: true, ignored: true as const, reason: 'integration_not_found' };
  }

  const registrationState = await getSlackRegistrationState({
    db: prisma,
    workspaceId,
    externalSlackId: slackUserId,
    groupId: integration.groupId,
  });

  const pendingNickname = await hasPendingNicknameSaveJob({
    workspaceId,
    slackUserId,
  });

  const token = process.env.SLACK_BOT_TOKEN ?? integration.botToken ?? undefined;
  const mention = formatSlackMention(botUserId);

  if (intent === 'status') {
    const status = await getCurrentStatus({
      workspaceId,
      channelId,
      externalSlackId: slackUserId,
    });
    const reply = await sendThreadReplyWithReceiptMarkers({
      receiptId: receipt.id,
      token,
      channelId,
      threadTs: event.ts,
      text: buildThreadStatusText(status),
      context: {
        requestId: input.requestId,
        eventId: input.payload.event_id ?? undefined,
        workspaceId,
        channelId,
        slackUserId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        intent,
      },
    });

    if ('skipped' in reply && reply.skipped && reply.reason === 'recent_attempt') {
      return { ok: true, ignored: true as const, reason: 'recent_attempt' };
    }

    await finalizeSlackEventReceipt({
      eventId: input.payload.event_id ?? undefined,
      status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
      intent,
      error: reply.ok ? null : 'reply_failed',
      processedAt: new Date(),
    }).catch(() => undefined);
    return { ok: true, replied: reply.ok };
  }

  if (intent === 'goal_confirm') {
    const status = await getCurrentStatus({
      workspaceId,
      channelId,
      externalSlackId: slackUserId,
    });
    const reply = await sendThreadReplyWithReceiptMarkers({
      receiptId: receipt.id,
      token,
      channelId,
      threadTs: event.ts,
      text: status && status.me
        ? buildGoalConfirmText({
            goalTitle: integration.goal.title,
            targetCount: integration.goal.targetCount,
            penaltyText: undefined,
            displayName: status.me.displayName,
            count: status.me.count,
          })
        : `${buildGoalInfoText({
            goalTitle: integration.goal.title,
            targetCount: integration.goal.targetCount,
          })}\n\n이번 주 현황을 불러오지 못했어요. 잠시 후 다시 시도해주세요.`,
      context: {
        requestId: input.requestId,
        eventId: input.payload.event_id ?? undefined,
        workspaceId,
        channelId,
        slackUserId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        intent,
      },
    });

    if ('skipped' in reply && reply.skipped && reply.reason === 'recent_attempt') {
      return { ok: true, ignored: true as const, reason: 'recent_attempt' };
    }

    await finalizeSlackEventReceipt({
      eventId: input.payload.event_id ?? undefined,
      status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
      intent,
      error: reply.ok ? null : 'reply_failed',
      processedAt: new Date(),
    }).catch(() => undefined);
    return { ok: true, replied: reply.ok };
  }

  if (intent === 'register') {
    const nickname = parseNicknameFromCommandText(commandText);
    if (!nickname) {
      const reply = await sendThreadReplyWithReceiptMarkers({
        receiptId: receipt.id,
        token,
        channelId,
        threadTs: event.ts,
        text: buildNicknamePromptText(mention),
        context: {
          requestId: input.requestId,
          eventId: input.payload.event_id ?? undefined,
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          intent,
        },
      });

      if ('skipped' in reply && reply.skipped && reply.reason === 'recent_attempt') {
        return { ok: true, ignored: true as const, reason: 'recent_attempt' };
      }

      await finalizeSlackEventReceipt({
        eventId: input.payload.event_id ?? undefined,
        status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'registration_required',
        error: reply.ok ? null : 'reply_failed',
        processedAt: new Date(),
      }).catch(() => undefined);
      return { ok: true, replied: reply.ok };
    }

    await enqueueSlackBackgroundJob({
      eventId: input.payload.event_id ?? `${input.requestId}-nickname`,
      workspaceId,
      channelId,
      slackUserId,
      groupId: integration.groupId,
      goalId: integration.goalId,
      jobType: SlackEventJobType.NICKNAME_SAVE,
      payload: {
        workspaceId,
        channelId,
        slackUserId,
        groupId: integration.groupId,
        nickname,
        providerUsername: event.username ?? null,
        requestId: input.requestId,
        eventId: input.payload.event_id ?? null,
      },
    });
    logEvent('info', 'slack.job_created', {
      eventType: 'slack_fast_path',
      requestId: input.requestId,
      eventId: input.payload.event_id ?? undefined,
      workspaceId,
      channelId,
      slackUserId,
      groupId: integration.groupId,
      goalId: integration.goalId,
      jobType: SlackEventJobType.NICKNAME_SAVE,
    });

    const reply = await sendThreadReplyWithReceiptMarkers({
      receiptId: receipt.id,
      token,
      channelId,
      threadTs: event.ts,
      text: `${nickname} 닉네임을 저장해둘게요!`,
      context: {
        requestId: input.requestId,
        eventId: input.payload.event_id ?? undefined,
        workspaceId,
        channelId,
        slackUserId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        intent,
      },
    });

    if ('skipped' in reply && reply.skipped && reply.reason === 'recent_attempt') {
      return { ok: true, ignored: true as const, reason: 'recent_attempt' };
    }

    await finalizeSlackEventReceipt({
      eventId: input.payload.event_id ?? undefined,
      status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
      intent,
      processedAt: new Date(),
      error: reply.ok ? null : 'reply_failed',
    }).catch(() => undefined);

    return { ok: true, replied: reply.ok };
  }

  if (intent === 'checkin' || intent === 'admin_checkin') {
    if (pendingNickname) {
      const reply = await sendThreadReplyWithReceiptMarkers({
        receiptId: receipt.id,
        token,
        channelId,
        threadTs: event.ts,
        text: '닉네임 설정이 아직 반영 중이에요.\n잠시 후 다시 인증해주세요 🙂',
        context: {
          requestId: input.requestId,
          eventId: input.payload.event_id ?? undefined,
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          intent,
        },
      });

      if ('skipped' in reply && reply.skipped && reply.reason === 'recent_attempt') {
        return { ok: true, ignored: true as const, reason: 'recent_attempt' };
      }

      await finalizeSlackEventReceipt({
        eventId: input.payload.event_id ?? undefined,
        status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'nickname_pending',
        error: reply.ok ? null : 'reply_failed',
        processedAt: new Date(),
      }).catch(() => undefined);
      return { ok: true, replied: reply.ok, reason: 'nickname_pending' };
    }

    if (!registrationState.isRegistered) {
      const reply = await sendThreadReplyWithReceiptMarkers({
        receiptId: receipt.id,
        token,
        channelId,
        threadTs: event.ts,
        text: buildRegistrationPromptText(botUserId),
        context: {
          requestId: input.requestId,
          eventId: input.payload.event_id ?? undefined,
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          intent,
        },
      });

      if ('skipped' in reply && reply.skipped && reply.reason === 'recent_attempt') {
        return { ok: true, ignored: true as const, reason: 'recent_attempt' };
      }

      await finalizeSlackEventReceipt({
        eventId: input.payload.event_id ?? undefined,
        status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'registration_required',
        error: reply.ok ? null : 'reply_failed',
        processedAt: new Date(),
      }).catch(() => undefined);
      return { ok: true, replied: reply.ok, reason: 'registration_required' };
    }

    if (!hasImageAttachment(event.files)) {
      const reply = await sendThreadReplyWithReceiptMarkers({
        receiptId: receipt.id,
        token,
        channelId,
        threadTs: event.ts,
        text: buildMissingImageText(mention),
        context: {
          requestId: input.requestId,
          eventId: input.payload.event_id ?? undefined,
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          intent,
        },
      });

      if ('skipped' in reply && reply.skipped && reply.reason === 'recent_attempt') {
        return { ok: true, ignored: true as const, reason: 'recent_attempt' };
      }

      await finalizeSlackEventReceipt({
        eventId: input.payload.event_id ?? undefined,
        status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'missing_image',
        error: reply.ok ? null : 'reply_failed',
        processedAt: new Date(),
      }).catch(() => undefined);
      return { ok: true, replied: reply.ok, reason: 'missing_image' };
    }

    const selectedFile = selectSupportedSlackImageFile(event.files);
    if (!selectedFile) {
      const reply = await sendThreadReplyWithReceiptMarkers({
        receiptId: receipt.id,
        token,
        channelId,
        threadTs: event.ts,
        text: buildMissingImageText(mention),
        context: {
          requestId: input.requestId,
          eventId: input.payload.event_id ?? undefined,
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          intent,
        },
      });

      await finalizeSlackEventReceipt({
        eventId: input.payload.event_id ?? undefined,
        status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
        intent,
        ignoredReason: 'missing_image',
        error: reply.ok ? null : 'reply_failed',
        processedAt: new Date(),
      }).catch(() => undefined);
      return { ok: true, replied: reply.ok, reason: 'missing_image' };
    }

    const result = await createFromSlackMessage({
      externalSlackId: slackUserId,
      displayName: registrationState.user.displayName,
      workspaceId,
      channelId,
      sourceMessageId: event.client_msg_id ?? event.ts ?? input.payload.event_id ?? input.requestId,
      photo: {
        blobUrl: null,
        slackOriginalUrl: selectedFile.url_private_download ?? selectedFile.url_private ?? null,
        mimeType: selectedFile.mimetype,
        uploadFailed: false,
      },
      note: event.text,
      checkedAt: toSlackTimestampDate(event.ts),
      allowChangeCandidateOnDuplicate: intent !== 'admin_checkin',
      context: {
        requestId: input.requestId,
        eventId: input.payload.event_id ?? undefined,
        slackUserId,
        workspaceId,
        channelId,
        groupId: integration.groupId,
        goalId: integration.goalId,
      },
    });

    const currentStatus =
      result.status === 'accepted'
        ? await getCurrentStatus({
            workspaceId,
            channelId,
            externalSlackId: slackUserId,
          }).catch((error) => {
            logEvent('warn', 'slack.current_status_load_failed', {
              eventType: 'slack_fast_path',
              requestId: input.requestId,
              eventId: input.payload.event_id ?? undefined,
              workspaceId,
              channelId,
              slackUserId,
              groupId: integration.groupId,
              goalId: integration.goalId,
              reason: error instanceof Error ? error.message : String(error),
            });
            return null;
          })
        : undefined;

    const replyText =
      result.status === 'accepted'
        ? buildCheckInSuccessText({
            displayName: registrationState.user.displayName,
            currentStatus: currentStatus ?? undefined,
          })
        : result.status === 'duplicate'
          ? '오늘은 이미 인증 완료했어요 🙂\n사진을 바꾸려면 이 채팅에서 변경을 입력해주세요'
          : buildRegistrationPromptText(botUserId);

    const reply = await sendThreadReplyWithReceiptMarkers({
      receiptId: receipt.id,
      token,
      channelId,
      threadTs: event.ts,
      text: replyText,
      context: {
        requestId: input.requestId,
        eventId: input.payload.event_id ?? undefined,
        workspaceId,
        channelId,
        slackUserId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        intent,
      },
    });

    if (reply.ok && result.status === 'accepted' && currentStatus) {
      const channelUpdateSent = await postSlackMessage({
        token,
        channelId,
        text: buildThreadStatusText(currentStatus),
      });
      if (!channelUpdateSent.ok) {
        logEvent('warn', 'slack.channel_status_failed', {
          eventType: 'slack_fast_path',
          requestId: input.requestId,
          eventId: input.payload.event_id ?? undefined,
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
        });
      } else {
        logEvent('info', 'slack.channel_status_sent', {
          eventType: 'slack_fast_path',
          requestId: input.requestId,
          eventId: input.payload.event_id ?? undefined,
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
        });
      }
    }

    if (
      reply.ok &&
      (result.status === 'accepted' || result.status === 'duplicate') &&
      selectedFile
    ) {
      await enqueueSlackBackgroundJob({
        eventId: input.payload.event_id ?? `${input.requestId}-asset`,
        workspaceId,
        channelId,
        slackUserId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        jobType: SlackEventJobType.CHECKIN_ASSET_UPLOAD,
        payload: {
          workspaceId,
          channelId,
          slackUserId,
          groupId: integration.groupId,
          goalId: integration.goalId,
          sourceMessageId: event.client_msg_id ?? event.ts ?? input.payload.event_id ?? input.requestId,
          recordDate: toSlackTimestampDate(event.ts).toISOString(),
          selectedFile: {
            id: selectedFile.id ?? null,
            mimetype: selectedFile.mimetype ?? null,
            size: selectedFile.size ?? null,
            url_private: selectedFile.url_private ?? null,
            url_private_download: selectedFile.url_private_download ?? null,
          },
          rawSubmissionId: result.status === 'accepted' ? result.rawSubmissionId ?? null : null,
          submissionAssetId: result.status === 'accepted' ? result.submissionAssetId ?? null : null,
          changeCandidateId: result.status === 'duplicate' ? result.candidateId ?? null : null,
          assetStatus: result.status,
        },
      });
      logEvent('info', 'slack.job_created', {
        eventType: 'slack_fast_path',
        requestId: input.requestId,
        eventId: input.payload.event_id ?? undefined,
        workspaceId,
        channelId,
        slackUserId,
        groupId: integration.groupId,
        goalId: integration.goalId,
        jobType: SlackEventJobType.CHECKIN_ASSET_UPLOAD,
      });
    }

    await finalizeSlackEventReceipt({
      eventId: input.payload.event_id ?? undefined,
      status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
      intent,
      error: reply.ok ? null : 'reply_failed',
      processedAt: new Date(),
    }).catch(() => undefined);

    return {
      ok: true,
      replied: reply.ok,
      result: result.status,
      currentStatus: currentStatus ?? undefined,
    };
  }

  const reply = await sendThreadReplyWithReceiptMarkers({
    receiptId: receipt.id,
    token,
    channelId,
    threadTs: event.ts,
    text: buildShortGuideText(botUserId),
    context: {
      requestId: input.requestId,
      eventId: input.payload.event_id ?? undefined,
      workspaceId,
      channelId,
      slackUserId,
      groupId: integration.groupId,
      goalId: integration.goalId,
      intent,
    },
  });

  await finalizeSlackEventReceipt({
    eventId: input.payload.event_id ?? undefined,
    status: reply.ok ? SlackEventReceiptStatus.DONE : SlackEventReceiptStatus.FAILED,
    intent,
    error: reply.ok ? null : 'reply_failed',
    processedAt: new Date(),
  }).catch(() => undefined);

  return { ok: true, replied: reply.ok };
}

async function sendThreadReplyWithReceiptMarkers(input: {
  receiptId: string;
  token?: string;
  channelId: string;
  threadTs?: string;
  text: string;
  context: LogContext;
}) {
  const current = await prisma.slackEventReceipt.findUnique({
    where: { id: input.receiptId },
    select: {
      id: true,
      replyAttemptedAt: true,
      replySentAt: true,
    },
  });

  if (!current) {
    return { ok: false, skipped: true, reason: 'missing_receipt' };
  }

  if (current.replySentAt) {
    return { ok: true, skipped: true, reason: 'already_sent' };
  }

  if (
    current.replyAttemptedAt &&
    Date.now() - current.replyAttemptedAt.getTime() < REPLY_STALE_MS
  ) {
    return { ok: true, skipped: true, reason: 'recent_attempt' };
  }

  await prisma.slackEventReceipt.update({
    where: { id: input.receiptId },
    data: {
      replyAttemptedAt: new Date(),
      lastError: null,
    },
  });
  logEvent('info', 'slack.reply_send_started', {
    ...input.context,
    eventType: 'slack_fast_path',
    replyStatus: 'attempting',
  });

  const reply = await postSlackMessage({
    token: input.token,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: input.text,
  });

  if (reply.ok) {
    await prisma.slackEventReceipt.update({
      where: { id: input.receiptId },
      data: {
        replySentAt: new Date(),
        replySlackTs: reply.ts ?? null,
        lastError: null,
      },
    });
    logEvent('info', 'slack.reply_marker_saved', {
      ...input.context,
      eventType: 'slack_fast_path',
      replyStatus: 'saved',
      replySlackTs: reply.ts ?? null,
    });
  } else {
    await prisma.slackEventReceipt.update({
      where: { id: input.receiptId },
      data: {
        lastError: reply.error ?? 'reply_failed',
      },
    });
  }

  logEvent(reply.ok ? 'info' : 'warn', reply.ok ? 'slack.reply_sent' : 'slack.reply_failed', {
    ...input.context,
    eventType: 'slack_fast_path',
    replyStatus: reply.ok ? 'sent' : 'failed',
  });

  return reply;
}

async function hasPendingNicknameSaveJob(input: { workspaceId: string; slackUserId: string }) {
  const active = await prisma.slackEventJob.findFirst({
    where: {
      jobType: SlackEventJobType.NICKNAME_SAVE,
      workspaceId: input.workspaceId,
      slackUserId: input.slackUserId,
      OR: [
        { status: SlackEventJobStatus.PENDING },
        { status: SlackEventJobStatus.PROCESSING },
        { status: SlackEventJobStatus.FAILED },
      ],
    },
    select: { id: true },
  });
  return Boolean(active);
}

function getIgnoredActorEventReason(event: SlackMessageEvent, botUserId?: string | null) {
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
  if (event.bot_id) {
    return 'bot_id';
  }
  if (event.app_id) {
    return 'app_id';
  }
  if (botUserId && event.user === botUserId) {
    return 'configured_bot_user';
  }
  return null;
}

function hasImageAttachment(files?: SlackEventFile[]) {
  return Boolean(files?.some((file) => isSupportedSlackImageMimeType(file.mimetype)));
}

function selectSupportedSlackImageFile(files?: SlackEventFile[]) {
  return files?.find((file) => isSupportedSlackImageMimeType(file.mimetype)) ?? null;
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

function parseNicknameFromCommandText(text: string) {
  const normalized = stripBotMention(text);
  const match = normalized.match(/^(?:닉네임\s*설정|등록)\s+(.+)$/);
  return match?.[1]?.trim() ?? '';
}

function stripBotMention(text: string) {
  return text.replace(/\s+/g, ' ').trim();
}

function buildNicknamePromptText(mention: string) {
  return `${mention} 닉네임 설정 이름`;
}

function buildRegistrationPromptText(botUserId?: string | null) {
  const mention = formatSlackMention(botUserId);
  return `${mention} 닉네임 설정 이름으로 먼저 등록해주세요.`;
}

function buildMissingImageText(mention: string) {
  return `${mention} 사진 1장을 함께 올려주세요`;
}

function buildShortGuideText(botUserId?: string | null) {
  const mention = formatSlackMention(botUserId);
  return [
    '사용 방법 👇',
    '',
    `${mention} 닉네임 설정 홍길동`,
    `${mention} 인증 + 사진`,
    `${mention} 목표확인`,
    `${mention} 현황`,
  ].join('\n');
}

function buildCheckInSuccessText(input: {
  displayName: string;
  currentStatus?: Awaited<ReturnType<typeof getCurrentStatus>> | null;
}) {
  const currentCount = input.currentStatus?.me?.count ?? 0;
  const targetCount = input.currentStatus?.targetCount ?? 0;
  const remainingCount = Math.max(targetCount - currentCount, 0);
  const progressBar = formatProgressBar(currentCount, targetCount);

  return [
    `${input.displayName}님, 오늘 인증 완료 💪`,
    '',
    '이번 주 진행도',
    `${progressBar} ${currentCount}/${targetCount}`,
    '',
    `목표까지 ${remainingCount}회 남았어요`,
  ].join('\n');
}
