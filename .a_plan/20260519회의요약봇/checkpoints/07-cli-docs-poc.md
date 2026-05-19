# 07 — CLI + 문서 + PoC 통합

> SPEC §6 / threads-make `scripts/cli.js` 패턴 차용

## 목표

`@clack/prompts` 기반 통합 CLI(`npm run cli`)로 env·DB·Discord·PM2·업데이트·테스트를 한 곳에서 관리하게 하고, `CLAUDE.md` 문서를 작성한 뒤 PM2에 등록하여 실 환경 1분 회의 PoC를 end-to-end로 통과시킨다.

## 작업

### 1. `scripts/cli.js`

threads-make `scripts/cli.js` 골격 복사 후 다음으로 교체.

> **줄 수 임계 가이드**: 구현 후 실측. **800줄을 초과하면 즉시** 본 `.a_plan/20260519회의요약봇/` 아래에 `99-refactor.md`를 작성하여 분리 계획을 별도 태스크로 분리 (예: `scripts/cli/menu-env.js`, `scripts/cli/menu-pm2.js`, `scripts/cli/menu-db.js`, `scripts/cli/menu-update.js`). 기능 구현(PoC 통과)을 먼저 완료한 뒤 리팩토링. 800줄 미만이면 단일 파일 유지.

#### ENV_SECTIONS (SPEC §5 그대로)

```js
const ENV_SECTIONS = [
  {
    label: 'Discord',
    vars: [
      { key: 'DISCORD_BOT_TOKEN',            label: '봇 토큰',                       secret: true  },
      { key: 'DISCORD_CLIENT_ID',            label: '클라이언트 ID',                  secret: false },
      { key: 'DISCORD_GUILD_ID',             label: '서버 ID',                       secret: false },
      { key: 'DISCORD_TRANSCRIPT_CHANNEL_ID', label: '#회의록 채널 ID',              secret: false },
      { key: 'DISCORD_ALERTS_CHANNEL_ID',     label: '#alerts 채널 ID',              secret: false },
    ],
  },
  {
    label: 'OpenAI (STT + 요약 단일 vendor — ADR-5)',
    vars: [
      { key: 'OPENAI_API_KEY',     label: 'OpenAI API 키 (Whisper + gpt-4o-mini 공유)', secret: true  },
      { key: 'WHISPER_MODEL',      label: 'Whisper 모델 (기본 whisper-1)',          secret: false },
      { key: 'WHISPER_LANGUAGE',   label: '언어 힌트 (기본 ko)',                    secret: false },
      { key: 'SUMMARY_MODEL',      label: '요약 모델 (기본 gpt-4o-mini)',           secret: false },
    ],
  },
  {
    label: 'PostgreSQL',
    vars: [
      { key: 'DATABASE_URL',       label: 'postgres://user:pw@host:5432/eavesdropper', secret: true },
    ],
  },
  {
    label: '녹음 정책',
    vars: [
      { key: 'AUTO_LEAVE_EMPTY_SECONDS',  label: '봇 단독 채널 자동 leave 대기 (초, 기본 30)', secret: false },
      { key: 'MP3_PART_DURATION_MINUTES', label: 'MP3 파트 분할 간격 (분, 기본 30)',         secret: false },
      { key: 'MP3_BITRATE_KBPS',          label: 'MP3 비트레이트 (kbps, 기본 32)',           secret: false },
      { key: 'END_BEHAVIOR_SILENCE_MS',   label: '발화 cut 침묵 임계 (ms, 기본 1000)',       secret: false },
    ],
  },
  {
    label: '로그',
    vars: [
      { key: 'LOG_LEVEL',   label: '로그 레벨 (info/debug/warn/error)', secret: false },
      { key: 'TZ_DISPLAY',  label: 'transcript 메타 표시 타임존 (기본 UTC)', secret: false },
    ],
  },
];
```

#### 메뉴 항목

1. **🚀 초기 셋업** → `scripts/install.js`
2. **⚙️ 환경 변수 편집** → 섹션 선택 후 var 선택 후 값 입력
3. **🔧 프롬프트 편집** → `prompts/summary.txt` nano 열기
4. **🗄️ DB**
   - 마이그레이션 실행 (`npm run db:migrate`)
   - reset (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` 확인 후)
   - stuck 회의 청소 — 1시간+ status='recording'|'transcribing'|'summarizing' 인 row를 `failed`로 (부팅 시에도 자동)
5. **🤖 Discord 명령 재등록** → `npm run discord:register-commands`
6. **📦 업데이트 적용** → `git pull` + `npm install` + `db:migrate` + `discord:register-commands` + `pm2 restart eavesdropper`
7. **🎛️ PM2 운영**
   - start (`pm2 start ecosystem.config.cjs`)
   - restart / stop / delete (`pm2 [cmd] eavesdropper`)
   - logs (`pm2 logs eavesdropper`)
   - save & startup (raspberry pi 부팅 자동시작)
8. **🧪 테스트** → `npm run test:record`
9. **🚪 종료**

### 2. `scripts/install.js`

- `.env` 존재 확인 → 없으면 `.env.example` 복사 후 시작
- ENV_SECTIONS 순회하며 빈 값 항목만 인터랙티브 입력
- 입력 완료 후:
  - `npm run db:migrate`
  - `npm run discord:register-commands`
- 결과 요약 + 다음 단계 안내 (`npm run cli` → 🎛️ PM2 운영 → start)

### 3. `scripts/test-record.js` — 로컬 PoC

```js
// 04 audio-pipeline 단위 테스트:
// - dummy stereo 48kHz PCM 생성 (anullsrc + ffmpeg)
// - buildSpeakerMp3 호출 → mp3 확인
// - 더미 mp3 → transcribeSpeakerMp3 (실제 OpenAI 호출 옵션 plain --offline 시 mocking)
// - mergeAcrossSpeakers + formatTranscript
// - 결과를 tmp/test_output/ 에 출력
//
// 사용자가 단위별 동작 확인 가능
```

CLI에서 호출 시 단계별 진행 로그 + 마지막 결과 파일 경로 출력.

### 4. `CLAUDE.md` 작성

threads-make `CLAUDE.md` 스타일 차용. 골자:

```markdown
# CLAUDE.md — eavesdropper (회의 요약 봇)

## 프로젝트 개요
사내 Discord 음성 회의 자동 녹음·전사·요약 봇.

## 작업 시작 전 필독
- [.a_plan/20260519회의요약봇/SPEC.md](.a_plan/20260519회의요약봇/SPEC.md) — 모든 결정의 출처
- [.a_plan/20260519회의요약봇/plan.md](.a_plan/20260519회의요약봇/plan.md) — 구현 계획

## 절대 규칙 (threads-make 규칙 차용)
1. ESM 사용 (`type: "module"`)
2. 봇은 절대 죽으면 안 됨 — `unhandledRejection` 핸들러 필수
3. 모든 슬래시 명령은 즉시 `deferReply()` (3초 룰)
4. 토큰·API 키·PII 로깅 금지, Discord 메시지에도 마스킹
5. 환경변수 추가/변경 시 4곳 동기화 필수 — `.env.example`, `scripts/cli.js`의 `ENV_SECTIONS`, `SPEC.md` §5, 운영 `.env`
6. Sequelize 같은 ORM 안 씀 — pg 직접 쿼리
7. ffmpeg는 시스템 패키지로만 의존 (npm로 받지 않음)
8. 동시 회의 1개만 — 두 번째 /join은 거절 (단일 세션 정책)

## 아키텍처
(SPEC §1, §3 요약)

## 명령어
`npm run cli` 메뉴를 통해 모든 운영 작업.

## 파일 구조
(SPEC §4 그대로)

## 자주 만나는 이슈
- Whisper "file too large" → audio-pipeline의 비트레이트 자동 감축
- OpenAI 요약 응답 파싱 실패 (네트워크 등) → fallback 동작 확인, prompts/summary.txt 점검 (`json_schema strict`로 스키마 위반은 사실상 발생 안 함)
- voice receive 끊김 → @discordjs/voice 버전 확인, Discord API 변경 모니터
- ffmpeg 필터 호환성 → Pi5는 표준 빌드 OK, 다른 환경은 amix/adelay 동작 확인
```

### 5. stuck row 자동 청소 (bot.js 부팅 시)

```js
// bot.js 부팅부 (db.js import 후)
client.once('ready', async () => {
  console.log(`✅ ${client.user.tag} 준비 완료`);

  // stuck 정리
  const result = await query(
    `UPDATE meetings
     SET status='failed', error_message='bot restarted while in progress'
     WHERE status IN ('recording','transcribing','summarizing')
       AND started_at < NOW() - INTERVAL '1 hour'
     RETURNING id`,
  );
  if (result.rowCount > 0) {
    console.log(`🧹 stuck 회의 ${result.rowCount}건 → failed`);
  }
});
```

### 6. PoC end-to-end 시나리오

1. 사내 Discord 서버 + 테스트 음성 채널 준비
2. `npm run cli` → 🎛️ PM2 운영 → start → 봇 online (raw `pm2 ...` 셸 명령 직접 사용 금지)
3. 사용자 A + 사용자 B (또는 휴대폰으로 시뮬레이션) 둘 다 voice 입장
4. A가 `/join` 호출 → 봇 입장 + 음성 채널 텍스트에 공지 Embed 확인
5. A, B 1분간 대화 ("안녕하세요 회의 시작합니다", "오늘 안건은 ..." 등)
6. A가 `/leave` 호출
7. "처리 중" 메시지 표시 → 1~3분 대기
8. `#회의록` 채널에 starter message + 쓰레드 생성 확인
9. 쓰레드 이름이 `[05-19] <주제>` 형태인지 확인
10. transcript .txt 다운받아 SPEC §2.8 포맷대로 출력 확인
11. part_1.mp3 다운받아 두 화자 음성 mix되어 들리는지 확인
12. DB query: `SELECT id, status, thread_title FROM meetings;` → completed row 확인
13. tmp/ 비어있는지 확인
14. 두 번째 `/join` 호출 시 거절 메시지 확인

## 검수 기준

- [ ] `npm run cli` 모든 메뉴 진입 무에러
- [ ] CLI에서 env 항목 편집 후 `.env` 파일 실제 변경 확인
- [ ] `scripts/install.js`로 .env 없는 상태 → 인터랙티브 채움 → migrate + register 자동 실행
- [ ] PM2 메뉴에서 start/restart/stop/logs 모두 동작
- [ ] `npm run cli` → 🎛️ PM2 운영 → logs 로 확인 시 에러 없음
- [ ] PoC 시나리오 14단계 모두 통과
- [ ] `CLAUDE.md` 존재 + 미래 AI 어시스턴트가 읽고 일관성 있게 작업 가능한 수준
- [ ] stuck 회의 자동 청소 동작 (강제로 status='recording' row를 1시간 전 started_at으로 만들고 봇 재시작 → failed로 변경 확인)

## 마무리 산출물

- 작동하는 회의 요약 봇 v1
- 운영 매뉴얼 역할의 CLI
- AI 어시스턴트 컨텍스트 문서 (CLAUDE.md)
- 실 환경 검증 (1분 회의 PoC 통과)

## 다음 단계 (이 SPEC 범위 외, 별도 태스크 제안)

- [ ] 1시간 실 회의 부하 테스트 (메모리·디스크·비용 실측)
- [ ] `/summarize <thread_id>` 재요약 명령
- [ ] 발화 단위 row 분해 마이그레이션 (검색 요구 명확해질 때)
- [ ] shopinx workspace `CLAUDE.md`에 eavesdropper 섹션 추가
- [ ] Pi5 자동 배포 스크립트
