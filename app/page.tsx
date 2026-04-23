import { getDashboardSummary } from '@/lib/services/dashboard';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const data = await getDashboardSummary({
    workspaceId: process.env.ALLOWED_SLACK_WORKSPACE_ID,
    channelId: process.env.ALLOWED_SLACK_CHANNEL_ID,
  });

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px 80px' }}>
      <section
        style={{
          background: 'linear-gradient(135deg, #dff6d8 0%, #fef7d6 100%)',
          borderRadius: 28,
          padding: 32,
          boxShadow: '0 24px 60px rgba(17, 32, 21, 0.08)',
        }}
      >
        <p style={{ margin: 0, fontSize: 13, letterSpacing: '0.08em' }}>
          SLACK WORKOUT CHECK-IN
        </p>
        <h1 style={{ margin: '12px 0 8px', fontSize: 42 }}>
          운동 인증 대시보드
        </h1>
        <p style={{ margin: 0, fontSize: 18, lineHeight: 1.6, maxWidth: 680 }}>
          Slack 채널의 #목표확인, #인증, #변경, /현황 흐름을 한 곳에서 확인합니다.
        </p>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 16,
          marginTop: 24,
        }}
      >
        <Card label="설정 상태" value={data.configured ? '연결됨' : '미설정'} />
        <Card label="총 인증 수" value={String(data.summary.totalCheckIns)} />
        <Card label="참여 멤버 수" value={String(data.summary.memberCount)} />
      </section>

      <section
        style={{
          marginTop: 24,
          background: '#ffffff',
          borderRadius: 24,
          padding: 24,
          boxShadow: '0 16px 40px rgba(17, 32, 21, 0.06)',
        }}
      >
        <h2 style={{ marginTop: 0 }}>최근 인증 기록</h2>
        <p style={{ color: '#4f5f53' }}>
          {data.integration
            ? `${data.integration.groupName} / ${data.integration.goalRoomName}`
            : '아직 Slack integration seed가 적용되지 않았습니다.'}
        </p>
        {data.summary.recentCheckIns.length === 0 ? (
          <p>아직 인증 기록이 없습니다.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {data.summary.recentCheckIns.slice(0, 5).map((checkIn) => (
              <li
                key={checkIn.id}
                style={{ borderTop: '1px solid #e5eadf', padding: '16px 0' }}
              >
                <strong>{checkIn.displayName}</strong>
                <div>{new Date(checkIn.checkedAt).toLocaleString('ko-KR')}</div>
                <div style={{ color: '#4f5f53' }}>{checkIn.note ?? '메모 없음'}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <article
      style={{
        background: '#ffffff',
        borderRadius: 24,
        padding: 24,
        boxShadow: '0 16px 40px rgba(17, 32, 21, 0.06)',
      }}
    >
      <p style={{ margin: 0, fontSize: 14, color: '#4f5f53' }}>{label}</p>
      <h2 style={{ margin: '12px 0 0', fontSize: 32 }}>{value}</h2>
    </article>
  );
}
