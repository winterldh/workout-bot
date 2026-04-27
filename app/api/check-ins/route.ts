import { NextRequest, NextResponse } from 'next/server';
import { getCheckInTimeline } from '@/lib/services/check-in-timeline';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const workspaceId =
    searchParams.get('workspaceId') ?? process.env.ALLOWED_SLACK_WORKSPACE_ID;
  const channelId =
    searchParams.get('channelId') ?? process.env.ALLOWED_SLACK_CHANNEL_ID;
  const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam) ? limitParam : undefined;

  return NextResponse.json(
    await getCheckInTimeline({
      workspaceId: workspaceId || undefined,
      channelId: channelId || undefined,
      limit,
    }),
  );
}
