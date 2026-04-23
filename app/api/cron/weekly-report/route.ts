import { NextRequest, NextResponse } from 'next/server';
import { sendWeeklyReports } from '@/lib/services/reports';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
  }

  return NextResponse.json(await sendWeeklyReports());
}
