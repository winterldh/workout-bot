import { CheckInRecordStatus } from '@prisma/client';
import { addUtcDays, getWeekRange } from '@/lib/domain/date';
import { prisma } from '@/lib/prisma';
import { logEvent } from '@/lib/observability/logger';
import { sendSlackMessage } from '@/lib/slack/client';

export async function buildWeeklyReportText(input: {
  groupId: string;
  goalId: string;
  targetCount: number;
  timeZone: string;
  now: Date;
}) {
  const currentWeek = getWeekRange(input.now, input.timeZone);
  const lastWeekStart = addUtcDays(currentWeek.startDate, -7);
  const lastWeekEnd = addUtcDays(currentWeek.startDate, -1);

  const records = await prisma.checkInRecord.findMany({
    where: {
      goalId: input.goalId,
      status: CheckInRecordStatus.APPROVED,
      recordDate: { gte: lastWeekStart, lte: lastWeekEnd },
    },
    select: {
      userId: true,
      user: { select: { displayName: true } },
    },
    orderBy: [{ recordDate: 'asc' }, { createdAt: 'asc' }],
  });

  const memberships = await prisma.groupMembership.findMany({
    where: { groupId: input.groupId },
    select: {
      userId: true,
      user: { select: { displayName: true } },
    },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  });

  const counts = new Map<string, { displayName: string; count: number }>();
  for (const record of records) {
    const current = counts.get(record.userId) ?? {
      displayName: record.user.displayName,
      count: 0,
    };
    current.count += 1;
    counts.set(record.userId, current);
  }

  const memberResults = memberships
    .map((membership) => ({
      userId: membership.userId,
      displayName: membership.user.displayName,
      count: counts.get(membership.userId)?.count ?? 0,
    }))
    .sort(
      (left, right) =>
        right.count - left.count ||
        left.displayName.localeCompare(right.displayName),
    );

  const achievedMembers = memberResults.filter((entry) => entry.count >= input.targetCount);
  const missedMembers = memberResults.filter((entry) => entry.count < input.targetCount);

  const lines = ['📅 지난주 운동 결과', ''];

  lines.push('✅ 목표 달성');
  if (achievedMembers.length === 0) {
    lines.push('- 없음');
  } else {
    achievedMembers.forEach((entry) => {
      lines.push(`${entry.displayName} (${entry.count}/${input.targetCount})`);
    });
  }

  lines.push('', '❌ 미달성');
  if (missedMembers.length === 0) {
    lines.push('- 없음');
  } else {
    missedMembers.forEach((entry) => {
      lines.push(`${entry.displayName} (${entry.count}/${input.targetCount})`);
    });
  }

  lines.push('', '패널티 대상');
  if (missedMembers.length === 0) {
    lines.push('- 없음');
  } else {
    missedMembers.forEach((entry) => {
      const penaltyText = process.env.WEEKLY_PENALTY_TEXT?.trim() || '패널티 없음';
      lines.push(`- ${entry.displayName} ${penaltyText}`);
    });
  }

  return lines.join('\n');
}

export async function sendWeeklyReports() {
  const now = new Date();
  const runKey = buildWeeklyReportRunKey(now);
  const lockAcquired = await acquireWeeklyReportRunLock(runKey, now);
  if (!lockAcquired) {
    logEvent('info', 'weekly_report.skipped_duplicate', {
      eventType: 'weekly_report',
      runKey,
    });
    return { ok: true, count: 0, skipped: true, runKey };
  }

  const integrations = await prisma.slackIntegration.findMany({
    include: { group: true, goal: true },
  });
  const results: Array<{ channelId: string; sent: boolean; reason?: string }> = [];

  try {
    for (const integration of integrations) {
      const token = process.env.SLACK_BOT_TOKEN ?? integration.botToken;
      if (!token) {
        results.push({ channelId: integration.channelId, sent: false, reason: 'missing_token' });
        continue;
      }

      const text = await buildWeeklyReportText({
        groupId: integration.groupId,
        goalId: integration.goalId,
        targetCount: integration.goal.targetCount,
        timeZone: integration.group.timezone,
        now,
      });

      await sendSlackMessage({
        token,
        channelId: integration.channelId,
        text,
      });
      results.push({ channelId: integration.channelId, sent: true });
    }

    await prisma.weeklyReportRun.update({
      where: { runKey },
      data: {
        status: 'SENT',
        finishedAt: new Date(),
        error: null,
      },
    });

    return { ok: true, count: results.length, results, runKey };
  } catch (error) {
    await prisma.weeklyReportRun.update({
      where: { runKey },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    logEvent('error', 'weekly_report.failed', {
      eventType: 'weekly_report',
      runKey,
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function acquireWeeklyReportRunLock(runKey: string, now: Date) {
  try {
    await prisma.weeklyReportRun.create({
      data: {
        runKey,
        status: 'RUNNING',
        startedAt: now,
      },
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existing = await prisma.weeklyReportRun.findUnique({
        where: { runKey },
      });
      if (!existing) {
        return false;
      }

      if (existing.status === 'SENT') {
        return false;
      }

      const staleThresholdMs = 30 * 60 * 1000;
      const isStale = now.getTime() - existing.startedAt.getTime() > staleThresholdMs;
      if (!isStale) {
        return false;
      }

      await prisma.weeklyReportRun.update({
        where: { runKey },
        data: {
          status: 'RUNNING',
          startedAt: now,
          finishedAt: null,
          error: null,
        },
      });
      return true;
    }

    throw error;
  }
}

function buildWeeklyReportRunKey(now: Date) {
  const weeklyAnchor = getWeekRange(now, 'Asia/Seoul').startDate;
  return `weekly-report:${weeklyAnchor.toISOString().slice(0, 10)}`;
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'P2002',
  );
}
