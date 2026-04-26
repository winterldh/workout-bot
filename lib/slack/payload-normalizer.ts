type SlackAuthorization = {
  team_id?: string;
};

export type SlackEventPayload = Record<string, any>;

export type NormalizedSlackEventPayload = {
  eventId: string | null;
  workspaceId: string | null;
  eventType: string;
  payloadType: string;
  channelId: string | null;
  slackUserId: string | null;
};

export type SlackPayloadValidationResult = {
  ok: boolean;
  missingFields: string[];
  reason: string | null;
};

function pickString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function normalizeSlackEventPayload(
  payload: SlackEventPayload,
): NormalizedSlackEventPayload {
  const payloadType = pickString(payload?.type) ?? 'unknown';
  const eventType = pickString(payload?.event?.type) ?? payloadType ?? 'unknown';
  const eventId = pickString(payload?.event_id);
  const workspaceId =
    pickString(payload?.team_id) ??
    pickString((payload?.authorizations?.[0] as SlackAuthorization | undefined)?.team_id);
  const channelId = pickString(payload?.event?.channel);
  const slackUserId = pickString(payload?.event?.user);

  return {
    eventId,
    workspaceId,
    eventType,
    payloadType,
    channelId,
    slackUserId,
  };
}

export function validateSlackEventPayloadForWrite(
  normalized: NormalizedSlackEventPayload,
): SlackPayloadValidationResult {
  const missingFields = ['eventId', 'workspaceId', 'channelId'].filter((field) => {
    const key = field as keyof NormalizedSlackEventPayload;
    return normalized[key] === null;
  });

  return {
    ok: missingFields.length === 0,
    missingFields,
    reason: missingFields.length > 0 ? `missing_${missingFields.join('_')}` : null,
  };
}
