import { NextRequest, NextResponse } from 'next/server';
import {
  ackSlackEventReceipt,
  enqueueSlackEventJob,
  scheduleSlackEventJobProcessing,
} from '@/lib/services/slack-event-jobs';
import { logEvent } from '@/lib/observability/logger';
import {
  normalizeSlackEventPayload,
  validateSlackEventPayloadForWrite,
} from '@/lib/slack/payload-normalizer';
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

    const normalized = normalizeSlackEventPayload(payload);
    const validation = validateSlackEventPayloadForWrite(normalized);

    logEvent('info', 'slack.event_received', {
      eventType: 'slack_event',
      requestId,
      eventId: normalized.eventId ?? undefined,
      retryNum,
      retryReason,
      payloadType: normalized.payloadType,
      workspaceId: normalized.workspaceId ?? undefined,
      channelId: normalized.channelId ?? undefined,
      slackUserId: normalized.slackUserId ?? undefined,
    });

    if (normalized.payloadType === 'url_verification') {
      logEvent('info', 'slack.url_verification', {
        eventType: 'slack_event',
        requestId,
        eventId: normalized.eventId ?? undefined,
      });
      return NextResponse.json({ challenge: payload.challenge });
    }

    const eventContext = {
      requestId,
      eventId: normalized.eventId ?? undefined,
      retryNum,
      retryReason,
    };

    if (retryNum) {
      logEvent('info', 'slack.retry_received', {
        eventType: 'slack_event',
        ...eventContext,
      });
    }

    if (normalized.payloadType === 'event_callback') {
      if (!validation.ok) {
        logEvent('warn', 'slack.event_ignored_invalid_payload', {
          eventType: 'slack_event',
          requestId,
          eventId: normalized.eventId ?? undefined,
          workspaceId: normalized.workspaceId ?? undefined,
          channelId: normalized.channelId ?? undefined,
          slackUserId: normalized.slackUserId ?? undefined,
          payloadType: normalized.payloadType,
          eventTypeValue: normalized.eventType,
          missingFields: validation.missingFields,
          reason: validation.reason,
        });
        return NextResponse.json({ ok: true, received: true });
      }

      const { receipt, job } = await enqueueSlackEventJob({
        payload,
        normalized,
        requestId,
        retryNum,
        retryReason,
      });

      if (receipt) {
        await ackSlackEventReceipt({ receiptId: receipt.id }).catch((error) => {
          logEvent('warn', 'slack.receipt_ack_failed', {
            eventType: 'slack_event',
            requestId,
            eventId: normalized.eventId ?? undefined,
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
