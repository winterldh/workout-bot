# Workout Check-in

Slack 전용 운동 인증 MVP입니다. 기존 NestJS API와 Next.js web workspace를 루트 단일 Next.js App Router 앱으로 통합했습니다.

## 구조

```txt
app/
  api/
    health/route.ts
    check-ins/route.ts
    dashboard/summary/route.ts
    slack/events/route.ts
    slack/commands/status/route.ts
    rankings/route.ts
    reports/weekly/route.ts
    cron/weekly-report/route.ts
    jobs/process-pending-assets/route.ts
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
DIRECT_URL
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

`DATABASE_URL`은 앱 런타임용 Supabase Transaction pooler URI, `DIRECT_URL`은 Prisma migration용 Supabase Direct connection URI입니다. `BLOB_READ_WRITE_TOKEN`은 Slack private file을 Vercel Blob에 저장할 때 필요하고, `CRON_SECRET`은 주간 리포트 Cron 보호용입니다.
`WEEKLY_PENALTY_TEXT`는 `GroupSetting.weeklyPenaltyText`가 없을 때만 사용하는 fallback입니다.
`SubmissionAsset.assetStatus`는 `PENDING / PROCESSING / ASSET_SAVED / ASSET_FAILED`로 바뀌며, 카드 화면은 blob 저장이 끝나기 전에도 먼저 표시됩니다.

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
npm run verify:slack-payload
npm run verify:production-readiness
npm run verify:predeploy
npm run retry:slack-job -- --event-id <EVENT_ID>
npm run prisma:generate
npm run prisma:deploy
npm run build
vercel deploy
```

Vercel Cron은 `vercel.json`의 `/api/cron/weekly-report`를 매주 월요일 10:00 KST에 실행하도록 설정되어 있습니다. `CRON_SECRET`을 설정하면 `Authorization: Bearer <CRON_SECRET>` 요청만 허용합니다.

`/api/cron/slack-event-jobs`는 Vercel Hobby 플랜에서는 Vercel Cron 대신 외부 cron으로 호출합니다. 권장 방식은 `cron-job.org`, `UptimeRobot`, GitHub Actions schedule, 또는 Upstash QStash입니다. 외부 cron은 아래처럼 호출합니다.

```bash
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  https://<YOUR_DOMAIN>/api/cron/slack-event-jobs
```

Vercel Hobby에서는 `weekly-report`만 Vercel Cron으로 유지하고, Slack job reaper는 1분 주기의 외부 cron에 맡깁니다.

`/api/jobs/process-pending-assets`는 관리자 수동 실행이나 별도 외부 cron에서 사용할 수 있습니다.

```bash
curl -X POST \
  -H "Authorization: Bearer $CRON_SECRET" \
  "https://<YOUR_DOMAIN>/api/jobs/process-pending-assets?limit=10"
```

이 경로는 `SubmissionAsset`의 `PENDING`, `PROCESSING`, `ASSET_FAILED` 중 처리 대상만 N개씩 가져와서 blob 업로드를 이어서 처리합니다. 카드 화면은 `이미지 처리중` placeholder를 먼저 보여주고, 새로고침 시 blob이 생기면 실제 이미지를 보여줍니다.

Supabase에서는 `Supabase Dashboard -> Project Settings -> Database -> Connect -> ORM` 탭에서 값을 복사합니다.

- `DATABASE_URL`: Transaction pooler를 선택한 뒤 Connection string을 복사합니다.
- `DIRECT_URL`: Direct connection을 선택한 뒤 Connection string을 복사합니다.

마이그레이션 실행 전에는 터미널에서 아래처럼 환경변수를 넣고 실행합니다.

```bash
export DATABASE_URL="Transaction pooler connection string"
export DIRECT_URL="Direct connection string"
npx prisma migrate deploy
npm run prisma:seed
```

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
- `SLACK_ADMIN_USER_ID`
- `ALLOWED_SLACK_WORKSPACE_ID`
- `ALLOWED_SLACK_CHANNEL_ID`
- `BLOB_READ_WRITE_TOKEN`
- `CRON_SECRET`
- `WEEKLY_PENALTY_TEXT`
- `SLACK_SIGNATURE_VERIFICATION_DISABLED`

## Slack 동작

- 채널 메시지 중 `<@BOT_USER_ID>` 멘션이 포함된 메시지만 처리합니다.
- DM, thread reply, bot message, `message_changed`, `message_deleted`는 무시합니다.
- `<@BOT_USER_ID> 닉네임 설정 홍길동`: Slack userId 기준 내부 사용자 등록 또는 displayName 변경을 처리합니다.
- `<@BOT_USER_ID> 인증 + 이미지`: 등록 유저만 저장하고, 성공 시 스레드 피드백 + 채널 현황 업데이트를 전송합니다.
- `GET /api/check-ins`는 최근 인증/제출 타임라인을 최신순으로 반환합니다.
- `<@BOT_USER_ID> 변경 + 이미지`: 오늘 인증 이미지를 교체 요청합니다.
- `<@BOT_USER_ID> 목표확인`: 현재 목표/패널티와 내 진행도를 스레드로 반환합니다.
- `<@BOT_USER_ID> 현황`: 이번 주 전체 현황을 스레드로 반환합니다.
- `<@BOT_USER_ID>`: 사용 방법 안내를 스레드로 반환합니다.
- 관리자 DM에서만 설정 변경 명령을 허용합니다.
  - `목표 설정 주 N회`: 현재 ACTIVE Goal.targetCount를 직접 변경합니다.
  - `패널티 설정 N원`: `GroupSetting.weeklyPenaltyText`를 저장합니다.
  - `설정 확인`: 현재 목표와 패널티를 확인합니다.
- Slack 이미지는 `SLACK_BOT_TOKEN`으로 다운로드한 뒤 Vercel Blob에 업로드하고, DB에는 `blobUrl`에 저장합니다.
- Slack 원본 파일 URL은 `slackOriginalUrl`에 보관합니다. Blob 업로드가 실패하면 `blobUrl`은 `null`로 남고 원본 URL만 유지합니다.
- 기존 `originalUrl`, `originalPhotoUrl`, `imageUrl`은 호환용 legacy 필드입니다.
- 동일 `goalId + userId + recordDate` 중복: SlackChangeCandidate를 upsert합니다.

### 업로드 실패 fallback

- Slack 파일 다운로드나 Blob 업로드가 실패하면 로그를 남기고 Slack 원본 URL로 fallback 저장합니다.
- 이 경우 `SubmissionAsset.blobUrl`은 `null`일 수 있고, `SubmissionAsset.originalUrl`과 `slackOriginalUrl`만 유지됩니다.
- 장애 추적은 `slack.asset_upload_fallback`, `slack.asset_upload_success`, `slack.image_selection_ignored`, `slack.checkin_duplicate` 로그를 먼저 확인합니다.
- 이벤트 ACK는 signature 검증과 최소 파싱 후 즉시 응답하고, 실제 체크인은 백그라운드 처리 로그로 추적합니다.

### 이미지 정책

- `#인증` 메시지에 이미지가 1장 있으면 정상 저장합니다.
- 이미지가 여러 장이면 첫 번째 지원 이미지 1장만 사용하고 나머지는 무시합니다.
- 이미지가 없거나 지원하지 않는 형식이면 저장하지 않고 안내 메시지만 보냅니다.
- 허용 MIME 타입은 `image/jpeg`, `image/jpg`, `image/png`, `image/webp`입니다.

### 검증 시나리오

- `<@BOT_USER_ID> 닉네임 설정 홍길동`: 등록 생성 또는 displayName 변경 후 1회 스레드 안내
- `<@BOT_USER_ID> 목표확인`: 목표/패널티 + 개인 진행도 1회 스레드 안내
- `<@BOT_USER_ID> 인증` + 이미지: 등록 유저는 저장 후 스레드 피드백 + 채널 현황 업데이트
- 같은 날 `<@BOT_USER_ID> 인증` + 다른 이미지: duplicate 스레드 피드백, 채널 업데이트 없음
- `<@BOT_USER_ID> 변경` + 이미지: 변경 요청 스레드 안내
- `<@BOT_USER_ID> 현황`: 전체 현황 스레드 안내
- 멘션 없이 인증/사진만: 무시
- retry 이벤트: `SlackEventReceipt`의 `DONE` 상태는 duplicate skip, `PROCESSING`은 stale 기준으로만 재처리
- bot message / thread reply / message_changed / message_deleted: 무시
- Blob 업로드 실패: Slack URL fallback 저장 및 `slack.asset_upload_fallback` 로그 확인

### 운영 점검 포인트

- Slack event URL이 `/api/slack/events`로 연결됐는지 확인합니다.
- `SLACK_SIGNING_SECRET`, `SLACK_BOT_TOKEN`, `BLOB_READ_WRITE_TOKEN` 누락 여부를 먼저 확인합니다.
- Slack 사용자 이름은 `users.info`로 자동 조회하지 않고, `<@BOT_USER_ID> 닉네임 설정 이름` 입력으로만 관리합니다.
- Slack 이벤트는 `SLACK_BOT_USER_ID` 멘션이 있어야만 처리합니다.
- 이상 시 `requestId` / `eventId` 기준으로 `slack.*` JSON 로그를 따라가면 됩니다.
- Blob 업로드 실패가 반복되면 Slack 토큰 권한과 Vercel Blob 토큰을 우선 점검합니다.
- weekly report는 `WeeklyReportRun` 테이블의 `runKey`로 중복 실행을 막고, 30분 이상 오래된 RUNNING 상태만 재시도합니다.
- Slack Events는 `SlackEventReceipt`의 `PROCESSING / DONE / FAILED` 상태와 2분 stale 기준으로 중복과 재처리를 다룹니다.
- `SubmissionAsset`의 `assetStatus`는 `PENDING`이면 이미지 처리중, `ASSET_SAVED`면 이미지 표시, `ASSET_FAILED`면 실패 placeholder로 해석합니다.
- 설정 관련 변경이 있으면 `npm run prisma:generate`와 `npx prisma migrate deploy`가 먼저 통과해야 배포 완료로 봅니다.

### Slack 연동 URL

- Event Subscriptions URL: `https://<vercel-domain>/api/slack/events`
- Slash Command URL: `https://<vercel-domain>/api/slack/commands/status`

### 진행도 표시

- `formatProgressBar(count, targetCount)`는 `◻︎`와 `◼︎`로 진행도를 표시합니다.
- 예: `0/3 -> ◻︎◻︎◻︎`, `1/3 -> ◼︎◻︎◻︎`, `2/3 -> ◼︎◼︎◻︎`, `3/3 -> ◼︎◼︎◼︎ 달성!`
- 스레드와 채널 현황은 `◼︎◼︎◻︎ 2/3` 같은 형태로 표시됩니다.

### 채널 vs 스레드

- 개인 피드백은 스레드로 보냅니다.
- 인증 성공 시에만 채널에 전체 현황 메시지를 추가로 보냅니다.
- `<@BOT_USER_ID> 현황`, `<@BOT_USER_ID> 목표확인`, `<@BOT_USER_ID>`, `<@BOT_USER_ID> 닉네임 설정`은 스레드 응답만 사용합니다.

### 배포 후 확인 절차

1. `/api/health`가 `ok: true`를 반환하는지 확인합니다.
2. Slack Event Subscription과 Slash Command URL을 등록합니다.
3. `#인증` + 이미지 1장으로 accepted 경로를 확인합니다.
4. `#인증` + 이미지 여러 장으로 첫 번째 지원 이미지만 저장되는지 확인합니다.
5. `#인증` 텍스트만 입력했을 때 저장 없이 안내 메시지만 오는지 확인합니다.
6. 중복 인증 시 `SlackChangeCandidate` upsert와 duplicate 응답이 유지되는지 확인합니다.
7. 배포 전에 `npm run verify:slack-payload`, `npm run verify:production-readiness`, `npm run build`를 통과하고, 가능하면 `npm run verify:predeploy`로 묶어서 확인합니다.
8. `prisma/schema.prisma` 또는 `prisma/migrations`를 수정한 작업은 운영 DB에서 `npx prisma migrate deploy`가 성공하기 전에는 완료로 보고하지 않습니다.
9. `verify:production-readiness`가 PASS 하기 전에는 배포 완료로 보지 않습니다.
10. seed는 명시 요청이 없는 한 운영 DB에서 실행하지 않습니다.
11. stale `SlackEventJob` 수동 복구는 `npm run retry:slack-job -- --event-id <EVENT_ID>`를 사용합니다.
12. Vercel Hobby에서는 Slack reaper를 Vercel Cron에 두지 말고 외부 cron으로 1분마다 호출합니다.

## TODO / 리스크

- 서버리스 안전성을 위해 기존 in-memory pending text/file merge는 제거했습니다. Slack 메시지 하나에 `#인증`과 이미지를 함께 올리는 흐름이 MVP 기본 경로입니다.
- 대시보드는 서버 컴포넌트에서 DB를 직접 조회합니다. 공개 접근 제어가 필요하면 인증을 추가해야 합니다.
- seed는 운영용 integration upsert만 수행하며 기존 데이터는 삭제하지 않습니다.
