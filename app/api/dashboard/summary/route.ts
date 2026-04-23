import { NextRequest, NextResponse } from 'next/server';
import { getDashboardSummary } from '@/lib/services/dashboard';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const workspaceId =
    searchParams.get('workspaceId') ?? process.env.ALLOWED_SLACK_WORKSPACE_ID;
  const channelId =
    searchParams.get('channelId') ?? process.env.ALLOWED_SLACK_CHANNEL_ID;

  return NextResponse.json(
    await getDashboardSummary({
      workspaceId: workspaceId || undefined,
      channelId: channelId || undefined,
    }),
  );
}
