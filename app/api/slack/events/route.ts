import { NextRequest, NextResponse } from 'next/server';
import { handleSlackEvent } from '@/lib/services/slack';
import { logEvent } from '@/lib/observability/logger';
import { SlackRequestError, verifySlackSignature } from '@/lib/slack/signature';
import { randomUUID } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? randomUUID();
  const retryNum = request.headers.get('x-slack-retry-num');
  const retryReason = request.headers.get('x-slack-retry-reason');
  const rawBody = await request.text();

  try {
    verifySlackSignature({
      signature: request.headers.get('x-slack-signature'),
      timestamp: request.headers.get('x-slack-request-timestamp'),
      rawBody,
    });

    let payload: Record<string, any>;
    try {
      payload = JSON.parse(rawBody) as Record<string, any>;
    } catch (error) {
      logEvent('warn', 'slack.payload_invalid', {
        eventType: 'slack_event',
        requestId,
        reason: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.json({ ok: true, ignored: true });
    }

    if (payload.type === 'url_verification') {
      logEvent('info', 'slack.url_verification', {
        eventType: 'slack_event',
        requestId,
        eventId: payload.event_id ?? null,
      });
      return NextResponse.json({ challenge: payload.challenge });
    }

    const eventContext = {
      requestId,
      eventId: payload.event_id ?? undefined,
      retryNum,
      retryReason,
    };

    if (retryNum) {
      logEvent('info', 'slack.retry_received', {
        eventType: 'slack_event',
        ...eventContext,
      });
    }

    const result = await handleSlackEvent(payload, eventContext);
    return NextResponse.json(result ?? { ok: true, received: true });
  } catch (error) {
    if (error instanceof SlackRequestError) {
      logEvent('warn', 'slack.signature_verification_failed', {
        eventType: 'slack_event',
        requestId,
        reason: error.message,
      });
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: error.status },
      );
    }
    logEvent('error', 'slack.event_route_failed', {
      eventType: 'slack_event',
      requestId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: true, ignored: true });
  }
}
