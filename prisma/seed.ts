import { PrismaClient } from '@prisma/client';
import { ensureOperationalSlackIntegration } from '../scripts/support/test-db';
import { getOperationalEnv } from '../scripts/support/test-env';

const prisma = new PrismaClient();

async function main() {
  const env = getOperationalEnv();

  const { group, goal, integration } = await ensureOperationalSlackIntegration(
    prisma,
    env,
  );

  console.log('Operational seed completed.');
  console.log({
    group: {
      id: group.id,
      slug: group.slug,
      name: group.name,
    },
    goal: {
      id: goal.id,
      title: goal.title,
    },
    slackIntegration: {
      id: integration.id,
      workspaceId: integration.workspaceId,
      channelId: integration.channelId,
      autoJoinOnFirstCheckIn: integration.autoJoinOnFirstCheckIn,
    },
    note: '기존 시나리오/테스트 데이터는 삭제하지 않고 운영용 데이터만 upsert 했습니다.',
  });
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
