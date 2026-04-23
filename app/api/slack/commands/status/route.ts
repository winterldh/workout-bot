import { NextRequest, NextResponse } from 'next/server';
import {
  handleStatusCommand,
  notifyStatusCommandFailure,
} from '@/lib/services/slack';
import { SlackRequestError, verifySlackSignature } from '@/lib/slack/signature';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const payload = Object.fromEntries(new URLSearchParams(rawBody));

  try {
    verifySlackSignature({
      signature: request.headers.get('x-slack-signature'),
      timestamp: request.headers.get('x-slack-request-timestamp'),
      rawBody,
    });

    return NextResponse.json(await handleStatusCommand(payload));
  } catch (error) {
    await notifyStatusCommandFailure({ payload, error, stage: 'route' });

    const status = error instanceof SlackRequestError ? error.status : 200;
    return NextResponse.json(
      {
        response_type: 'in_channel',
        text: '문제가 발생해 요청 이력을 DM으로 보냈어요. 다시 시도해주세요.',
      },
      { status },
    );
  }
}
