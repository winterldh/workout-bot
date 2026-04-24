export interface SlackUserProfile {
  displayName: string;
  providerUsername?: string;
}

interface SlackApiResult {
  ok?: boolean;
  error?: string;
}

export async function fetchSlackUserProfile(input: {
  token?: string;
  userId: string;
  fallbackDisplayName: string;
  fallbackUsername?: string;
}): Promise<SlackUserProfile> {
  if (!input.token) {
    return {
      displayName: input.fallbackDisplayName,
      providerUsername: input.fallbackUsername,
    };
  }

  try {
    const response = await fetch('https://slack.com/api/users.info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${input.token}`,
      },
      body: new URLSearchParams({ user: input.userId }),
    });
    const result = (await response.json()) as SlackApiResult & {
      user?: {
        name?: string;
        profile?: {
          display_name?: string;
          real_name?: string;
        };
      };
    };

    if (!response.ok || !result.ok) {
      console.warn('Slack users.info failed', result.error ?? response.statusText);
      return {
        displayName: input.fallbackDisplayName,
        providerUsername: input.fallbackUsername,
      };
    }

    return {
      displayName:
        result.user?.profile?.display_name?.trim() ||
        result.user?.profile?.real_name?.trim() ||
        input.fallbackDisplayName,
      providerUsername: result.user?.name?.trim() ?? input.fallbackUsername,
    };
  } catch (error) {
    console.warn('Slack users.info request failed', error);
    return {
      displayName: input.fallbackDisplayName,
      providerUsername: input.fallbackUsername,
    };
  }
}

export async function sendSlackMessage(input: {
  token?: string | null;
  channelId?: string | null;
  text: string;
  threadTs?: string;
}): Promise<boolean> {
  if (!input.token || !input.channelId) {
    return false;
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
      return false;
    }
    return true;
  } catch (error) {
    console.warn('Slack chat.postMessage request failed', error);
    return false;
  }
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
