import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({
    ok: true,
    service: 'workout-checkin',
    runtime: 'nextjs',
    timestamp: new Date().toISOString(),
  });
}
