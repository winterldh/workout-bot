import type { ReactNode } from 'react';
import { getCheckInTimeline } from '@/lib/services/check-in-timeline';
import { TimelineImage } from './timeline-image';

export const dynamic = 'force-dynamic';

export default async function CheckInsPage() {
  const data = await getCheckInTimeline({
    workspaceId: process.env.ALLOWED_SLACK_WORKSPACE_ID,
    channelId: process.env.ALLOWED_SLACK_CHANNEL_ID,
    limit: 24,
  });

  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: '40px 20px 80px' }}>
      <section
        style={{
          background:
            'linear-gradient(135deg, rgba(233, 250, 228, 1) 0%, rgba(255, 248, 219, 1) 52%, rgba(241, 245, 255, 1) 100%)',
          borderRadius: 32,
          padding: '32px 32px 28px',
          boxShadow: '0 28px 70px rgba(16, 28, 20, 0.08)',
        }}
      >
        <p style={{ margin: 0, fontSize: 13, letterSpacing: '0.08em', color: '#5b6b60' }}>
          LIVE CHECK-IN TIMELINE
        </p>
        <h1 style={{ margin: '10px 0 12px', fontSize: 'clamp(32px, 5vw, 50px)' }}>
          인증 타임라인
        </h1>
        <p style={{ margin: 0, fontSize: 17, lineHeight: 1.7, maxWidth: 760, color: '#203126' }}>
          이미지 저장이 아직 끝나지 않아도 카드가 먼저 보이도록 구성했습니다. 최신 항목이 위에
          쌓이고, 처리 중인 이미지는 placeholder로 바로 확인할 수 있습니다.
        </p>
      </section>

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 14,
          marginTop: 20,
        }}
      >
        <MetricCard label="전체 카드" value={String(data.summary.totalCount)} />
        <MetricCard label="인증 반영" value={String(data.summary.approvedCount)} />
        <MetricCard label="이미지 처리중" value={String(data.summary.pendingAssetCount)} />
        <MetricCard label="중복 / 거절" value={`${data.summary.duplicateCount} / ${data.summary.rejectedCount}`} />
      </section>

      <section
        style={{
          marginTop: 24,
          background: '#ffffff',
          borderRadius: 28,
          padding: '28px 20px 20px',
          boxShadow: '0 18px 48px rgba(16, 28, 20, 0.06)',
        }}
      >
        <div style={{ padding: '0 12px 16px' }}>
          <h2 style={{ margin: 0, fontSize: 24 }}>최근 인증 카드</h2>
          <p style={{ margin: '8px 0 0', color: '#617065' }}>
            {data.integration
              ? `${data.integration.groupName} · ${data.integration.goalRoomName}`
              : '아직 Slack integration이 연결되지 않았습니다.'}
          </p>
        </div>

        {data.items.length === 0 ? (
          <EmptyState />
        ) : (
          <ol
            style={{
              listStyle: 'none',
              margin: 0,
              padding: '8px 0 0',
              position: 'relative',
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 28,
                top: 18,
                bottom: 18,
                width: 2,
                background: 'linear-gradient(180deg, #cbd8ca 0%, #d8dbe9 100%)',
              }}
            />
            {data.items.map((item) => (
              <li key={item.id} style={{ position: 'relative', padding: '0 0 18px 0' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 20,
                    top: 30,
                    width: 18,
                    height: 18,
                    borderRadius: 999,
                    border: '3px solid #ffffff',
                    background:
                      item.countIncluded
                        ? '#2f8f5b'
                        : item.duplicate
                          ? '#d17b26'
                          : item.rejected
                            ? '#d24d57'
                            : '#7b8b85',
                    boxShadow: '0 0 0 1px rgba(16, 28, 20, 0.08)',
                  }}
                />
                <article
                  style={{
                    marginLeft: 52,
                    border: '1px solid #e6ebe4',
                    borderRadius: 24,
                    padding: 18,
                    background:
                      item.countIncluded
                        ? 'linear-gradient(180deg, #fbfffc 0%, #f7fbf8 100%)'
                        : item.rejected
                          ? 'linear-gradient(180deg, #fffafa 0%, #fff4f5 100%)'
                          : 'linear-gradient(180deg, #ffffff 0%, #fbfcff 100%)',
                    boxShadow: '0 10px 24px rgba(16, 28, 20, 0.04)',
                  }}
                >
                  <header
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      gap: 16,
                      alignItems: 'flex-start',
                      marginBottom: 14,
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <strong style={{ fontSize: 18 }}>{item.displayName}</strong>
                        <Pill tone="neutral">{item.slackUserId ?? 'slack id 없음'}</Pill>
                        <Pill
                          tone={
                            item.countIncluded ? 'green' : item.duplicate ? 'amber' : item.rejected ? 'red' : 'slate'
                          }
                        >
                          {item.statusLabel}
                        </Pill>
                        <Pill tone={assetTone(item.assetStatus, item.imageUrl)}>
                          {item.assetLabel}
                        </Pill>
                      </div>
                      <div style={{ marginTop: 8, color: '#5b6b60', fontSize: 14, lineHeight: 1.6 }}>
                        <span>{formatDateTime(item.checkedAt)}</span>
                        <span style={{ margin: '0 8px' }}>·</span>
                        <span>기록일 {formatDateOnly(item.recordDate)}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 92 }}>
                      <div style={{ fontSize: 12, color: '#6a776d' }}>카운트 반영</div>
                      <div
                        style={{
                          fontSize: 18,
                          fontWeight: 700,
                          color: item.countIncluded ? '#2f8f5b' : '#8a8f8c',
                        }}
                      >
                        {item.countIncluded ? 'YES' : 'NO'}
                      </div>
                    </div>
                  </header>

                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(220px, 340px) minmax(0, 1fr)',
                      gap: 16,
                      alignItems: 'stretch',
                    }}
                  >
                    <TimelineImage
                      displayName={item.displayName}
                      assetStatus={item.assetStatus === 'NONE' ? 'NONE' : item.assetStatus}
                      imageUrl={item.imageUrl}
                      originalPhotoUrl={item.originalPhotoUrl}
                      retryCount={item.retryCount}
                      lastError={item.lastError}
                    />

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <InfoPanel title="메모" value={item.note ?? '메모 없음'} />
                      <InfoPanel title="count 반영 여부" value={item.countIncluded ? '반영됨' : '카운트 제외'} />
                      <InfoPanel
                        title="상태"
                        value={item.duplicate ? '중복' : item.rejected ? '거절됨' : item.assetLabel}
                      />
                      <InfoPanel
                        title="원본"
                        value={item.source === 'raw_submission' ? item.rawSubmissionId ?? 'raw_submission' : item.candidateId ?? 'duplicate_candidate'}
                      />
                      <InfoPanel title="assetStatus" value={item.assetStatus} />
                      <InfoPanel title="imageUrl 존재" value={item.imageUrl ? 'true' : 'false'} />
                      <InfoPanel title="imageUrl host" value={item.imageUrlHost ?? '없음'} />
                      <InfoPanel title="originalPhotoUrl 존재" value={item.originalPhotoUrl ? 'true' : 'false'} />
                      <InfoPanel title="retryCount" value={String(item.retryCount)} />
                      <InfoPanel title="lastError" value={item.lastError ?? '없음'} />
                    </div>
                  </div>
                </article>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article
      style={{
        background: '#ffffff',
        borderRadius: 24,
        padding: '18px 20px',
        boxShadow: '0 12px 34px rgba(16, 28, 20, 0.06)',
      }}
    >
      <p style={{ margin: 0, fontSize: 13, color: '#647267' }}>{label}</p>
      <strong style={{ display: 'block', marginTop: 10, fontSize: 28 }}>{value}</strong>
    </article>
  );
}

function Pill({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'red' | 'slate' | 'neutral';
  children: ReactNode;
}) {
  const palette = {
    green: { background: '#e7f7ec', color: '#256b43' },
    amber: { background: '#fff1dc', color: '#8f5b12' },
    red: { background: '#ffe9ea', color: '#9a3740' },
    slate: { background: '#eef2f7', color: '#4a5b6d' },
    neutral: { background: '#f2f4f1', color: '#556259' },
  }[tone];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        borderRadius: 999,
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: '0.01em',
        ...palette,
      }}
    >
      {children}
    </span>
  );
}

function InfoPanel({ title, value }: { title: string; value: string }) {
  return (
    <div
      style={{
        border: '1px solid #e7ece5',
        borderRadius: 18,
        padding: '12px 14px',
        background: '#fff',
      }}
    >
      <div style={{ fontSize: 12, color: '#6a776d', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 14, lineHeight: 1.6, color: '#132117', wordBreak: 'break-word' }}>{value}</div>
    </div>
  );
}

function EmptyState() {
  return (
    <div
      style={{
        margin: '10px 12px 6px',
        borderRadius: 24,
        border: '1px dashed #d4ddd0',
        padding: '48px 20px',
        textAlign: 'center',
        color: '#617065',
        background: '#fbfcfa',
      }}
    >
      아직 보여줄 인증 카드가 없습니다.
    </div>
  );
}

function formatDateTime(value: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value);
}

function formatDateOnly(value: Date) {
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).format(value);
}

function assetTone(assetStatus: string, imageUrl: string | null): 'green' | 'amber' | 'red' | 'slate' | 'neutral' {
  if (imageUrl) {
    return 'green';
  }
  if (assetStatus === 'ASSET_FAILED') {
    return 'red';
  }
  if (assetStatus === 'PROCESSING' || assetStatus === 'PENDING') {
    return 'amber';
  }
  return 'slate';
}
