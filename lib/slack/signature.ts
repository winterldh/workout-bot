import { createHmac, timingSafeEqual } from 'node:crypto';

export class SlackRequestError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export function verifySlackSignature(input: {
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
}) {
  if (process.env.SLACK_SIGNATURE_VERIFICATION_DISABLED === 'true') {
    return;
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    throw new SlackRequestError('SLACK_SIGNING_SECRET is required.', 500);
  }

  if (!input.signature || !input.timestamp || !input.rawBody) {
    throw new SlackRequestError('Missing Slack signature headers.', 400);
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(nowInSeconds - timestamp) > 300) {
    throw new SlackRequestError('Stale Slack request timestamp.', 401);
  }

  const expected = `v0=${createHmac('sha256', signingSecret)
    .update(`v0:${input.timestamp}:${input.rawBody}`)
    .digest('hex')}`;

  if (expected.length !== input.signature.length) {
    throw new SlackRequestError('Invalid Slack signature.', 401);
  }

  const isValid = timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(input.signature),
  );

  if (!isValid) {
    throw new SlackRequestError('Invalid Slack signature.', 401);
  }
}
