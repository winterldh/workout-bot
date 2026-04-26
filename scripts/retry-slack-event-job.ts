const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

type ParsedArgs = {
  eventId: string | null;
  jobId: string | null;
  force: boolean;
};

type JobSnapshot = {
  id: string;
  eventId: string;
  workspaceId: string;
  channelId: string;
  slackUserId: string | null;
  status: string;
  attempts: number;
  lockedAt: Date | null;
  lastError: string | null;
  replySentAt: Date | null;
  channelStatusSentAt: Date | null;
  assetUploadedAt: Date | null;
  checkInRecordId: string | null;
  rawSubmissionId: string | null;
  submissionAssetId: string | null;
  changeCandidateId: string | null;
  processedAt: Date | null;
  nextRetryAt: Date | null;
};

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request: string, parent: any, isMain: boolean, options: any) {
  if (request.startsWith('@/')) {
    const resolved = path.resolve(process.cwd(), request.slice(2));
    return originalResolveFilename.call(this, resolved, parent, isMain, options);
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

function loadDotEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadEnv() {
  loadDotEnvFile(path.resolve(process.cwd(), '.env.local'));
  loadDotEnvFile(path.resolve(process.cwd(), '.env'));
}

function parseArgs(argv: string[]): ParsedArgs {
  let eventId: string | null = null;
  let jobId: string | null = null;
  let force = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--event-id') {
      eventId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--job-id') {
      jobId = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === '--force') {
      force = true;
    }
  }

  return { eventId, jobId, force };
}

function formatDate(value: Date | null) {
  return value ? value.toISOString() : null;
}

function isLocalHost(host: string | null) {
  return ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal'].includes(host ?? '');
}

function parseDatabaseHost(rawUrl?: string | null) {
  if (!rawUrl) {
    return null;
  }

  try {
    return new URL(rawUrl).hostname;
  } catch {
    return null;
  }
}

async function main() {
  loadEnv();

  const args = parseArgs(process.argv.slice(2));
  if (!args.eventId && !args.jobId) {
    console.error('Missing --event-id or --job-id');
    process.exitCode = 1;
    return;
  }

  if (args.eventId && args.jobId) {
    console.error('Use either --event-id or --job-id, not both');
    process.exitCode = 1;
    return;
  }

  const databaseHost = parseDatabaseHost(process.env.DATABASE_URL);
  const directHost = parseDatabaseHost(process.env.DIRECT_URL);
  console.log(JSON.stringify({
    databaseHost,
    directHost,
    databaseIsLocal: isLocalHost(databaseHost),
    directIsLocal: isLocalHost(directHost),
  }, null, 2));

  if (isLocalHost(databaseHost) || isLocalHost(directHost)) {
    console.error('Refusing to run against local database host.');
    process.exitCode = 1;
    return;
  }

  const { PrismaClient } = require('@prisma/client');
  const { processSlackEventJobById } = require('../lib/services/slack-event-jobs');

  const prisma = new PrismaClient();

  try {
    let job: JobSnapshot | null = null;
    if (args.jobId) {
      job = await prisma.slackEventJob.findUnique({
        where: { id: args.jobId },
        select: {
          id: true,
          eventId: true,
          workspaceId: true,
          channelId: true,
          slackUserId: true,
          status: true,
          attempts: true,
          lockedAt: true,
          lastError: true,
          replySentAt: true,
          channelStatusSentAt: true,
          assetUploadedAt: true,
          checkInRecordId: true,
          rawSubmissionId: true,
          submissionAssetId: true,
          changeCandidateId: true,
          processedAt: true,
          nextRetryAt: true,
        },
      });
    } else if (args.eventId) {
      job = await prisma.slackEventJob.findFirst({
        where: { eventId: args.eventId },
        select: {
          id: true,
          eventId: true,
          workspaceId: true,
          channelId: true,
          slackUserId: true,
          status: true,
          attempts: true,
          lockedAt: true,
          lastError: true,
          replySentAt: true,
          channelStatusSentAt: true,
          assetUploadedAt: true,
          checkInRecordId: true,
          rawSubmissionId: true,
          submissionAssetId: true,
          changeCandidateId: true,
          processedAt: true,
          nextRetryAt: true,
        },
      });
    }

    if (!job) {
      console.error(JSON.stringify({
        ok: false,
        reason: 'job_not_found',
        eventId: args.eventId,
        jobId: args.jobId,
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    const staleLeaseMs = 2 * 60 * 1000;
    const lockedAtMs = job.lockedAt ? job.lockedAt.getTime() : null;
    const isStale = lockedAtMs !== null && Date.now() - lockedAtMs > staleLeaseMs;
    const isRecentProcessing = job.status === 'PROCESSING' && !isStale;

    console.log(JSON.stringify({
      target: {
        id: job.id,
        eventId: job.eventId,
      },
      before: {
        status: job.status,
        attempts: job.attempts,
        lockedAt: formatDate(job.lockedAt),
        lastError: job.lastError,
        replySentAt: formatDate(job.replySentAt),
        channelStatusSentAt: formatDate(job.channelStatusSentAt),
        assetUploadedAt: formatDate(job.assetUploadedAt),
        checkInRecordId: job.checkInRecordId,
        rawSubmissionId: job.rawSubmissionId,
        submissionAssetId: job.submissionAssetId,
        changeCandidateId: job.changeCandidateId,
        processedAt: formatDate(job.processedAt),
        nextRetryAt: formatDate(job.nextRetryAt),
        isStale,
      },
    }, null, 2));

    if (job.status === 'DONE' && !args.force) {
      console.error('Refusing to reprocess DONE job. Use --force to override.');
      process.exitCode = 1;
      return;
    }

    if (isRecentProcessing && !args.force) {
      console.error('Job is still PROCESSING and not stale. Use --force to override.');
      process.exitCode = 1;
      return;
    }

    if (args.force) {
      console.warn('WARNING: --force enabled. Reprocessing will continue even if the job is not stale or is DONE.');
    }

    const result = await processSlackEventJobById(job.id);
    console.log(JSON.stringify({ processResult: result }, null, 2));

    const afterJob = await prisma.slackEventJob.findUnique({
      where: { id: job.id },
      select: {
        id: true,
        eventId: true,
        status: true,
        attempts: true,
        lockedAt: true,
        lastError: true,
        replySentAt: true,
        channelStatusSentAt: true,
        assetUploadedAt: true,
        checkInRecordId: true,
        rawSubmissionId: true,
        submissionAssetId: true,
        changeCandidateId: true,
        processedAt: true,
        nextRetryAt: true,
      },
    });

    const checkIn = afterJob?.checkInRecordId
      ? await prisma.checkInRecord.findUnique({
          where: { id: afterJob.checkInRecordId },
          select: {
            id: true,
            goalId: true,
            userId: true,
            recordDate: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : afterJob?.rawSubmissionId
        ? await prisma.checkInRecord.findFirst({
            where: { rawSubmissionId: afterJob.rawSubmissionId },
            select: {
              id: true,
              goalId: true,
              userId: true,
              recordDate: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        : null;

    console.log(JSON.stringify({
      after: {
        status: afterJob?.status ?? null,
        attempts: afterJob?.attempts ?? null,
        lockedAt: formatDate(afterJob?.lockedAt ?? null),
        lastError: afterJob?.lastError ?? null,
        replySentAt: formatDate(afterJob?.replySentAt ?? null),
        channelStatusSentAt: formatDate(afterJob?.channelStatusSentAt ?? null),
        assetUploadedAt: formatDate(afterJob?.assetUploadedAt ?? null),
        checkInRecordId: afterJob?.checkInRecordId ?? null,
        rawSubmissionId: afterJob?.rawSubmissionId ?? null,
        submissionAssetId: afterJob?.submissionAssetId ?? null,
        changeCandidateId: afterJob?.changeCandidateId ?? null,
        processedAt: formatDate(afterJob?.processedAt ?? null),
        nextRetryAt: formatDate(afterJob?.nextRetryAt ?? null),
      },
      checkIn,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
