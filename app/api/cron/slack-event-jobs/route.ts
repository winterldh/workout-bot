import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCronRequest } from '@/lib/cron/auth';
import { reapSlackEventJobs } from '@/lib/services/slack-event-jobs';
import { logEvent } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    if (!isAuthorizedCronRequest(request)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    logEvent('info', 'slack.cron.started', {
      eventType: 'slack_event_job',
      route: '/api/cron/slack-event-jobs',
    });

    const result = await reapSlackEventJobs();
    logEvent('info', 'slack.cron.jobs_found', {
      eventType: 'slack_event_job',
      route: '/api/cron/slack-event-jobs',
      claimedCount: result.claimed,
    });
    logEvent('info', 'slack.cron.jobs_processed', {
      eventType: 'slack_event_job',
      route: '/api/cron/slack-event-jobs',
      processedCount: result.claimed,
    });
    logEvent('info', 'slack.event_job_reaper_run', {
      eventType: 'slack_event_job',
      claimedCount: result.claimed,
    });

    logEvent('info', 'slack.cron.finished', {
      eventType: 'slack_event_job',
      route: '/api/cron/slack-event-jobs',
      claimedCount: result.claimed,
    });

    return NextResponse.json({ ok: true, claimed: result.claimed });
  } catch (error) {
    logEvent('error', 'slack.event_job_reaper_failed', {
      eventType: 'slack_event_job',
      reason: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
