import { NextRequest, NextResponse } from 'next/server';
import {
  ackSlackEventReceipt,
  enqueueSlackEventJob,
  scheduleSlackEventJobProcessing,
} from '@/lib/services/slack-event-jobs';
import { logEvent } from '@/lib/observability/logger';
import { SlackRequestError, verifySlackSignature } from '@/lib/slack/signature';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';

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

    logEvent('info', 'slack.event_received', {
      eventType: 'slack_event',
      requestId,
      eventId: payload.event_id ?? null,
      retryNum,
      retryReason,
      payloadType: payload.type ?? null,
    });

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

    if (payload.type === 'event_callback') {
      const { receipt, job } = await enqueueSlackEventJob({
        payload,
        requestId,
        retryNum,
        retryReason,
      });

      if (receipt) {
        await ackSlackEventReceipt({ receiptId: receipt.id }).catch((error) => {
          logEvent('warn', 'slack.receipt_ack_failed', {
            eventType: 'slack_event',
            requestId,
            eventId: payload.event_id ?? null,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
      }

      after(() => {
        void scheduleSlackEventJobProcessing({ jobId: job?.id });
      });

      return NextResponse.json({ ok: true, received: true });
    }

    return NextResponse.json({ ok: true, received: true });
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
