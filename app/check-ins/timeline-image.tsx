'use client';

import { useMemo, useState } from 'react';

type TimelineAssetStatus = 'PENDING' | 'PROCESSING' | 'ASSET_SAVED' | 'ASSET_FAILED' | 'NONE';

type TimelineImageProps = {
  displayName: string;
  assetStatus: TimelineAssetStatus;
  imageUrl: string | null;
  originalPhotoUrl: string | null;
  retryCount: number;
  lastError: string | null;
};

export function TimelineImage({
  displayName,
  assetStatus,
  imageUrl,
  originalPhotoUrl,
  retryCount,
  lastError,
}: TimelineImageProps) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const imageHost = useMemo(() => getUrlHost(imageUrl), [imageUrl]);
  const originalHost = useMemo(() => getUrlHost(originalPhotoUrl), [originalPhotoUrl]);

  const placeholder = getPlaceholder({
    assetStatus,
    imageUrl,
    failed,
    lastError,
  });

  if (placeholder) {
    return (
      <PlaceholderCard
        displayName={displayName}
        title={placeholder.title}
        description={placeholder.description}
        assetStatus={assetStatus}
        imageUrlExists={Boolean(imageUrl)}
        imageUrlHost={imageHost}
        originalPhotoUrlExists={Boolean(originalPhotoUrl)}
        originalPhotoUrlHost={originalHost}
        retryCount={retryCount}
        lastError={lastError}
      />
    );
  }

  return (
    <div
      style={{
        minHeight: 220,
        borderRadius: 20,
        overflow: 'hidden',
        background: '#eff4ed',
        border: '1px solid #dbe4d7',
        position: 'relative',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl ?? undefined}
        alt={`${displayName} 인증 이미지`}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
          opacity: loaded ? 1 : 0,
          transition: 'opacity 160ms ease',
          pointerEvents: 'none',
        }}
      />
      {!loaded && !failed ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background:
              'linear-gradient(135deg, rgba(230, 238, 228, 0.8) 0%, rgba(246, 249, 244, 1) 100%)',
            color: '#617065',
            fontSize: 14,
          }}
        >
          로딩 중
        </div>
      ) : null}
      <DebugBadge
        assetStatus={assetStatus}
        imageUrlExists={Boolean(imageUrl)}
        imageUrlHost={imageHost}
        originalPhotoUrlExists={Boolean(originalPhotoUrl)}
        originalPhotoUrlHost={originalHost}
        retryCount={retryCount}
        lastError={lastError}
      />
    </div>
  );
}

function getPlaceholder(input: {
  assetStatus: TimelineAssetStatus;
  imageUrl: string | null;
  failed: boolean;
  lastError: string | null;
}) {
  if (input.assetStatus === 'ASSET_FAILED') {
    return {
      title: '이미지 저장 실패',
      description: input.lastError ? `lastError: ${input.lastError}` : '이미지 저장에 실패했습니다.',
    };
  }

  if (input.assetStatus === 'PENDING' || input.assetStatus === 'PROCESSING' || input.assetStatus === 'NONE') {
    return {
      title: '이미지 처리중',
      description: '이미지가 아직 저장되지 않았습니다.',
    };
  }

  if (!input.imageUrl) {
    return {
      title: '이미지 URL 없음',
      description: '저장된 이미지 URL이 없습니다.',
    };
  }

  if (input.failed) {
    return {
      title: '이미지를 불러올 수 없음',
      description: '브라우저에서 이미지를 열 수 없습니다.',
    };
  }

  return null;
}

function PlaceholderCard(input: {
  displayName: string;
  title: string;
  description: string;
  assetStatus: TimelineAssetStatus;
  imageUrlExists: boolean;
  imageUrlHost: string | null;
  originalPhotoUrlExists: boolean;
  originalPhotoUrlHost: string | null;
  retryCount: number;
  lastError: string | null;
}) {
  return (
    <div
      style={{
        minHeight: 220,
        borderRadius: 20,
        overflow: 'hidden',
        background:
          input.assetStatus === 'ASSET_FAILED'
            ? 'linear-gradient(135deg, rgba(255, 238, 240, 1) 0%, rgba(255, 246, 246, 1) 100%)'
            : 'linear-gradient(135deg, rgba(230, 238, 228, 0.8) 0%, rgba(246, 249, 244, 1) 100%)',
        border: '1px solid #dbe4d7',
        position: 'relative',
        display: 'grid',
        placeItems: 'center',
        padding: 20,
        textAlign: 'center',
        color: '#617065',
      }}
    >
      <div>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{input.title}</div>
        <div style={{ fontSize: 14, lineHeight: 1.6 }}>{input.description}</div>
      </div>
      <DebugBadge
        assetStatus={input.assetStatus}
        imageUrlExists={input.imageUrlExists}
        imageUrlHost={input.imageUrlHost}
        originalPhotoUrlExists={input.originalPhotoUrlExists}
        originalPhotoUrlHost={input.originalPhotoUrlHost}
        retryCount={input.retryCount}
        lastError={input.lastError}
      />
    </div>
  );
}

function DebugBadge(input: {
  assetStatus: TimelineAssetStatus;
  imageUrlExists: boolean;
  imageUrlHost: string | null;
  originalPhotoUrlExists: boolean;
  originalPhotoUrlHost: string | null;
  retryCount: number;
  lastError: string | null;
}) {
  return (
    <div
      style={{
        position: 'absolute',
        left: 12,
        right: 12,
        bottom: 12,
        borderRadius: 14,
        padding: '10px 12px',
        background: 'rgba(17, 32, 21, 0.88)',
        color: '#f4f8f2',
        fontSize: 12,
        lineHeight: 1.6,
      }}
    >
      assetStatus: {input.assetStatus} · imageUrl: {String(input.imageUrlExists)}{' '}
      {input.imageUrlHost ? `(${input.imageUrlHost})` : ''}
      {' · '}
      originalPhotoUrl: {String(input.originalPhotoUrlExists)}{' '}
      {input.originalPhotoUrlHost ? `(${input.originalPhotoUrlHost})` : ''}
      {' · '}retryCount: {input.retryCount}
      {input.lastError ? ` · lastError: ${input.lastError}` : ''}
    </div>
  );
}

function getUrlHost(url?: string | null) {
  if (!url) {
    return null;
  }

  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
