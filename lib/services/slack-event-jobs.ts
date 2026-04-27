import {
  Prisma,
  SlackEventJobResultStatus,
  SlackEventJobStatus,
  SlackEventJobType,
  SlackEventReceiptStatus,
  SubmissionAssetStatus,
} from '@prisma/client';
import { after } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logEvent, maskSlackFileUrl, type LogContext } from '@/lib/observability/logger';
import {
  createFromSlackMessage,
  replaceTodayFromSlackMessage,
  updateSlackChangeCandidateAsset,
  updateSlackSubmissionAsset,
} from '@/lib/services/check-ins';
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
import {
  getGroupRuntimeSettings,
  formatWeeklyPenaltyDisplayText,
  updateActiveGoalTargetCount,
  upsertGroupWeeklyPenaltyText,
} from '@/lib/services/group-settings';
import { formatSlackMention, sendSlackDirectMessage, sendSlackMessage } from '@/lib/slack/client';
import { storeSlackPhotoToBlob } from '@/lib/slack/file-storage';
import { analyzeSlackIntent } from '@/lib/services/slack';
import { toSlackTimestampDate } from '@/lib/domain/date';
import {
  normalizeSlackEventPayload,
  validateSlackEventPayloadForWrite,
  type NormalizedSlackEventPayload,
  type SlackEventPayload,
} from '@/lib/slack/payload-normalizer';

const STALE_PROCESSING_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const JOB_BATCH_SIZE = 10;

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

type SlackEventJobRecord = {
  id: string;
  receiptId: string | null;
  eventId: string;
  workspaceId: string;
  channelId: string;
  slackUserId: string | null;
  groupId: string | null;
  goalId: string | null;
  jobType: SlackEventJobType | null;
  intent: string | null;
  resultStatus: SlackEventJobResultStatus | null;
  payload: Prisma.JsonValue;
  status: SlackEventJobStatus;
  attempts: number;
  lockedAt: Date | null;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  nextRetryAt: Date | null;
  lastError: string | null;
  checkInRecordId: string | null;
  rawSubmissionId: string | null;
  submissionAssetId: string | null;
  changeCandidateId: string | null;
  replySentAt: Date | null;
  channelStatusSentAt: Date | null;
  assetUploadedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type EnqueueSlackEventJobInput = {
  payload: SlackEventPayload;
  normalized?: NormalizedSlackEventPayload;
  requestId: string;
  retryNum?: string | null;
  retryReason?: string | null;
  jobType?: SlackEventJobType | null;
};

export async function enqueueSlackBackgroundJob(input: {
  eventId: string;
  workspaceId: string;
  channelId: string;
  slackUserId?: string | null;
  groupId?: string | null;
  goalId?: string | null;
  jobType: SlackEventJobType;
  payload: Prisma.JsonObject;
}) {
  return prisma.slackEventJob.upsert({
    where: {
      workspaceId_eventId: {
        workspaceId: input.workspaceId,
        eventId: input.eventId,
      },
    },
    create: {
      eventId: input.eventId,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      slackUserId: input.slackUserId ?? null,
      groupId: input.groupId ?? null,
      goalId: input.goalId ?? null,
      jobType: input.jobType,
      payload: input.payload,
      status: SlackEventJobStatus.PENDING,
    },
    update: {
      channelId: input.channelId,
      slackUserId: input.slackUserId ?? null,
      groupId: input.groupId ?? null,
      goalId: input.goalId ?? null,
      jobType: input.jobType,
      payload: input.payload,
      status: SlackEventJobStatus.PENDING,
      attempts: 0,
      lockedAt: null,
      processingStartedAt: null,
      processedAt: null,
      nextRetryAt: null,
      lastError: null,
    },
  });
}

type ClaimJobInput = {
  jobId?: string;
  workspaceId?: string;
  eventId?: string;
  includeStale?: boolean;
  includeFailed?: boolean;
};

export async function enqueueSlackEventJob(input: EnqueueSlackEventJobInput) {
  const normalized = input.normalized ?? normalizeSlackEventPayload(input.payload);
  const validation = validateSlackEventPayloadForWrite(normalized);

  if (!validation.ok) {
    logEvent('warn', 'slack.event_ignored_invalid_payload', {
      eventType: 'slack_event_job',
      requestId: input.requestId,
      eventId: normalized.eventId ?? undefined,
      workspaceId: normalized.workspaceId ?? undefined,
      channelId: normalized.channelId ?? undefined,
      slackUserId: normalized.slackUserId ?? undefined,
      payloadType: normalized.payloadType,
      eventTypeValue: normalized.eventType,
      missingFields: validation.missingFields,
      reason: validation.reason,
    });
    return { receipt: null, job: null };
  }

  const eventId = normalized.eventId as string;
  const workspaceId = normalized.workspaceId as string;
  const channelId = normalized.channelId as string;
  const slackUserId = normalized.slackUserId;

  const receipt = await prisma.slackEventReceipt.upsert({
    where: {
      workspaceId_eventId: {
        workspaceId,
        eventId,
      },
    },
    create: {
      eventId,
      requestId: input.requestId,
      workspaceId,
      channelId,
      slackUserId,
      eventType: normalized.eventType,
      retryNum: toPositiveInteger(input.retryNum),
      retryReason: input.retryReason ?? null,
      status: SlackEventReceiptStatus.RECEIVED,
      receivedAt: new Date(),
    },
    update: {
      requestId: input.requestId,
      channelId,
      slackUserId,
      eventType: normalized.eventType,
      retryNum: toPositiveInteger(input.retryNum),
      retryReason: input.retryReason ?? null,
      status: SlackEventReceiptStatus.RECEIVED,
      receivedAt: new Date(),
      ackAt: null,
    },
  });

  const job = await prisma.slackEventJob.upsert({
    where: {
      workspaceId_eventId: {
        workspaceId,
        eventId,
      },
    },
    create: {
      receiptId: receipt.id,
      eventId,
      workspaceId,
      channelId,
      slackUserId,
      groupId: null,
      goalId: null,
      jobType: input.jobType ?? null,
      intent: null,
      payload: input.payload as Prisma.JsonObject,
      status: SlackEventJobStatus.PENDING,
    },
    update: {
      receiptId: receipt.id,
      channelId,
      slackUserId,
      jobType: input.jobType ?? null,
      payload: input.payload as Prisma.JsonObject,
    },
  });

  return { receipt, job };
}

export async function ackSlackEventReceipt(input: { receiptId?: string | null }) {
  if (!input.receiptId) {
    return;
  }

  await prisma.slackEventReceipt.update({
    where: { id: input.receiptId },
    data: {
      status: SlackEventReceiptStatus.ACKED,
      ackAt: new Date(),
    },
  });
}

export async function scheduleSlackEventJobProcessing(input: { jobId?: string }) {
  const jobId = input.jobId;
  if (!jobId) {
    return;
  }

  after(() => {
    void processSlackEventJobs({ jobIds: [jobId], limit: 1 }).catch((error) => {
      logEvent('error', 'slack.event_job_processing_failed', {
        eventType: 'slack_event_job',
        jobId,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

export async function processSlackEventJobs(input?: {
  jobIds?: string[];
  workspaceId?: string;
  limit?: number;
}) {
  const limit = input?.limit ?? JOB_BATCH_SIZE;
  const claimedJobs: SlackEventJobRecord[] = [];

  while (claimedJobs.length < limit) {
    const nextJobId = input?.jobIds?.[claimedJobs.length];
    if (input?.jobIds && !nextJobId) {
      break;
    }

    const job = await claimSlackEventJob({
      jobId: nextJobId,
      workspaceId: input?.workspaceId,
      includeFailed: true,
      includeStale: true,
    });

    if (!job) {
      break;
    }

    claimedJobs.push(job);
    await processSlackEventJob(job).catch((error) => {
      void finalizeJob(job.id, {
        status: SlackEventJobStatus.FAILED,
        processedAt: new Date(),
        resultStatus: job.resultStatus ?? null,
        lastError: error instanceof Error ? error.message : String(error),
        groupId: job.groupId ?? null,
        goalId: job.goalId ?? null,
      });
      logEvent('error', 'slack.event_failed', {
        eventType: 'slack_event_job',
        jobId: job.id,
        eventId: job.eventId,
        workspaceId: job.workspaceId,
        channelId: job.channelId,
        slackUserId: job.slackUserId ?? undefined,
        reason: error instanceof Error ? error.message : String(error),
      });
    });
  }

  return { claimed: claimedJobs.length };
}

export async function processSlackEventJobById(jobId: string) {
  try {
    const job = await claimSlackEventJob({ jobId, includeFailed: true, includeStale: true });
    if (!job) {
      return { claimed: false };
    }

    await processSlackEventJob(job);
    return { claimed: true };
  } catch (error) {
    logEvent('error', 'slack.event_job_processing_failed', {
      eventType: 'slack_event_job',
      jobId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { claimed: false };
  }
}

export async function reapSlackEventJobs() {
  return processSlackEventJobs({ limit: JOB_BATCH_SIZE });
}

async function claimSlackEventJob(input: ClaimJobInput): Promise<SlackEventJobRecord | null> {
  const cutoff = new Date(Date.now() - PROCESSING_LEASE_MS);
  const maxAttempts = MAX_ATTEMPTS;

  const baseWhere: Prisma.Sql[] = [
    Prisma.sql`"attempts" < ${maxAttempts}`,
  ];

  if (input.jobId) {
    baseWhere.push(Prisma.sql`"id" = ${input.jobId}`);
  }
  if (input.workspaceId) {
    baseWhere.push(Prisma.sql`"workspaceId" = ${input.workspaceId}`);
  }
  if (input.eventId) {
    baseWhere.push(Prisma.sql`"eventId" = ${input.eventId}`);
  }

  const statusClauses: Prisma.Sql[] = [
    Prisma.sql`"status" = ${SlackEventJobStatus.PENDING}::"SlackEventJobStatus"`,
  ];

  if (input.includeFailed ?? true) {
    statusClauses.push(
      Prisma.sql`("status" = ${SlackEventJobStatus.FAILED}::"SlackEventJobStatus" AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= NOW()))`,
    );
  }

  if (input.includeStale ?? true) {
    statusClauses.push(
      Prisma.sql`("status" = ${SlackEventJobStatus.PROCESSING}::"SlackEventJobStatus" AND ("lockedAt" IS NULL OR "lockedAt" < ${cutoff}))`,
    );
  }

  const whereClause = Prisma.sql`
    ${Prisma.join(baseWhere, ' AND ')}
    AND (${Prisma.join(statusClauses, ' OR ')})
  `;

  const rows = await prisma.$queryRaw<SlackEventJobRecord[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id"
      FROM "SlackEventJob"
      WHERE ${whereClause}
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SlackEventJob" AS job
    SET
      "status" = ${SlackEventJobStatus.PROCESSING}::"SlackEventJobStatus",
      "lockedAt" = NOW(),
      "processingStartedAt" = COALESCE(job."processingStartedAt", NOW()),
      "attempts" = job."attempts" + 1,
      "lastError" = NULL,
      "updatedAt" = NOW()
    FROM candidate
    WHERE job."id" = candidate."id"
    RETURNING job.*;
  `);

  return rows[0] ?? null;
}

async function processSlackEventJob(job: SlackEventJobRecord) {
  if (job.jobType === SlackEventJobType.NICKNAME_SAVE) {
    await processNicknameSaveBackgroundJob(job);
    return;
  }

  if (job.jobType === SlackEventJobType.CHECKIN_ASSET_UPLOAD) {
    await processCheckInAssetUploadBackgroundJob(job);
    return;
  }

  if (job.jobType === SlackEventJobType.ADMIN_ALERT) {
    await processAdminAlertBackgroundJob(job);
    return;
  }

  if (job.jobType === SlackEventJobType.RECOVERY) {
    await processRecoveryBackgroundJob(job);
    return;
  }

  const payload = job.payload as SlackEventPayload;
  const normalized = normalizeSlackEventPayload(payload);
  const event = payload.event as SlackMessageEvent | undefined;
  const eventType = normalized.eventType;
  const workspaceId = job.workspaceId;
  const channelId = job.channelId;
  const slackUserId = job.slackUserId ?? normalized.slackUserId ?? event?.user ?? undefined;
  const botUserId = process.env.SLACK_BOT_USER_ID?.trim();
  const token = process.env.SLACK_BOT_TOKEN ?? undefined;
  const intentAnalysis = analyzeSlackIntent(payload, event ?? {}, botUserId, {
    allowNoMention: Boolean(channelId.startsWith('D')),
  });
  const intent = intentAnalysis.intent;
  const commandText = intentAnalysis.commandText;
  const isMessage = event?.type === 'message' && isSupportedMessageSubtype(event?.subtype);
  const ignoredActorReason = event ? getIgnoredActorEventReason(event) : 'missing_event';
  const isChannelContext = channelId.startsWith('C') || channelId.startsWith('G');
  const isDirectMessageContext = channelId.startsWith('D');

  const commonContext: LogContext = {
    eventId: job.eventId,
    jobId: job.id,
    requestId: payload.request_id ?? undefined,
    workspaceId,
    channelId,
    slackUserId,
    groupId: job.groupId ?? undefined,
    goalId: job.goalId ?? undefined,
    intent,
  };

  if (!isMessage) {
    await finalizeJob(job.id, {
      status: SlackEventJobStatus.DONE,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.IGNORED,
      lastError: null,
    });
    logEvent('info', 'slack.event_done', {
      eventType,
      ...commonContext,
      ignoredReason: getIgnoredMessageSubtypeReason(event?.subtype),
    });
    return;
  }

  if (!workspaceId || !channelId || !slackUserId || ignoredActorReason || (!isChannelContext && !isDirectMessageContext)) {
    await finalizeJob(job.id, {
      status: SlackEventJobStatus.DONE,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.IGNORED,
      lastError: null,
    });
    logEvent('info', 'slack.event_done', {
      eventType,
      ...commonContext,
      ignoredReason: ignoredActorReason ?? 'invalid_context',
    });
    return;
  }

  if (isDirectMessageContext && intent?.startsWith('settings_')) {
    await processSettingsIntent({
      job,
      payload,
      event,
      commonContext,
      botUserId: botUserId ?? '',
      token,
      channelId,
      workspaceId,
      intent,
      commandText,
    });
    return;
  }

  if (!isDirectMessageContext && intent?.startsWith('settings_')) {
    await sendAndFinalizeReply({
      job,
      commonContext,
      token,
      channelId,
      threadTs: event.ts,
      text: '설정 변경은 관리자 DM에서만 가능해요.',
      intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
    });
    await completeJob(job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
    });
    return;
  }

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
    await finalizeJob(job.id, {
      status: SlackEventJobStatus.DONE,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.IGNORED,
      lastError: null,
      groupId: null,
      goalId: null,
    });
    logEvent('info', 'slack.event_done', {
      eventType,
      ...commonContext,
      ignoredReason: 'integration_not_found',
    });
    return;
  }

  const runtimeSettings = await getGroupRuntimeSettings({
    groupId: integration.groupId,
    goalId: integration.goalId,
  });
  const goalInfo = {
    goalTitle: runtimeSettings.activeGoal?.title ?? integration.goal.title,
    targetCount: runtimeSettings.activeGoal?.targetCount ?? integration.goal.targetCount,
    penaltyText: runtimeSettings.weeklyPenaltyText ?? undefined,
  };
  const mention = formatSlackMention(botUserId);

  if (!intent) {
    await sendAndFinalizeReply({
      job,
      commonContext,
      token: token ?? integration.botToken ?? undefined,
      channelId,
      threadTs: event.ts,
      text: buildShortGuideText(mention),
      intent: null,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    await completeJob(job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    await completeJob(job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    return;
  }

  if (intent === 'help') {
    await sendAndFinalizeReply({
      job,
      commonContext,
      token: token ?? integration.botToken ?? undefined,
      channelId,
      threadTs: event.ts,
      text: buildHelpText(botUserId),
      intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    await completeJob(job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    return;
  }

  if (intent === 'status') {
    const status = await getCurrentStatus({
      workspaceId,
      channelId,
      externalSlackId: slackUserId,
    });

    await sendAndFinalizeReply({
      job,
      commonContext,
      token: token ?? integration.botToken ?? undefined,
      channelId,
      threadTs: event.ts,
      text: buildThreadStatusText(status),
      intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    await completeJob(job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    return;
  }

  if (intent === 'goal_confirm') {
    const status = await getCurrentStatus({
      workspaceId,
      channelId,
      externalSlackId: slackUserId,
    });

    await sendAndFinalizeReply({
      job,
      commonContext,
      token: token ?? integration.botToken ?? undefined,
      channelId,
      threadTs: event.ts,
      text: buildGoalConfirmText({
        ...goalInfo,
        displayName: slackUserId ?? '회원',
        count: status?.me?.count ?? 0,
      }),
      intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: integration.groupId,
      goalId: integration.goalId,
    });
    return;
  }

  if (intent === 'register') {
    await processRegisterIntent({
      job,
      payload,
      event,
      commonContext,
      token: token ?? integration.botToken ?? undefined,
      channelId,
      workspaceId,
      botUserId: botUserId ?? '',
      mention,
      integration,
      goalInfo,
      commandText,
      slackUserId,
    });
    return;
  }

  if (intent === 'change') {
    await processChangeIntent({
      job,
      payload,
      event,
      commonContext,
      token: token ?? integration.botToken ?? undefined,
      channelId,
      workspaceId,
      botUserId: botUserId ?? '',
      mention,
      integration,
      goalInfo,
      commandText,
      slackUserId,
    });
    return;
  }

  if (intent === 'checkin' || intent === 'admin_checkin') {
    await processCheckInIntent({
      job,
      payload,
      event,
      commonContext,
      token: token ?? integration.botToken ?? undefined,
      channelId,
      workspaceId,
      botUserId: botUserId ?? '',
      mention,
      integration,
      goalInfo,
      intent,
      commandText,
      slackUserId,
    });
    return;
  }

  await sendAndFinalizeReply({
    job,
    commonContext,
    token: token ?? integration.botToken ?? undefined,
    channelId,
    threadTs: event.ts,
    text: buildShortGuideText(mention),
    intent,
    resultStatus: SlackEventJobResultStatus.REPLIED,
    groupId: integration.groupId,
    goalId: integration.goalId,
  });
  await completeJob(job.id, {
    resultStatus: SlackEventJobResultStatus.REPLIED,
    groupId: integration.groupId,
    goalId: integration.goalId,
  });
}

async function processCheckInIntent(input: {
  job: SlackEventJobRecord;
  payload: SlackEventPayload;
  event: SlackMessageEvent;
  commonContext: LogContext;
  token?: string;
  channelId: string;
  workspaceId: string;
  botUserId: string;
  mention: string;
  integration: Awaited<ReturnType<typeof prisma.slackIntegration.findUnique>> & {
    group: { id: string; timezone: string };
    goal: { id: string; title: string; targetCount: number };
  };
  goalInfo: {
    goalTitle: string;
    targetCount: number;
    penaltyText?: string;
  };
  intent: 'checkin' | 'admin_checkin';
  commandText: string;
  slackUserId?: string;
}) {
  let hadFailure = false;
  const selectedFile = selectSupportedSlackImageFile(input.event.files);
  const supportedFile = selectedFile.selectedFile;
  const sourceMessageId = input.event.client_msg_id ?? input.event.ts ?? input.job.eventId;

  if (!supportedFile) {
    await sendAndFinalizeReply({
      job: input.job,
      commonContext: input.commonContext,
      token: input.token,
      channelId: input.channelId,
      threadTs: input.event.ts,
      text: buildMissingImageText(input.mention),
      intent: input.intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: input.integration.groupId,
      goalId: input.integration.goal.id,
    });
    await completeJob(input.job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: input.integration.groupId,
      goalId: input.integration.goal.id,
    });
    return;
  }

  const photoPlaceholder = {
    blobUrl: null,
    slackOriginalUrl: supportedFile.url_private_download ?? supportedFile.url_private ?? null,
    mimeType: supportedFile.mimetype,
    storageKey: undefined,
    uploadFailed: false,
  };

  const result = await createFromSlackMessage({
    externalSlackId: input.slackUserId ?? input.event.user ?? '',
    displayName: input.slackUserId ?? input.event.user ?? '회원',
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    sourceMessageId,
    photo: photoPlaceholder,
    note: input.event.text,
    checkedAt: toSlackTimestampDate(input.event.ts),
    allowChangeCandidateOnDuplicate: input.intent !== 'admin_checkin',
    context: {
      ...input.commonContext,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      groupId: input.integration.groupId,
      goalId: input.integration.goalId,
      slackUserId: input.slackUserId ?? input.event.user ?? undefined,
    },
  });

  await prisma.slackEventJob.update({
    where: { id: input.job.id },
    data: {
      groupId: input.integration.groupId,
      goalId: input.integration.goalId,
      intent: input.intent,
      resultStatus:
        result.status === 'accepted'
          ? SlackEventJobResultStatus.ACCEPTED
          : result.status === 'duplicate'
            ? SlackEventJobResultStatus.DUPLICATE
            : SlackEventJobResultStatus.IGNORED,
      checkInRecordId:
        result.status === 'accepted' || result.status === 'duplicate' ? result.checkInId : null,
      rawSubmissionId: result.status === 'accepted' ? result.rawSubmissionId ?? null : null,
      submissionAssetId: result.status === 'accepted' ? result.submissionAssetId ?? null : null,
      changeCandidateId: result.status === 'duplicate' ? result.candidateId ?? null : null,
      lockedAt: new Date(),
    },
  });

  if (result.status === 'accepted') {
    logEvent('info', 'slack.checkin_accepted', {
      eventType: 'slack_event_job',
      ...input.commonContext,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      groupId: input.integration.groupId,
      goalId: input.integration.goalId,
      slackUserId: input.slackUserId ?? input.event.user ?? undefined,
      checkInRecordId: result.checkInId,
      rawSubmissionId: result.rawSubmissionId,
      submissionAssetId: result.submissionAssetId,
    });
  }

  if (result.status === 'duplicate') {
    logEvent('info', 'slack.checkin_duplicate', {
      eventType: 'slack_event_job',
      ...input.commonContext,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      groupId: input.integration.groupId,
      goalId: input.integration.goalId,
      slackUserId: input.slackUserId ?? input.event.user ?? undefined,
      candidateSaved: result.candidateSaved,
      candidateId: result.candidateId ?? undefined,
    });
  }

  const currentStatus =
    result.status === 'accepted'
      ? await getCurrentStatus({
          workspaceId: input.workspaceId,
          channelId: input.channelId,
          externalSlackId: input.slackUserId ?? input.event.user ?? '',
        }).catch((error) => {
          logEvent('warn', 'slack.current_status_load_failed', {
            eventType: 'slack_event_job',
            ...input.commonContext,
            reason: error instanceof Error ? error.message : String(error),
            stage: 'accepted_reply',
          });
          return null;
        })
      : undefined;

  const replyText =
    result.status === 'accepted'
      ? buildCheckInSuccessText({
          displayName: input.slackUserId ?? input.event.user ?? '회원',
          currentStatus: currentStatus ?? undefined,
        })
      : result.status === 'duplicate'
        ? input.intent === 'admin_checkin'
          ? `<@${input.slackUserId ?? input.event.user ?? ''}> <@${input.slackUserId ?? input.event.user ?? ''}>의 오늘 인증은 이미 반영되었어요`
          : `오늘은 이미 인증 완료했어요 🙂\n사진을 바꾸려면 ${input.mention} 변경 을 사용해주세요`
        : buildShortGuideText(input.mention);

  await sendAndFinalizeReply({
    job: input.job,
    commonContext: input.commonContext,
    token: input.token,
    channelId: input.channelId,
    threadTs: input.event.ts,
    text: replyText,
    intent: input.intent,
    resultStatus: result.status === 'accepted' ? SlackEventJobResultStatus.ACCEPTED : SlackEventJobResultStatus.DUPLICATE,
    groupId: input.integration.groupId,
    goalId: input.integration.goal.id,
  });

  if (result.status === 'accepted' && currentStatus && !input.job.channelStatusSentAt) {
    const channelUpdateSent = await sendSlackMessage({
      token: input.token,
      channelId: input.channelId,
      text: buildChannelStatusText(currentStatus),
    });

    await prisma.slackEventJob.update({
      where: { id: input.job.id },
      data: {
        channelStatusSentAt: channelUpdateSent ? new Date() : input.job.channelStatusSentAt,
        lockedAt: new Date(),
        lastError: channelUpdateSent ? null : 'channel_status_failed',
        status: channelUpdateSent ? SlackEventJobStatus.PROCESSING : SlackEventJobStatus.FAILED,
        nextRetryAt: channelUpdateSent ? null : nextRetryAtForAttempt(input.job.attempts),
      },
    });

    logEvent(channelUpdateSent ? 'info' : 'warn', channelUpdateSent ? 'slack.channel_status_sent' : 'slack.channel_status_failed', {
      eventType: 'slack_event_job',
      ...input.commonContext,
      groupId: input.integration.groupId,
      goalId: input.integration.goalId,
      replyStatus: channelUpdateSent ? 'sent' : 'failed',
    });

    if (!channelUpdateSent) {
      hadFailure = true;
    }
  }

  try {
    await processSlackPhotoUpload({
      job: input.job,
      commonContext: input.commonContext,
      token: input.token,
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      sourceMessageId,
      selectedFile: supportedFile,
      result,
      slackUserId: input.slackUserId ?? input.event.user ?? '',
    });
  } catch {
    hadFailure = true;
  }

  if (hadFailure) {
    await finalizeJob(input.job.id, {
      status: SlackEventJobStatus.FAILED,
      processedAt: new Date(),
      resultStatus:
        result.status === 'accepted'
          ? SlackEventJobResultStatus.ACCEPTED
          : SlackEventJobResultStatus.DUPLICATE,
      lastError: 'partial_failure',
      groupId: input.integration.groupId,
      goalId: input.integration.goal.id,
    });
    return;
  }

  await completeJob(input.job.id, {
    resultStatus:
      result.status === 'accepted'
        ? SlackEventJobResultStatus.ACCEPTED
        : SlackEventJobResultStatus.DUPLICATE,
    groupId: input.integration.groupId,
    goalId: input.integration.goal.id,
  });
}

async function processChangeIntent(input: {
  job: SlackEventJobRecord;
  payload: SlackEventPayload;
  event: SlackMessageEvent;
  commonContext: LogContext;
  token?: string;
  channelId: string;
  workspaceId: string;
  botUserId: string;
  mention: string;
  integration: Awaited<ReturnType<typeof prisma.slackIntegration.findUnique>> & {
    group: { id: string; timezone: string };
    goal: { id: string; title: string; targetCount: number };
  };
  goalInfo: {
    goalTitle: string;
    targetCount: number;
    penaltyText?: string;
  };
  commandText: string;
  slackUserId?: string;
}) {
  const result = await replaceTodayFromSlackMessage({
    externalSlackId: input.slackUserId ?? input.event.user ?? '',
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    checkedAt: toSlackTimestampDate(input.event.ts),
  });

  await prisma.slackEventJob.update({
    where: { id: input.job.id },
    data: {
      groupId: input.integration.groupId,
      goalId: input.integration.goal.id,
      intent: 'change',
      resultStatus:
        result.status === 'replaced'
          ? SlackEventJobResultStatus.ACCEPTED
          : SlackEventJobResultStatus.IGNORED,
      lockedAt: new Date(),
    },
  });

  const textByStatus = {
    replaced: `<@${input.slackUserId ?? input.event.user ?? ''}> 인증 이미지가 변경되었어요.`,
    missing_checkin: `<@${input.slackUserId ?? input.event.user ?? ''}> 오늘 변경할 인증이 없어요\n먼저 #인증과 사진을 올려주세요`,
    missing_candidate: `<@${input.slackUserId ?? input.event.user ?? ''}> 변경할 새 사진이 없어요\n새 사진을 올린 뒤 #변경을 입력해주세요`,
    ignored: `<@${input.slackUserId ?? input.event.user ?? ''}> 이 채널은 아직 인증 채널로 연결되지 않았어요.`,
  } satisfies Record<typeof result.status, string>;

  await sendAndFinalizeReply({
    job: input.job,
    commonContext: input.commonContext,
    token: input.token,
    channelId: input.channelId,
    threadTs: input.event.ts,
    text: textByStatus[result.status],
    intent: 'change',
    resultStatus: result.status === 'replaced' ? SlackEventJobResultStatus.ACCEPTED : SlackEventJobResultStatus.IGNORED,
    groupId: input.integration.groupId,
    goalId: input.integration.goal.id,
  });

  await finalizeJob(input.job.id, {
    status: SlackEventJobStatus.DONE,
    processedAt: new Date(),
    resultStatus: result.status === 'replaced' ? SlackEventJobResultStatus.ACCEPTED : SlackEventJobResultStatus.IGNORED,
    lastError: null,
    groupId: input.integration.groupId,
    goalId: input.integration.goal.id,
  });
}

async function processRegisterIntent(input: {
  job: SlackEventJobRecord;
  payload: SlackEventPayload;
  event: SlackMessageEvent;
  commonContext: LogContext;
  token?: string;
  channelId: string;
  workspaceId: string;
  botUserId: string;
  mention: string;
  integration: Awaited<ReturnType<typeof prisma.slackIntegration.findUnique>> & {
    group: { id: string; timezone: string };
    goal: { id: string; title: string; targetCount: number };
  };
  goalInfo: {
    goalTitle: string;
    targetCount: number;
    penaltyText?: string;
  };
  commandText: string;
  slackUserId?: string;
}) {
  const registrationName = parseRegistrationName(input.commandText);
  const registrationState = await getSlackRegistrationState({
    db: prisma,
    workspaceId: input.workspaceId,
    externalSlackId: input.slackUserId ?? input.event.user ?? '',
    groupId: input.integration.groupId,
  });

  if (!registrationName) {
    await sendAndFinalizeReply({
      job: input.job,
      commonContext: input.commonContext,
      token: input.token,
      channelId: input.channelId,
      threadTs: input.event.ts,
      text: buildRegistrationNamePromptText(input.mention),
      intent: 'register',
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: input.integration.groupId,
      goalId: input.integration.goal.id,
    });
    await completeJob(input.job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: input.integration.groupId,
      goalId: input.integration.goal.id,
    });
    return;
  }

  if (registrationState.isRegistered) {
    await renameSlackUserFromCommand({
      db: prisma,
      workspaceId: input.workspaceId,
      externalSlackId: input.slackUserId ?? input.event.user ?? '',
      displayName: registrationName,
      groupId: input.integration.groupId,
    });
  } else {
    await registerSlackUserFromCommand({
      db: prisma,
      workspaceId: input.workspaceId,
      externalSlackId: input.slackUserId ?? input.event.user ?? '',
      displayName: registrationName,
      groupId: input.integration.groupId,
    });
  }

  await ensureSlackUserMembership({
    tx: prisma,
    workspaceId: input.workspaceId,
    externalSlackId: input.slackUserId ?? input.event.user ?? '',
    groupId: input.integration.groupId,
    providerUsername: input.event.username,
    displayName: registrationName,
  });

  await sendAndFinalizeReply({
    job: input.job,
    commonContext: input.commonContext,
    token: input.token,
    channelId: input.channelId,
    threadTs: input.event.ts,
    text: registrationState.isRegistered
      ? buildRegistrationRenameText({ displayName: registrationName })
      : buildRegistrationSuccessText({
          displayName: registrationName,
          mention: input.mention,
          goalTitle: input.goalInfo.goalTitle,
          targetCount: input.goalInfo.targetCount,
          penaltyText: input.goalInfo.penaltyText,
        }),
    intent: 'register',
    resultStatus: SlackEventJobResultStatus.REPLIED,
    groupId: input.integration.groupId,
    goalId: input.integration.goal.id,
  });
  await completeJob(input.job.id, {
    resultStatus: SlackEventJobResultStatus.REPLIED,
    groupId: input.integration.groupId,
    goalId: input.integration.goal.id,
  });
}

async function processSettingsIntent(input: {
  job: SlackEventJobRecord;
  payload: SlackEventPayload;
  event: SlackMessageEvent;
  commonContext: LogContext;
  token?: string;
  channelId: string;
  workspaceId: string;
  botUserId: string;
  intent: string;
  commandText: string;
}) {
  const resolved = await resolveAdminSettingsIntegration({
    workspaceId: input.workspaceId,
    userId: input.event.user ?? '',
  });

  if (!resolved.ok) {
    await sendAndFinalizeReply({
      job: input.job,
      commonContext: input.commonContext,
      token: input.token,
      channelId: input.channelId,
      threadTs: input.event.ts,
      text: '설정을 변경할 권한이 없어요.',
      intent: input.intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
    });
    await completeJob(input.job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
    });
    return;
  }

  const mention = formatSlackMention(input.botUserId);
  const settings = await getGroupRuntimeSettings({
    groupId: resolved.integration.groupId,
    goalId: resolved.integration.goalId,
  });
  const currentTargetCount = settings.activeGoal?.targetCount ?? resolved.integration.goal.targetCount;
  const currentPenaltyText = settings.weeklyPenaltyText;

  if (input.intent === 'settings_confirm') {
    await sendAndFinalizeReply({
      job: input.job,
      commonContext: input.commonContext,
      token: input.token,
      channelId: input.channelId,
      threadTs: input.event.ts,
      text: buildAdminSettingsSummaryText({
        targetCount: currentTargetCount,
        weeklyPenaltyText: currentPenaltyText,
      }),
      intent: input.intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: resolved.integration.groupId,
      goalId: resolved.integration.goalId,
    });
    await completeJob(input.job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: resolved.integration.groupId,
      goalId: resolved.integration.goalId,
    });
    return;
  }

  if (input.intent === 'settings_goal') {
    const nextTargetCount = parseTargetCountFromCommandText(input.commandText);
    if (nextTargetCount === null) {
      await sendAndFinalizeReply({
        job: input.job,
        commonContext: input.commonContext,
        token: input.token,
        channelId: input.channelId,
        threadTs: input.event.ts,
        text: '목표 횟수를 숫자로 입력해주세요.\n예: 목표 설정 주 5회',
        intent: input.intent,
        resultStatus: SlackEventJobResultStatus.REPLIED,
        groupId: resolved.integration.groupId,
        goalId: resolved.integration.goalId,
      });
      await completeJob(input.job.id, {
        resultStatus: SlackEventJobResultStatus.REPLIED,
        groupId: resolved.integration.groupId,
        goalId: resolved.integration.goalId,
      });
      return;
    }

    const updatedGoal = await updateActiveGoalTargetCount({
      groupId: resolved.integration.groupId,
      targetCount: nextTargetCount,
    });

    if (!updatedGoal) {
      await sendAndFinalizeReply({
        job: input.job,
        commonContext: input.commonContext,
        token: input.token,
        channelId: input.channelId,
        threadTs: input.event.ts,
        text: '현재 활성 목표를 찾을 수 없어요.',
        intent: input.intent,
        resultStatus: SlackEventJobResultStatus.REPLIED,
        groupId: resolved.integration.groupId,
        goalId: resolved.integration.goalId,
      });
      await completeJob(input.job.id, {
        resultStatus: SlackEventJobResultStatus.REPLIED,
        groupId: resolved.integration.groupId,
        goalId: resolved.integration.goalId,
      });
      return;
    }

    await sendAndFinalizeReply({
      job: input.job,
      commonContext: input.commonContext,
      token: input.token,
      channelId: input.channelId,
      threadTs: input.event.ts,
      text: buildAdminSettingsGoalUpdatedText({
        previousTargetCount: currentTargetCount,
        nextTargetCount,
        mention,
      }),
      intent: input.intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: resolved.integration.groupId,
      goalId: resolved.integration.goalId,
    });
    await completeJob(input.job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: resolved.integration.groupId,
      goalId: resolved.integration.goalId,
    });
    return;
  }

  if (input.intent === 'settings_penalty') {
    const nextPenaltyText = parsePenaltyTextFromCommandText(input.commandText);
    if (!nextPenaltyText) {
      await sendAndFinalizeReply({
        job: input.job,
        commonContext: input.commonContext,
        token: input.token,
        channelId: input.channelId,
        threadTs: input.event.ts,
        text: '패널티 금액을 숫자로 입력해주세요.\n예: 패널티 설정 10000원',
        intent: input.intent,
        resultStatus: SlackEventJobResultStatus.REPLIED,
        groupId: resolved.integration.groupId,
        goalId: resolved.integration.goalId,
      });
      await completeJob(input.job.id, {
        resultStatus: SlackEventJobResultStatus.REPLIED,
        groupId: resolved.integration.groupId,
        goalId: resolved.integration.goalId,
      });
      return;
    }

    await upsertGroupWeeklyPenaltyText({
      groupId: resolved.integration.groupId,
      weeklyPenaltyText: nextPenaltyText,
    });

    await sendAndFinalizeReply({
      job: input.job,
      commonContext: input.commonContext,
      token: input.token,
      channelId: input.channelId,
      threadTs: input.event.ts,
      text: buildAdminSettingsPenaltyUpdatedText({
        previousPenaltyText: currentPenaltyText,
        nextPenaltyText,
        mention,
      }),
      intent: input.intent,
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: resolved.integration.groupId,
      goalId: resolved.integration.goalId,
    });
    await completeJob(input.job.id, {
      resultStatus: SlackEventJobResultStatus.REPLIED,
      groupId: resolved.integration.groupId,
      goalId: resolved.integration.goalId,
    });
    return;
  }
}

async function sendAndFinalizeReply(input: {
  job: SlackEventJobRecord;
  commonContext: LogContext;
  token?: string;
  channelId: string;
  threadTs?: string;
  text: string;
  intent?: string | null;
  resultStatus: SlackEventJobResultStatus;
  groupId?: string;
  goalId?: string;
}) {
  if (input.job.replySentAt) {
    return;
  }

  const replied = await sendSlackMessage({
    token: input.token,
    channelId: input.channelId,
    threadTs: input.threadTs,
    text: input.text,
  });

  await prisma.slackEventJob.update({
    where: { id: input.job.id },
    data: {
      replySentAt: replied ? new Date() : input.job.replySentAt,
      lockedAt: new Date(),
      status: replied ? SlackEventJobStatus.PROCESSING : SlackEventJobStatus.FAILED,
      resultStatus: replied ? input.resultStatus : input.job.resultStatus,
      lastError: replied ? null : 'reply_failed',
      nextRetryAt: replied ? null : nextRetryAtForAttempt(input.job.attempts),
      groupId: input.groupId ?? undefined,
      goalId: input.goalId ?? undefined,
    },
  });

  logEvent(replied ? 'info' : 'warn', replied ? 'slack.reply_sent' : 'slack.reply_failed', {
    eventType: 'slack_event_job',
    ...input.commonContext,
    groupId: input.groupId,
    goalId: input.goalId,
    replyStatus: replied ? 'sent' : 'failed',
    receiptStatus: replied ? SlackEventReceiptStatus.ACKED : SlackEventReceiptStatus.FAILED,
    jobStatus: replied ? SlackEventJobStatus.PROCESSING : SlackEventJobStatus.FAILED,
    jobStep: 'reply',
  });

  if (!replied) {
    throw new Error('reply_failed');
  }
}

async function completeJob(
  jobId: string,
  input: {
    resultStatus?: SlackEventJobResultStatus | null;
    groupId?: string;
    goalId?: string;
  } = {},
) {
  await prisma.slackEventJob.update({
    where: { id: jobId },
    data: {
      status: SlackEventJobStatus.DONE,
      processedAt: new Date(),
      lockedAt: new Date(),
      lastError: null,
      nextRetryAt: null,
      resultStatus: input.resultStatus ?? undefined,
      groupId: input.groupId ?? undefined,
      goalId: input.goalId ?? undefined,
    },
  });
}

async function processSlackPhotoUpload(input: {
  job: SlackEventJobRecord;
  commonContext: LogContext;
  token?: string;
  workspaceId: string;
  channelId: string;
  sourceMessageId: string;
  selectedFile: SlackEventFile | null;
  result: Awaited<ReturnType<typeof createFromSlackMessage>>;
  slackUserId: string;
}) {
  if (!input.selectedFile) {
    return;
  }

  if (input.job.assetUploadedAt) {
    return;
  }

  if (input.result.status !== 'accepted' && input.result.status !== 'duplicate') {
    return;
  }

  const slackFileUrl = input.selectedFile.url_private_download ?? input.selectedFile.url_private;
  if (!slackFileUrl) {
    throw new Error('missing_slack_file_url');
  }

  const photo = await storeSlackPhotoToBlob({
    slackFileUrl,
    botToken: input.token,
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    sourceMessageId: input.sourceMessageId,
    mimeType: input.selectedFile.mimetype,
    fileId: input.selectedFile.id ?? null,
    fileSize: input.selectedFile.size ?? null,
    context: {
      ...input.commonContext,
      slackUserId: input.slackUserId,
    },
  });

  if (input.result.status === 'accepted' && input.result.rawSubmissionId) {
    await updateSlackSubmissionAsset({
      rawSubmissionId: input.result.rawSubmissionId,
      blobUrl: photo.blobUrl,
      storageKey: photo.storageKey,
      uploadFailed: photo.uploadFailed,
      mimeType: photo.mimeType ?? input.selectedFile.mimetype ?? null,
      slackOriginalUrl: photo.slackOriginalUrl,
      assetStatus: photo.blobUrl
        ? SubmissionAssetStatus.ASSET_SAVED
        : SubmissionAssetStatus.ASSET_FAILED,
      assetRetryCount: input.job.attempts,
      assetLockedAt: null,
      assetProcessedAt: photo.blobUrl ? new Date() : null,
      assetNextRetryAt: photo.blobUrl ? null : nextRetryAtForAttempt(input.job.attempts),
    });
  }

  if (input.result.status === 'duplicate' && input.result.candidateSaved && input.result.candidateId) {
    await updateSlackChangeCandidateAsset({
      candidateId: input.result.candidateId,
      blobUrl: photo.blobUrl,
      uploadFailed: photo.uploadFailed,
      mimeType: photo.mimeType ?? input.selectedFile.mimetype ?? null,
      slackOriginalUrl: photo.slackOriginalUrl,
    });
  }

  await prisma.slackEventJob.update({
    where: { id: input.job.id },
    data: {
      assetUploadedAt: photo.blobUrl ? new Date() : input.job.assetUploadedAt,
      lockedAt: new Date(),
      lastError: photo.blobUrl ? null : 'asset_upload_failed',
      status: photo.blobUrl ? SlackEventJobStatus.PROCESSING : SlackEventJobStatus.FAILED,
      nextRetryAt: photo.blobUrl ? null : nextRetryAtForAttempt(input.job.attempts),
    },
  });

  logEvent(photo.blobUrl ? 'info' : 'warn', photo.blobUrl ? 'slack.asset_upload_success' : 'slack.asset_upload_failed', {
    eventType: 'slack_event_job',
    ...input.commonContext,
    slackUserId: input.slackUserId,
    assetStatus: photo.blobUrl ? 'success' : 'failed',
    sourceMessageId: input.sourceMessageId,
  });

  if (!photo.blobUrl) {
    throw new Error('asset_upload_failed');
  }
}

async function finalizeJob(
  jobId: string,
  input: {
    status: SlackEventJobStatus;
    processedAt?: Date;
    resultStatus?: SlackEventJobResultStatus | null;
    lastError?: string | null;
    groupId?: string | null;
    goalId?: string | null;
  },
) {
  await prisma.slackEventJob.update({
    where: { id: jobId },
    data: {
      status: input.status,
      processedAt: input.processedAt ?? null,
      resultStatus: input.resultStatus ?? undefined,
      lastError: input.lastError ?? undefined,
      groupId: input.groupId ?? undefined,
      goalId: input.goalId ?? undefined,
      lockedAt: new Date(),
    },
  });
}

async function processNicknameSaveBackgroundJob(job: SlackEventJobRecord) {
  const payload = job.payload as {
    workspaceId?: string;
    channelId?: string;
    slackUserId?: string;
    groupId?: string;
    nickname?: string;
    providerUsername?: string;
    requestId?: string;
    eventId?: string;
  };

  if (!payload.workspaceId || !payload.slackUserId || !payload.groupId || !payload.nickname) {
    await finalizeJob(job.id, {
      status: SlackEventJobStatus.FAILED,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.IGNORED,
      lastError: 'invalid_nickname_save_payload',
      groupId: payload.groupId ?? null,
      goalId: job.goalId ?? null,
    });
    throw new Error('invalid_nickname_save_payload');
  }

  try {
    const result = await registerSlackUserFromCommand({
      db: prisma,
      workspaceId: payload.workspaceId,
      externalSlackId: payload.slackUserId,
      displayName: payload.nickname,
      groupId: payload.groupId,
    });

    if (result.status === 'invalid_name') {
      throw new Error('invalid_nickname');
    }

    if (result.status === 'registered' || result.status === 'renamed') {
      await ensureSlackUserMembership({
        tx: prisma,
        workspaceId: payload.workspaceId,
        externalSlackId: payload.slackUserId,
        displayName: payload.nickname,
        providerUsername: payload.providerUsername,
        groupId: payload.groupId,
      });
    }

    await completeJob(job.id, {
      resultStatus: SlackEventJobResultStatus.ACCEPTED,
      groupId: payload.groupId,
      goalId: job.goalId ?? undefined,
    });

    logEvent('info', 'slack.nickname_saved', {
      eventType: 'slack_event_job',
      jobId: job.id,
      eventId: job.eventId,
      workspaceId: payload.workspaceId,
      channelId: payload.channelId,
      slackUserId: payload.slackUserId,
      groupId: payload.groupId,
      nickname: payload.nickname,
      status: result.status,
    });
  } catch (error) {
    await notifyBackgroundJobFailure({
      job,
      jobType: 'NICKNAME_SAVE',
      payload,
      reason: error instanceof Error ? error.message : String(error),
      alertText: [
        '[운영 알림]',
        '닉네임 저장에 실패했어요.',
        '',
        `Slack userId: ${payload.slackUserId}`,
        `입력 닉네임: ${payload.nickname}`,
      ].join('\n'),
    });
    throw error;
  }
}

async function processCheckInAssetUploadBackgroundJob(job: SlackEventJobRecord) {
  const payload = job.payload as {
    workspaceId?: string;
    channelId?: string;
    slackUserId?: string;
    rawSubmissionId?: string;
    submissionAssetId?: string;
    changeCandidateId?: string;
    sourceMessageId?: string;
    recordDate?: string;
    selectedFile?: {
      id?: string;
      mimetype?: string;
      size?: number;
      url_private?: string;
      url_private_download?: string;
    };
  };

  if (!payload.workspaceId || !payload.channelId || !payload.sourceMessageId || !payload.selectedFile) {
    await finalizeJob(job.id, {
      status: SlackEventJobStatus.FAILED,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.IGNORED,
      lastError: 'invalid_asset_upload_payload',
      groupId: job.groupId ?? null,
      goalId: job.goalId ?? null,
    });
    throw new Error('invalid_asset_upload_payload');
  }

  const integration = await prisma.slackIntegration.findUnique({
    where: {
      workspaceId_channelId: {
        workspaceId: payload.workspaceId,
        channelId: payload.channelId,
      },
    },
    include: { group: true, goal: true },
  });

  if (!integration) {
    await finalizeJob(job.id, {
      status: SlackEventJobStatus.FAILED,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.IGNORED,
      lastError: 'integration_not_found',
      groupId: job.groupId ?? null,
      goalId: job.goalId ?? null,
    });
    throw new Error('integration_not_found');
  }

  const assetClaim = await prisma.submissionAsset.updateMany({
    where: {
      rawSubmissionId: payload.rawSubmissionId,
      blobUrl: null,
      OR: [
        { assetStatus: SubmissionAssetStatus.PENDING },
        {
          assetStatus: SubmissionAssetStatus.PROCESSING,
          assetLockedAt: {
            lt: new Date(Date.now() - PROCESSING_LEASE_MS),
          },
        },
        {
          assetStatus: SubmissionAssetStatus.ASSET_FAILED,
          OR: [
            { assetNextRetryAt: null },
            { assetNextRetryAt: { lte: new Date() } },
          ],
        },
      ],
    },
    data: {
      assetStatus: SubmissionAssetStatus.PROCESSING,
      assetLockedAt: new Date(),
      assetRetryCount: { increment: 1 },
      assetLastError: null,
    },
  });

  if (assetClaim.count === 0) {
    logEvent('info', 'slack.asset_upload_skipped', {
      eventType: 'slack_event_job',
      jobId: job.id,
      eventId: job.eventId,
      workspaceId: payload.workspaceId,
      channelId: payload.channelId,
      slackUserId: payload.slackUserId,
      rawSubmissionId: payload.rawSubmissionId ?? undefined,
      reason: 'asset_already_processed_or_locked',
    });
    await completeJob(job.id, {
      resultStatus: SlackEventJobResultStatus.IGNORED,
      groupId: job.groupId ?? undefined,
      goalId: job.goalId ?? undefined,
    });
    return;
  }

  const slackFileUrl = payload.selectedFile.url_private_download ?? payload.selectedFile.url_private;
  if (!slackFileUrl) {
    await notifyBackgroundJobFailure({
      job,
      jobType: 'CHECKIN_ASSET_UPLOAD',
      payload,
      reason: 'missing_slack_file_url',
        alertText: [
          '[운영 알림]',
          '사진 저장에 실패했어요.',
          '',
          `유저: ${payload.slackUserId ?? '-'}`,
          `채널: ${payload.channelId}`,
          `기록일: ${payload.recordDate ?? '-'}`,
          '',
          '원본 Slack 파일 URL은 남아 있습니다.',
        ].join('\n'),
      });
    throw new Error('missing_slack_file_url');
  }

  const photo = await storeSlackPhotoToBlob({
    slackFileUrl,
    botToken: integration.botToken ?? process.env.SLACK_BOT_TOKEN ?? undefined,
    workspaceId: payload.workspaceId,
    channelId: payload.channelId,
    sourceMessageId: payload.sourceMessageId,
    mimeType: payload.selectedFile.mimetype,
    fileId: payload.selectedFile.id ?? null,
    fileSize: payload.selectedFile.size ?? null,
    context: {
      jobId: job.id,
      eventId: job.eventId,
      workspaceId: payload.workspaceId,
      channelId: payload.channelId,
      slackUserId: payload.slackUserId ?? undefined,
      groupId: job.groupId ?? undefined,
      goalId: job.goalId ?? undefined,
    },
  });

  if (payload.rawSubmissionId) {
    await updateSlackSubmissionAsset({
      rawSubmissionId: payload.rawSubmissionId,
      blobUrl: photo.blobUrl,
      storageKey: photo.storageKey,
      uploadFailed: photo.uploadFailed,
      mimeType: photo.mimeType ?? payload.selectedFile.mimetype ?? null,
      slackOriginalUrl: photo.slackOriginalUrl,
      assetStatus: photo.blobUrl
        ? SubmissionAssetStatus.ASSET_SAVED
        : SubmissionAssetStatus.ASSET_FAILED,
      assetRetryCount: job.attempts,
      assetLockedAt: null,
      assetProcessedAt: photo.blobUrl ? new Date() : null,
      assetNextRetryAt: photo.blobUrl ? null : nextRetryAtForAttempt(job.attempts),
    });
  }

  if (payload.changeCandidateId) {
    await updateSlackChangeCandidateAsset({
      candidateId: payload.changeCandidateId,
      blobUrl: photo.blobUrl,
      uploadFailed: photo.uploadFailed,
      mimeType: photo.mimeType ?? payload.selectedFile.mimetype ?? null,
      slackOriginalUrl: photo.slackOriginalUrl,
    });
  }

  if (!photo.blobUrl) {
    await notifyBackgroundJobFailure({
      job,
      jobType: 'CHECKIN_ASSET_UPLOAD',
      payload,
      reason: 'asset_upload_failed',
        alertText: [
          '[운영 알림]',
          '사진 저장에 실패했어요.',
          '',
          `유저: ${payload.slackUserId ?? '-'}`,
          `채널: ${payload.channelId}`,
          `기록일: ${payload.recordDate ?? '-'}`,
          '',
          '원본 Slack 파일 URL은 남아 있습니다.',
        ].join('\n'),
      });
    throw new Error('asset_upload_failed');
  }

  await prisma.slackEventJob.update({
    where: { id: job.id },
    data: {
      status: SlackEventJobStatus.DONE,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.ACCEPTED,
      assetUploadedAt: new Date(),
      lastError: null,
    },
  });

  logEvent('info', 'slack.asset_upload_success', {
    eventType: 'slack_event_job',
    jobId: job.id,
    eventId: job.eventId,
    workspaceId: payload.workspaceId,
    channelId: payload.channelId,
    slackUserId: payload.slackUserId,
    rawSubmissionId: payload.rawSubmissionId ?? undefined,
    submissionAssetId: payload.submissionAssetId ?? undefined,
    changeCandidateId: payload.changeCandidateId ?? undefined,
  });
}

async function processAdminAlertBackgroundJob(job: SlackEventJobRecord) {
  const payload = job.payload as {
    ownerUserId?: string;
    slackUserId?: string;
    text?: string;
  };

  const ownerUserId = payload.ownerUserId ?? process.env.SLACK_OWNER_USER_ID?.trim();
  if (!ownerUserId) {
    await finalizeJob(job.id, {
      status: SlackEventJobStatus.DONE,
      processedAt: new Date(),
      resultStatus: SlackEventJobResultStatus.IGNORED,
      lastError: null,
      groupId: job.groupId ?? null,
      goalId: job.goalId ?? null,
    });
    logEvent('warn', 'slack.admin_alert_skipped', {
      eventType: 'slack_event_job',
      jobId: job.id,
      eventId: job.eventId,
      reason: 'missing_owner_user_id',
    });
    return;
  }

  await sendSlackDirectMessage({
    token: process.env.SLACK_BOT_TOKEN ?? undefined,
    userId: ownerUserId,
    text: payload.text ?? '[운영 알림] 알림 내용이 없습니다.',
  });

  await completeJob(job.id, {
    resultStatus: SlackEventJobResultStatus.REPLIED,
    groupId: job.groupId ?? undefined,
    goalId: job.goalId ?? undefined,
  });
}

async function processRecoveryBackgroundJob(job: SlackEventJobRecord) {
  await completeJob(job.id, {
    resultStatus: SlackEventJobResultStatus.IGNORED,
    groupId: job.groupId ?? undefined,
    goalId: job.goalId ?? undefined,
  });
  logEvent('info', 'slack.recovery_job_completed', {
    eventType: 'slack_event_job',
    jobId: job.id,
    eventId: job.eventId,
    jobType: job.jobType ?? undefined,
  });
}

async function notifyBackgroundJobFailure(input: {
  job: SlackEventJobRecord;
  jobType: SlackEventJobType;
  payload: Record<string, any>;
  reason: string;
  alertText: string;
}) {
  logEvent('warn', 'slack.background_job_failed', {
    eventType: 'slack_event_job',
    jobId: input.job.id,
    eventId: input.job.eventId,
    jobType: input.jobType,
    workspaceId: input.payload.workspaceId,
    channelId: input.payload.channelId,
    slackUserId: input.payload.slackUserId,
    groupId: input.payload.groupId ?? input.job.groupId ?? undefined,
    goalId: input.payload.goalId ?? input.job.goalId ?? undefined,
    reason: input.reason,
  });

  const ownerUserId = process.env.SLACK_OWNER_USER_ID?.trim();
  if (!ownerUserId) {
    return;
  }

  await sendSlackDirectMessage({
    token: process.env.SLACK_BOT_TOKEN ?? undefined,
    userId: ownerUserId,
    text: input.alertText,
  });
}

function nextRetryAtForAttempt(attempts: number) {
  const backoffMinutes = Math.min(15, Math.max(1, attempts) * 2);
  return new Date(Date.now() + backoffMinutes * 60 * 1000);
}

function toPositiveInteger(value?: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseRegistrationName(text: string) {
  const normalized = stripBotMention(text, process.env.SLACK_BOT_USER_ID?.trim());
  const match = normalized.match(/^(?:닉네임\s*설정|등록)\s+(.+)$/);
  return match?.[1]?.trim() ?? '';
}

function parseTargetCountFromCommandText(text: string) {
  const normalized = stripBotMention(text, process.env.SLACK_BOT_USER_ID?.trim());
  const match = normalized.match(/^(?:목표\s*설정\s*주?|목표\s*설정|설정\s*목표)\s*(\d+)\s*회$/);
  if (!match) {
    return null;
  }

  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parsePenaltyTextFromCommandText(text: string) {
  const normalized = stripBotMention(text, process.env.SLACK_BOT_USER_ID?.trim());
  const match = normalized.match(/^(?:패널티\s*설정|설정\s*패널티)\s*([\d,]+)\s*원$/);
  if (!match) {
    return null;
  }

  const rawValue = match[1]?.replace(/,/g, '') ?? '';
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return formatWeeklyPenaltyDisplayText(`${value.toLocaleString('ko-KR')}원`);
}

function stripBotMention(text: string, botUserId?: string) {
  if (!botUserId) {
    return text.trim();
  }

  const mentionPattern = new RegExp(`<@${escapeRegExp(botUserId)}>`, 'g');
  return text.replace(mentionPattern, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSupportedMessageSubtype(subtype?: string) {
  return !subtype || subtype === 'file_share';
}

function getIgnoredMessageSubtypeReason(subtype?: string) {
  if (!subtype || subtype === 'file_share') {
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

function selectSupportedSlackImageFile(files?: SlackEventFile[]) {
  const supportedFiles = files?.filter((file) => isSupportedSlackImageMimeType(file.mimetype)) ?? [];
  return {
    selectedFile: supportedFiles[0] ?? null,
  };
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

function buildRegistrationNamePromptText(mention: string) {
  return [
    '이름을 함께 입력해주세요.',
    '',
    '예:',
    `${mention} 닉네임 설정 홍길동`,
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
    `현재 목표: ${input.goalTitle}`,
    '',
    `앞으로는 ${input.mention} 인증 + 사진을 함께 올리면 인증됩니다.`,
  ].join('\n');
}

function buildRegistrationRenameText(input: { displayName: string }) {
  return `이름이 ${input.displayName}님으로 변경되었습니다.`;
}

function buildAdminSettingsSummaryText(input: {
  targetCount: number;
  weeklyPenaltyText?: string | null;
}) {
  return [
    '현재 설정이에요 ⚙️',
    '',
    `목표: 주 ${input.targetCount}회 인증`,
    `패널티: ${formatWeeklyPenaltyDisplayText(input.weeklyPenaltyText) ?? '없음'}`,
  ].join('\n');
}

function buildAdminSettingsGoalUpdatedText(input: {
  previousTargetCount: number;
  nextTargetCount: number;
  mention: string;
}) {
  return [
    '목표가 변경됐어요.',
    '',
    `이전: 주 ${input.previousTargetCount}회`,
    `변경: 주 ${input.nextTargetCount}회`,
    '',
    `채널에서 ${input.mention} 목표확인으로 반영 여부를 확인할 수 있어요.`,
  ].join('\n');
}

function buildAdminSettingsPenaltyUpdatedText(input: {
  previousPenaltyText: string | null;
  nextPenaltyText: string | null;
  mention: string;
}) {
  return [
    '패널티가 변경됐어요.',
    '',
    `이전: ${formatWeeklyPenaltyDisplayText(input.previousPenaltyText) ?? '없음'}`,
    `변경: ${formatWeeklyPenaltyDisplayText(input.nextPenaltyText) ?? '없음'}`,
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

async function resolveAdminSettingsIntegration(input: {
  workspaceId: string;
  userId: string;
}) {
  const identity = await prisma.userIdentity.findUnique({
    where: {
      provider_providerUserId_providerWorkspaceId: {
        provider: 'SLACK',
        providerUserId: input.userId,
        providerWorkspaceId: input.workspaceId,
      },
    },
    select: {
      userId: true,
      user: {
        select: {
          memberships: {
            select: {
              groupId: true,
              role: true,
            },
          },
        },
      },
    },
  });

  if (!identity) {
    return { ok: false as const, reason: 'missing_registration' };
  }

  const adminGroupIds = identity.user.memberships
    .filter((membership) => membership.role === 'ADMIN')
    .map((membership) => membership.groupId);

  if (adminGroupIds.length === 0) {
    return { ok: false as const, reason: 'permission_denied' };
  }

  const integration = await prisma.slackIntegration.findFirst({
    where: {
      workspaceId: input.workspaceId,
      groupId: { in: adminGroupIds },
    },
    include: {
      group: true,
      goal: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  if (!integration) {
    return { ok: false as const, reason: 'integration_not_found' };
  }

  return { ok: true as const, integration };
}
