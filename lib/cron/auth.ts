import type { NextRequest } from 'next/server';

export function isAuthorizedCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  const vercelCronHeader = request.headers.get('x-vercel-cron');

  if (vercelCronHeader) {
    return true;
  }

  if (secret && auth === `Bearer ${secret}`) {
    return true;
  }

  if (!secret) {
    return true;
  }

  return false;
}
