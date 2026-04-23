import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface TestEnv {
  databaseUrl: string;
  workspaceId: string;
  channelId: string;
  groupSlug: string;
  groupName: string;
  groupTimezone: string;
  goalTitle: string;
  publicBaseUrl?: string;
  slackSigningSecret?: string;
  slackBotToken?: string;
  slackSignatureVerificationDisabled?: string;
}

function requireDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env first.');
  }

  return databaseUrl;
}

export function loadDotEnv(filePath = resolve(process.cwd(), '.env')) {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, 'utf8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, '');

    process.env[key] ??= value;
  }
}

export function getTestEnv(): TestEnv {
  loadDotEnv();

  return {
    databaseUrl: requireDatabaseUrl(),
    workspaceId: process.env.ALLOWED_SLACK_WORKSPACE_ID ?? 'T_WORKSPACE',
    channelId: process.env.ALLOWED_SLACK_CHANNEL_ID ?? 'C_CHECKIN',
    groupSlug: process.env.SEED_GROUP_SLUG ?? 'default-group',
    groupName: process.env.SEED_GROUP_NAME ?? '기본 운동 모임',
    groupTimezone: process.env.SEED_GROUP_TIMEZONE ?? 'Asia/Seoul',
    goalTitle: process.env.SEED_GOAL_TITLE ?? '기본 인증 목표',
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSignatureVerificationDisabled:
      process.env.SLACK_SIGNATURE_VERIFICATION_DISABLED,
  };
}

export function getOperationalEnv(): TestEnv {
  return getTestEnv();
}

export function getScenarioEnv(): TestEnv {
  loadDotEnv();

  return {
    databaseUrl: requireDatabaseUrl(),
    workspaceId: process.env.SCENARIO_SLACK_WORKSPACE_ID ?? 'T_SCENARIO',
    channelId: process.env.SCENARIO_SLACK_CHANNEL_ID ?? 'C_SCENARIO',
    groupSlug: process.env.SCENARIO_GROUP_SLUG ?? 'scenario-workout-mvp',
    groupName: process.env.SCENARIO_GROUP_NAME ?? '시나리오 검증 모임',
    groupTimezone: process.env.SCENARIO_GROUP_TIMEZONE ?? 'Asia/Seoul',
    goalTitle: process.env.SCENARIO_GOAL_TITLE ?? '시나리오 주간 운동 인증',
    publicBaseUrl: process.env.PUBLIC_BASE_URL,
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET,
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackSignatureVerificationDisabled:
      process.env.SLACK_SIGNATURE_VERIFICATION_DISABLED,
  };
}
