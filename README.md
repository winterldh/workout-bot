# Workout Check-in

Slack 전용 운동 인증 MVP입니다. 기존 NestJS API와 Next.js web workspace를 루트 단일 Next.js App Router 앱으로 통합했습니다.

## 구조

```txt
app/
  api/
    health/route.ts
    dashboard/summary/route.ts
    slack/events/route.ts
    slack/commands/status/route.ts
    rankings/route.ts
    reports/weekly/route.ts
    cron/weekly-report/route.ts
  page.tsx
  check-ins/page.tsx
  ranking/page.tsx
lib/
  prisma.ts
  domain/date.ts
  services/
  slack/
prisma/
  schema.prisma
  migrations/
  seed.ts
vercel.json
```

## 환경변수

`.env.example`을 기준으로 Vercel Project Settings 또는 로컬 `.env`에 설정합니다.

```txt
DATABASE_URL
SLACK_SIGNING_SECRET
SLACK_BOT_TOKEN
BLOB_READ_WRITE_TOKEN
SLACK_BOT_USER_ID
SLACK_ADMIN_USER_ID
ALLOWED_SLACK_WORKSPACE_ID
ALLOWED_SLACK_CHANNEL_ID
CRON_SECRET
WEEKLY_PENALTY_TEXT
SLACK_SIGNATURE_VERIFICATION_DISABLED
```

`BLOB_READ_WRITE_TOKEN`은 Slack private file을 Vercel Blob에 저장할 때 필요합니다. `CRON_SECRET`은 주간 리포트 Cron 보호용입니다.

## 로컬 실행

```bash
npm install
npm run prisma:generate
npm run prisma:deploy
npm run prisma:seed
npm run dev
```

Slack Request URL은 로컬 터널 기준으로 아래처럼 연결합니다.

```txt
POST /api/slack/events
POST /api/slack/commands/status
```

## 배포

```bash
npm install
npm run prisma:generate
npm run prisma:deploy
npm run build
vercel deploy
```

Vercel Cron은 `vercel.json`의 `/api/cron/weekly-report`를 매주 월요일 10:00 KST에 실행하도록 설정되어 있습니다. `CRON_SECRET`을 설정하면 `Authorization: Bearer <CRON_SECRET>` 요청만 허용합니다.

### Vercel 연결

1. Vercel에서 `New Project`를 열고 GitHub 저장소를 import합니다.
2. Framework는 Next.js로 자동 감지되는지 확인합니다.
3. Build Command는 `npm run build`, Install Command는 `npm install`로 둡니다.
4. 환경변수는 아래 값을 Vercel Project Settings에 등록합니다.

필수 환경변수:

- `DATABASE_URL`
- `SLACK_SIGNING_SECRET`
- `SLACK_BOT_TOKEN`
- `SLACK_BOT_USER_ID`
- `ALLOWED_SLACK_WORKSPACE_ID`
- `ALLOWED_SLACK_CHANNEL_ID`
- `BLOB_READ_WRITE_TOKEN`
- `CRON_SECRET`

## Slack 동작

- `#목표확인`: Slack 사용자를 UserIdentity/GroupMembership에 등록합니다.
- `#인증` + 이미지: RawSubmission, SubmissionAsset, CheckInRecord를 저장합니다.
- Slack 이미지는 `SLACK_BOT_TOKEN`으로 다운로드한 뒤 Vercel Blob에 업로드하고, DB에는 `blobUrl`에 저장합니다.
- Slack 원본 파일 URL은 `slackOriginalUrl`에 보관합니다. 기존 `originalUrl`, `originalPhotoUrl`, `imageUrl`은 호환용 legacy 필드입니다.
- 동일 `goalId + userId + recordDate` 중복: SlackChangeCandidate를 upsert합니다.
- `#변경`: 저장된 SlackChangeCandidate 이미지로 오늘 인증 이미지를 교체합니다.
- `/현황`: 이번 주 멤버별 인증 횟수와 목표 달성 현황을 반환합니다.

### 업로드 실패 fallback

- Slack 파일 다운로드나 Blob 업로드가 실패하면 로그를 남기고 Slack 원본 URL로 fallback 저장합니다.
- 이 경우 `SubmissionAsset.blobUrl`과 `SubmissionAsset.originalUrl`은 Slack URL이 될 수 있습니다.
- 장애 추적은 `slack.asset_upload_fallback`, `slack.asset_upload_success`, `slack.image_selection_ignored`, `slack.checkin_duplicate` 로그를 먼저 확인합니다.
- 이벤트 ACK는 signature 검증과 최소 파싱 후 즉시 응답하고, 실제 체크인은 백그라운드 처리 로그로 추적합니다.

### 이미지 정책

- `#인증` 메시지에 이미지가 1장 있으면 정상 저장합니다.
- 이미지가 여러 장이면 첫 번째 지원 이미지 1장만 사용하고 나머지는 무시합니다.
- 이미지가 없거나 지원하지 않는 형식이면 저장하지 않고 안내 메시지만 보냅니다.
- 허용 MIME 타입은 `image/jpeg`, `image/jpg`, `image/png`, `image/webp`입니다.

### 검증 시나리오

- `#인증` + 이미지 1장: `RawSubmission` / `SubmissionAsset` / `CheckInRecord` 생성
- `#인증` + 이미지 여러 장: 첫 번째 지원 이미지로 생성
- `#인증` 텍스트만: 저장 없이 안내 메시지
- 중복 인증: `SlackChangeCandidate` upsert
- Blob 업로드 실패: Slack URL fallback 저장 및 `slack.asset_upload_fallback` 로그 확인

### 운영 점검 포인트

- Slack event URL이 `/api/slack/events`로 연결됐는지 확인합니다.
- `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `BLOB_READ_WRITE_TOKEN` 누락 여부를 먼저 확인합니다.
- 이상 시 `requestId` / `eventId` 기준으로 `slack.*` JSON 로그를 따라가면 됩니다.
- Blob 업로드 실패가 반복되면 Slack 토큰 권한과 Vercel Blob 토큰을 우선 점검합니다.
- weekly report는 `WeeklyReportRun` 테이블의 `runKey`로 중복 실행을 막고, 30분 이상 오래된 RUNNING 상태만 재시도합니다.

### Slack 연동 URL

- Event Subscriptions URL: `https://<vercel-domain>/api/slack/events`
- Slash Command URL: `https://<vercel-domain>/api/slack/commands/status`

### 배포 후 확인 절차

1. `/api/health`가 `ok: true`를 반환하는지 확인합니다.
2. Slack Event Subscription과 Slash Command URL을 등록합니다.
3. `#인증` + 이미지 1장으로 accepted 경로를 확인합니다.
4. `#인증` + 이미지 여러 장으로 첫 번째 지원 이미지만 저장되는지 확인합니다.
5. `#인증` 텍스트만 입력했을 때 저장 없이 안내 메시지만 오는지 확인합니다.
6. 중복 인증 시 `SlackChangeCandidate` upsert와 duplicate 응답이 유지되는지 확인합니다.

## TODO / 리스크

- 서버리스 안전성을 위해 기존 in-memory pending text/file merge는 제거했습니다. Slack 메시지 하나에 `#인증`과 이미지를 함께 올리는 흐름이 MVP 기본 경로입니다.
- 대시보드는 서버 컴포넌트에서 DB를 직접 조회합니다. 공개 접근 제어가 필요하면 인증을 추가해야 합니다.
- seed는 운영용 integration upsert만 수행하며 기존 데이터는 삭제하지 않습니다.
