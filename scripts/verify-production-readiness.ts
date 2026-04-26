import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

type Severity = 'PASS' | 'WARN' | 'FAIL';

type Result = {
  severity: Severity;
  label: string;
  detail?: string;
};

type ParsedDatabaseUrl = {
  host: string | null;
  protocol: string | null;
  pathname: string | null;
};

let recoveryPrinted = false;
let expectedMigrationsPrinted = false;

function parseDotEnvFile(filePath: string) {
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

function loadEnvFiles() {
  parseDotEnvFile(path.resolve(process.cwd(), '.env.local'));
  parseDotEnvFile(path.resolve(process.cwd(), '.env'));
}

function pushResult(results: Result[], severity: Severity, label: string, detail?: string) {
  results.push({ severity, label, detail });
}

function formatResult(result: Result) {
  return `${result.severity} ${result.label}${result.detail ? ` - ${result.detail}` : ''}`;
}

function hasEnv(name: string) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

function parseDatabaseUrl(rawUrl?: string | null): ParsedDatabaseUrl {
  if (!rawUrl) {
    return { host: null, protocol: null, pathname: null };
  }

  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || null,
      protocol: parsed.protocol || null,
      pathname: parsed.pathname || null,
    };
  } catch {
    return { host: null, protocol: null, pathname: null };
  }
}

function isLocalHost(host: string | null) {
  if (!host) {
    return false;
  }

  return ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal'].includes(host);
}

function printRecoveryCommands(results: Result[]) {
  if (recoveryPrinted) {
    return;
  }
  recoveryPrinted = true;

  const commands = [
    'npx prisma migrate status',
    'npx prisma migrate deploy',
    'npx prisma migrate status',
    'npm run verify:slack-payload',
    'npm run verify:production-readiness',
    'npm run build',
  ];

  pushResult(results, 'FAIL', 'recovery.commands', commands.join(' | '));
}

function printExpectedSlackJobMigrations(results: Result[]) {
  if (expectedMigrationsPrinted) {
    return;
  }
  expectedMigrationsPrinted = true;

  pushResult(
    results,
    'FAIL',
    'db.migrations.expected',
    '20260425020000_add_slack_event_job_queue, 20260425020100_finish_slack_event_job_queue',
  );
}

function runCommand(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    stdio: 'pipe',
  });

  return {
    ok: result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
    status: result.status,
  };
}

async function main() {
  loadEnvFiles();

  const results: Result[] = [];
  const fail = (label: string, detail?: string) => pushResult(results, 'FAIL', label, detail);
  const warn = (label: string, detail?: string) => pushResult(results, 'WARN', label, detail);
  const pass = (label: string, detail?: string) => pushResult(results, 'PASS', label, detail);
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? null;
  const databaseInfo = parseDatabaseUrl(databaseUrl);

  const criticalEnv = [
    'DATABASE_URL',
    'DIRECT_URL',
    'SLACK_SIGNING_SECRET',
    'SLACK_BOT_TOKEN',
    'SLACK_BOT_USER_ID',
    'BLOB_READ_WRITE_TOKEN',
    'CRON_SECRET',
    'ALLOWED_SLACK_WORKSPACE_ID',
    'ALLOWED_SLACK_CHANNEL_ID',
  ];

  let missingCriticalEnv = false;
  for (const key of criticalEnv) {
    if (hasEnv(key)) {
      pass(`env.${key}`);
    } else {
      fail(`env.${key}`, 'missing');
      missingCriticalEnv = true;
    }
  }

  if (hasEnv('SLACK_OWNER_USER_ID')) {
    pass('env.SLACK_OWNER_USER_ID');
  } else {
    warn('env.SLACK_OWNER_USER_ID', 'missing optional owner id');
  }

  const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim() ?? '';
  if (slackBotToken.startsWith('xoxb-')) {
    pass('env.SLACK_BOT_TOKEN format');
  } else {
    warn('env.SLACK_BOT_TOKEN format', 'expected xoxb- prefix');
  }

  if (process.env.SLACK_SIGNING_SECRET?.trim()) {
    pass('env.SLACK_SIGNING_SECRET format');
  }

  if (databaseInfo.host) {
    pass('db.host', databaseInfo.host);
  } else {
    fail('db.host', 'unable to parse DATABASE_URL host');
  }

  if (isLocalHost(databaseInfo.host)) {
    fail(
      'db.host',
      `local host detected (${databaseInfo.host}); this is not the Supabase production database`,
    );
    printExpectedSlackJobMigrations(results);
    printRecoveryCommands(results);
  }

  const canRunMigrationStatus = hasEnv('DIRECT_URL') && !isLocalHost(databaseInfo.host);
  if (canRunMigrationStatus) {
    const migrationStatus = runCommand('npx', ['prisma', 'migrate', 'status']);
    const migrationOutput = `${migrationStatus.stdout}\n${migrationStatus.stderr}`.trim();
    if (migrationStatus.ok && migrationOutput.includes('Database schema is up to date!')) {
      pass('prisma.migrate.status', 'up to date');
    } else if (migrationOutput.includes('Following migration have failed')) {
      fail('prisma.migrate.status', 'failed migration present');
    } else if (migrationOutput.match(/have not yet been applied|not up to date|reset/iu)) {
      fail('prisma.migrate.status', 'pending migration present');
      printExpectedSlackJobMigrations(results);
      printRecoveryCommands(results);
    } else {
      fail(
        'prisma.migrate.status',
        migrationStatus.error
          ? migrationStatus.error.message
          : migrationOutput || `exit ${migrationStatus.status ?? 'unknown'}`,
      );
    }
  } else {
    fail(
      'prisma.migrate.status',
        !hasEnv('DIRECT_URL')
          ? 'DIRECT_URL missing; cannot verify migrations'
          : `DATABASE_URL host ${databaseInfo.host ?? 'unknown'} is not production`,
    );
    printExpectedSlackJobMigrations(results);
    printRecoveryCommands(results);
  }

  const repoRoot = process.cwd();
  const requiredFiles = [
    'app/api/slack/events/route.ts',
    'app/api/cron/slack-event-jobs/route.ts',
    'app/api/cron/weekly-report/route.ts',
  ];
  for (const file of requiredFiles) {
    if (fs.existsSync(path.join(repoRoot, file))) {
      pass(`file.${file}`);
    } else {
      fail(`file.${file}`, 'missing');
    }
  }

  const cronSlackRoute = fs.readFileSync(
    path.join(repoRoot, 'app/api/cron/slack-event-jobs/route.ts'),
    'utf8',
  );
  if (cronSlackRoute.includes('CRON_SECRET') && cronSlackRoute.includes('authorization')) {
    pass('cron.slack-event-jobs.auth');
  } else {
    fail('cron.slack-event-jobs.auth', 'missing bearer validation');
  }

  const weeklyRoute = fs.readFileSync(
    path.join(repoRoot, 'app/api/cron/weekly-report/route.ts'),
    'utf8',
  );
  if (weeklyRoute.includes('CRON_SECRET') && weeklyRoute.includes('authorization')) {
    pass('cron.weekly-report.auth');
  } else {
    fail('cron.weekly-report.auth', 'missing bearer validation');
  }

  const slackJobSource = fs.readFileSync(
    path.join(repoRoot, 'lib/services/slack-event-jobs.ts'),
    'utf8',
  );
  const badPatterns = [
    /Prisma\.sql`"status" = \$\{SlackEventJobStatus\.(PENDING|FAILED|PROCESSING)\}`/g,
    /status IN \(\s*'PENDING',\s*'FAILED'\s*\)/g,
    /\$\{SlackEventJobStatus\.(PENDING|FAILED|PROCESSING)\}(?!::"SlackEventJobStatus")/g,
  ];
  const hasBadEnumComparison = badPatterns.some((pattern) => pattern.test(slackJobSource));
  if (hasBadEnumComparison) {
    fail('slack-event-jobs.raw-sql.enums', 'missing explicit enum cast');
  } else {
    pass('slack-event-jobs.raw-sql.enums');
  }

  const expectedEnumCasts = [
    '"status" = ${SlackEventJobStatus.PENDING}::"SlackEventJobStatus"',
    '"status" = ${SlackEventJobStatus.FAILED}::"SlackEventJobStatus"',
    '"status" = ${SlackEventJobStatus.PROCESSING}::"SlackEventJobStatus"',
    '"status" = ${SlackEventJobStatus.PROCESSING}::"SlackEventJobStatus"',
  ];
  if (expectedEnumCasts.every((snippet) => slackJobSource.includes(snippet))) {
    pass('slack-event-jobs.raw-sql.enum-casts');
  } else {
    fail('slack-event-jobs.raw-sql.enum-casts', 'expected cast syntax not found');
  }

  if (!missingCriticalEnv && canRunMigrationStatus) {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();

    try {
      const schemaTables = [
        'SlackEventReceipt',
        'SlackEventJob',
        'SlackIntegration',
        'Group',
        'Goal',
        'User',
        'UserIdentity',
        'GroupMembership',
        'RawSubmission',
        'SubmissionAsset',
        'CheckInRecord',
        'SlackChangeCandidate',
        'WeeklyReportRun',
        'GroupSetting',
      ];

      for (const table of schemaTables) {
        const rows = await prisma.$queryRawUnsafe<{ table_name: string | null }[]>(
          `select to_regclass('public."${table}"')::text as table_name`,
        );
        if (rows[0]?.table_name) {
          pass(`db.table.${table}`);
        } else {
          fail(`db.table.${table}`, 'missing');
          if (table === 'SlackEventJob') {
            fail(
              'db.table.SlackEventJob.hint',
              'missing table; check db.migrations.expected and recovery.commands above',
            );
            printExpectedSlackJobMigrations(results);
            printRecoveryCommands(results);
          }
        }
      }

      const enumRows = await prisma.$queryRawUnsafe<
        { enum_name: string; label: string }[]
      >(
        `select t.typname as enum_name, e.enumlabel as label
         from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         where t.typname in ('SlackEventJobStatus', 'SlackEventJobResultStatus', 'SlackEventReceiptStatus')
         order by t.typname, e.enumsortorder`,
      );
      const enumMap = new Map<string, string[]>();
      for (const row of enumRows) {
        const list = enumMap.get(row.enum_name) ?? [];
        list.push(row.label);
        enumMap.set(row.enum_name, list);
      }

      const expectedEnums: Record<string, string[]> = {
        SlackEventJobStatus: ['PENDING', 'PROCESSING', 'DONE', 'FAILED'],
        SlackEventJobResultStatus: ['ACCEPTED', 'DUPLICATE', 'IGNORED', 'REPLIED'],
        SlackEventReceiptStatus: ['RECEIVED', 'ACKED', 'PROCESSING', 'DONE', 'FAILED'],
      };

      for (const [enumName, expected] of Object.entries(expectedEnums)) {
        const actual = enumMap.get(enumName) ?? [];
        if (expected.every((value) => actual.includes(value))) {
          pass(`db.enum.${enumName}`);
        } else {
          fail(`db.enum.${enumName}`, `expected ${expected.join(', ')} got ${actual.join(', ')}`);
        }
      }

      const enumSmokeChecks = [
        ['PENDING', 'SlackEventJobStatus'],
        ['FAILED', 'SlackEventJobStatus'],
        ['PROCESSING', 'SlackEventJobStatus'],
        ['DONE', 'SlackEventJobStatus'],
      ] as const;
      for (const [value, typeName] of enumSmokeChecks) {
        try {
          await prisma.$queryRawUnsafe(
            `select count(*) from "SlackEventJob" where "status" = '${value}'::"${typeName}"`,
          );
          pass(`db.enum-cast.${value}`);
        } catch (error) {
          fail(
            `db.enum-cast.${value}`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }

      const uniqueChecks = [
        {
          label: 'db.unique.SlackEventReceipt.workspaceId_eventId',
          table: 'SlackEventReceipt',
          snippet: '("workspaceId", "eventId")',
        },
        {
          label: 'db.unique.SlackEventJob.workspaceId_eventId',
          table: 'SlackEventJob',
          snippet: '("workspaceId", "eventId")',
        },
        {
          label: 'db.unique.CheckInRecord.goalId_userId_recordDate',
          table: 'CheckInRecord',
          snippet: '("goalId", "userId", "recordDate")',
        },
        {
          label: 'db.unique.SlackIntegration.workspaceId_channelId',
          table: 'SlackIntegration',
          snippet: '("workspaceId", "channelId")',
        },
      ] as const;

      for (const check of uniqueChecks) {
        const rows = await prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
          `select indexname, indexdef
           from pg_indexes
           where schemaname = 'public'
             and lower(tablename) = lower('${check.table}')`,
        );
        if (rows.some((row) => row.indexdef.includes('UNIQUE') && row.indexdef.includes(check.snippet))) {
          pass(check.label);
        } else {
          fail(check.label, 'missing unique constraint');
        }
      }

      const jobIndexes = await prisma.$queryRawUnsafe<{ indexname: string; indexdef: string }[]>(
        `select indexname, indexdef
         from pg_indexes
         where schemaname = 'public'
           and lower(tablename) = lower('SlackEventJob')`,
      );
      const hasJobIndex = jobIndexes.some(
        (row) =>
          row.indexdef.includes('(status, "nextRetryAt", "lockedAt")') ||
          row.indexdef.includes('("status", "nextRetryAt", "lockedAt")') ||
          row.indexdef.includes('"status", "nextRetryAt", "lockedAt"'),
      );
      if (hasJobIndex) {
        pass('db.index.SlackEventJob.status_nextRetryAt_lockedAt');
      } else {
        fail(
          'db.index.SlackEventJob.status_nextRetryAt_lockedAt',
          jobIndexes.map((row) => `${row.indexname}: ${row.indexdef}`).join(' | ') || 'missing index',
        );
      }

      const slackIntegration = await prisma.slackIntegration.findUnique({
        where: {
          workspaceId_channelId: {
            workspaceId: process.env.ALLOWED_SLACK_WORKSPACE_ID!,
            channelId: process.env.ALLOWED_SLACK_CHANNEL_ID!,
          },
        },
        include: { group: true, goal: true },
      });
      if (slackIntegration) {
        pass('smoke.slackIntegration.findUnique');
        if (slackIntegration.goalId) {
          const goal = await prisma.goal.findUnique({
            where: { id: slackIntegration.goalId },
          });
          if (goal) {
            pass('smoke.activeGoal');
          } else {
            fail('smoke.activeGoal', 'goal missing');
          }
        } else {
          warn('smoke.activeGoal', 'integration found without goal');
        }
      } else {
        fail('smoke.slackIntegration.findUnique', 'integration missing');
      }

      try {
        if (slackIntegration?.groupId) {
          await prisma.groupSetting.findFirst({
            where: {
              groupId: slackIntegration.groupId,
            },
          });
          pass('smoke.groupSetting');
        } else {
          warn('smoke.groupSetting', 'skipped because integration missing group');
        }
      } catch (error) {
        fail('smoke.groupSetting', error instanceof Error ? error.message : String(error));
      }

      const recentJobs = await prisma.slackEventJob.findMany({
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, status: true, workspaceId: true, channelId: true },
      });
      if (recentJobs.length >= 0) {
        pass('smoke.recentSlackEventJobs');
      }

      const jobCounts = await prisma.$transaction([
        prisma.slackEventJob.count({ where: { status: 'PENDING' as const } }),
        prisma.slackEventJob.count({ where: { status: 'PROCESSING' as const } }),
        prisma.slackEventJob.count({ where: { status: 'FAILED' as const } }),
        prisma.checkInRecord.count(),
      ]);
      pass('smoke.jobCounts', `pending=${jobCounts[0]}, processing=${jobCounts[1]}, failed=${jobCounts[2]}, checkIns=${jobCounts[3]}`);

      const payloadCheck = runCommand('npm', ['run', 'verify:slack-payload']);
      if (payloadCheck.ok) {
        pass('verify.slack-payload');
      } else {
        fail('verify.slack-payload', `${payloadCheck.stdout}\n${payloadCheck.stderr}`.trim());
      }
    } finally {
      await prisma.$disconnect();
    }
  } else {
    warn(
      'db.checks.skipped',
      !canRunMigrationStatus ? 'migration checks skipped because DIRECT_URL missing or host is local' : 'critical env missing',
    );
  }

  for (const result of results) {
    console.log(formatResult(result));
  }

  const hasFail = results.some((result) => result.severity === 'FAIL');
  const warnCount = results.filter((result) => result.severity === 'WARN').length;
  const passCount = results.filter((result) => result.severity === 'PASS').length;
  console.log(`SUMMARY PASS=${passCount} WARN=${warnCount} FAIL=${results.filter((r) => r.severity === 'FAIL').length}`);

  if (hasFail) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`FAIL script.unhandled - ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
