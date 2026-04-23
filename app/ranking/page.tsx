import { getCurrentStatus } from '@/lib/services/rankings';

export const dynamic = 'force-dynamic';

export default async function RankingPage() {
  const status =
    process.env.ALLOWED_SLACK_WORKSPACE_ID && process.env.ALLOWED_SLACK_CHANNEL_ID
      ? await getCurrentStatus({
          workspaceId: process.env.ALLOWED_SLACK_WORKSPACE_ID,
          channelId: process.env.ALLOWED_SLACK_CHANNEL_ID,
          externalSlackId: process.env.SLACK_ADMIN_USER_ID ?? 'dashboard',
        })
      : null;

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '48px 24px 80px' }}>
      <h1>주간 랭킹</h1>
      {!status ? (
        <p>Slack integration 설정이 필요합니다.</p>
      ) : (
        <section
          style={{
            background: '#fff',
            borderRadius: 24,
            padding: 24,
          }}
        >
          <p>
            {status.groupName} / {status.goalTitle}
          </p>
          <ol>
            {status.ranking.map((entry) => (
              <li key={entry.userId}>
                {entry.displayName} {entry.count} / {entry.targetCount}
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
