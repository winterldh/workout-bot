import { NextRequest, NextResponse } from 'next/server';
import { getCurrentStatus } from '@/lib/services/rankings';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const workspaceId =
    searchParams.get('workspaceId') ?? process.env.ALLOWED_SLACK_WORKSPACE_ID;
  const channelId =
    searchParams.get('channelId') ?? process.env.ALLOWED_SLACK_CHANNEL_ID;
  const externalSlackId =
    searchParams.get('externalSlackId') ?? process.env.SLACK_ADMIN_USER_ID ?? 'dashboard';

  if (!workspaceId || !channelId) {
    return NextResponse.json({ configured: false, ranking: [] });
  }

  const status = await getCurrentStatus({
    workspaceId,
    channelId,
    externalSlackId,
  });

  return NextResponse.json(status ?? { configured: false, ranking: [] });
}
