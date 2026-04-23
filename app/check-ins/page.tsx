import { getDashboardSummary } from '@/lib/services/dashboard';

export const dynamic = 'force-dynamic';

export default async function CheckInsPage() {
  const data = await getDashboardSummary({
    workspaceId: process.env.ALLOWED_SLACK_WORKSPACE_ID,
    channelId: process.env.ALLOWED_SLACK_CHANNEL_ID,
  });

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px 80px' }}>
      <h1>인증 기록</h1>
      {data.summary.recentCheckIns.length === 0 ? (
        <p>아직 인증 기록이 없습니다.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {data.summary.recentCheckIns.map((checkIn) => (
            <li
              key={checkIn.id}
              style={{
                background: '#fff',
                borderRadius: 18,
                padding: 20,
                marginBottom: 12,
              }}
            >
              <strong>{checkIn.displayName}</strong>
              <div>{new Date(checkIn.checkedAt).toLocaleString('ko-KR')}</div>
              <p>{checkIn.note ?? '메모 없음'}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
