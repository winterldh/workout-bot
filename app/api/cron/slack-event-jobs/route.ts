import { NextResponse } from 'next/server';
import { reapSlackEventJobs } from '@/lib/services/slack-event-jobs';
import { logEvent } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST() {
  try {
    const result = await reapSlackEventJobs();
    logEvent('info', 'slack.event_job_reaper_run', {
      eventType: 'slack_event_job',
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
