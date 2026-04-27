import { NextRequest, NextResponse } from 'next/server';
import { isAuthorizedCronRequest } from '@/lib/cron/auth';
import { logEvent } from '@/lib/observability/logger';
import { processPendingSubmissionAssets } from '@/lib/services/submission-assets';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  try {
    if (!isAuthorizedCronRequest(request)) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const { searchParams } = request.nextUrl;
    const workspaceId = searchParams.get('workspaceId') ?? undefined;
    const channelId = searchParams.get('channelId') ?? undefined;
    const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam) ? limitParam : undefined;

    logEvent('info', 'slack.pending_assets_started', {
      eventType: 'pending_asset',
      route: '/api/jobs/process-pending-assets',
      workspaceId,
      channelId,
      limit: limit ?? undefined,
    });

    const result = await processPendingSubmissionAssets({
      limit,
      workspaceId,
      channelId,
    });

    logEvent('info', 'slack.pending_assets_found', {
      eventType: 'pending_asset',
      route: '/api/jobs/process-pending-assets',
      claimedCount: result.claimedCount,
      workspaceId,
      channelId,
    });

    logEvent('info', 'slack.pending_assets_processed', {
      eventType: 'pending_asset',
      route: '/api/jobs/process-pending-assets',
      processedCount: result.processedCount,
      failedCount: result.failedCount,
      workspaceId,
      channelId,
    });

    logEvent('info', 'slack.pending_assets_finished', {
      eventType: 'pending_asset',
      route: '/api/jobs/process-pending-assets',
      claimedCount: result.claimedCount,
      processedCount: result.processedCount,
      failedCount: result.failedCount,
      workspaceId,
      channelId,
    });

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    logEvent('error', 'slack.pending_assets_failed', {
      eventType: 'pending_asset',
      route: '/api/jobs/process-pending-assets',
      reason: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
