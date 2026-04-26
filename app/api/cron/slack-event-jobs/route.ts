import { NextRequest, NextResponse } from 'next/server';
import { reapSlackEventJobs } from '@/lib/services/slack-event-jobs';
import { logEvent } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    const secret = process.env.CRON_SECRET;
    if (secret) {
      const auth = request.headers.get('authorization');
      if (auth !== `Bearer ${secret}`) {
        return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
    }

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
