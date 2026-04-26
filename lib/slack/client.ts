interface SlackApiResult {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
}

export function formatSlackMention(userId?: string | null) {
  return userId ? `<@${userId}>` : '';
}

export async function postSlackMessage(input: {
  token?: string | null;
  channelId?: string | null;
  text: string;
  threadTs?: string;
}): Promise<SlackApiResult & { ok: boolean; ts?: string; channel?: string }> {
  if (!input.token || !input.channelId) {
    return { ok: false };
  }

  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({
        channel: input.channelId,
        text: input.text,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      }),
    });
    const result = (await response.json()) as SlackApiResult;
    if (!response.ok || !result.ok) {
      console.warn('Slack chat.postMessage failed', result.error ?? response.statusText);
      return { ok: false, error: result.error ?? response.statusText };
    }
    return { ok: true, ts: result.ts, channel: result.channel };
  } catch (error) {
    console.warn('Slack chat.postMessage request failed', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function sendSlackMessage(input: {
  token?: string | null;
  channelId?: string | null;
  text: string;
  threadTs?: string;
}): Promise<boolean> {
  const result = await postSlackMessage(input);
  return result.ok;
}

export async function sendSlackDirectMessage(input: {
  token?: string | null;
  userId?: string | null;
  text: string;
}) {
  if (!input.token || !input.userId) {
    return;
  }

  try {
    const openResponse = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${input.token}`,
      },
      body: JSON.stringify({ users: input.userId }),
    });
    const openResult = (await openResponse.json()) as SlackApiResult & {
      channel?: { id?: string };
    };

    if (!openResponse.ok || !openResult.ok || !openResult.channel?.id) {
      console.warn('Slack conversations.open failed', openResult.error);
      return;
    }

    await sendSlackMessage({
      token: input.token,
      channelId: openResult.channel.id,
      text: input.text,
    });
  } catch (error) {
    console.warn('Slack DM request failed', error);
  }
}
