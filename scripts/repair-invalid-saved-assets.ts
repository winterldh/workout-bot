import { SubmissionAssetStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';

type BadAsset = {
  id: string;
  rawSubmissionId: string;
  blobUrl: string | null;
  originalPhotoUrl: string | null;
  slackOriginalUrl: string | null;
  originalUrl: string | null;
  assetRetryCount: number;
  assetLastError: string | null;
  assetProcessedAt: Date | null;
};

async function main() {
  const assets = await prisma.submissionAsset.findMany({
    where: {
      assetStatus: SubmissionAssetStatus.ASSET_SAVED,
    },
    select: {
      id: true,
      rawSubmissionId: true,
      blobUrl: true,
      originalPhotoUrl: true,
      slackOriginalUrl: true,
      originalUrl: true,
      assetRetryCount: true,
      assetLastError: true,
      assetProcessedAt: true,
    },
    orderBy: { createdAt: 'asc' },
  }) as BadAsset[];

  const invalidAssets = assets.filter((asset) => !isPublicUrl(asset.blobUrl));

  if (invalidAssets.length === 0) {
    console.log('No invalid ASSET_SAVED records found.');
    return;
  }

  let requeued = 0;
  let failedOnly = 0;

  for (const asset of invalidAssets) {
    const hasSource =
      Boolean(asset.originalPhotoUrl) || Boolean(asset.slackOriginalUrl) || Boolean(asset.originalUrl);
    const nextRetryAt = hasSource ? new Date() : null;
    await prisma.submissionAsset.update({
      where: { id: asset.id },
      data: {
        blobUrl: null,
        assetStatus: SubmissionAssetStatus.ASSET_FAILED,
        assetLastError: 'missing_public_image_url',
        assetLockedAt: null,
        assetProcessedAt: null,
        assetNextRetryAt: nextRetryAt,
        storageKey: null,
      },
    });

    if (hasSource) {
      requeued += 1;
    } else {
      failedOnly += 1;
    }

    console.log(
      [
        asset.id,
        asset.rawSubmissionId,
        hasSource ? 'REQUEUED' : 'FAILED_ONLY',
        asset.slackOriginalUrl ?? asset.originalPhotoUrl ?? asset.originalUrl ?? 'no-source',
      ].join(' | '),
    );
  }

  console.log(
    JSON.stringify(
      {
        total: assets.length,
        requeued,
        failedOnly,
      },
      null,
      2,
    ),
  );
}

function isPublicUrl(url: string | null) {
  if (!url) {
    return false;
  }

  try {
    const host = new URL(url).host;
    return !host.includes('slack.com');
  } catch {
    return false;
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
