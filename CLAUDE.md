# CLAUDE.md — eavesdropper (회의 요약 봇)

> 사내 Discord 음성 회의 자동 녹음·전사·요약 봇.
> AI 어시스턴트(Claude 등)가 이 프로젝트에서 작업할 때 먼저 읽어야 하는 지침입니다.

---

## 📖 프로젝트 개요

- `/join` → 호출자 음성 채널 입장 → 화자별 PCM 캡처 → `/leave` → ffmpeg 후처리 → Whisper STT → OpenAI 요약 → `#회의록` 채널에 쓰레드 + transcript .txt + 30분 분할 MP3 게시
- 단일 회의만 대응 (두 번째 `/join` 거절)
- 시간대: UTC (transcript 메타데이터)
- 사내 운영 — Pi5 또는 별도 서버에서 PM2로 상시 실행

---

## 📂 작업 시작 전 필독

- [`.a_plan/20260519회의요약봇/SPEC.md`](.a_plan/20260519회의요약봇/SPEC.md) — 모든 결정의 출처 (인터뷰 결정 트레일 + ADR 1~5)
- [`.a_plan/20260519회의요약봇/plan.md`](.a_plan/20260519회의요약봇/plan.md) — 구현 계획
- [`.a_plan/20260519회의요약봇/checkpoints/`](.a_plan/20260519회의요약봇/checkpoints/) — 8개 체크포인트

---

## ⚠️ 절대 규칙

1. **ESM 사용** — `package.json`에 `"type": "module"`. CommonJS는 `ecosystem.config.cjs` 하나만 예외.
2. **봇은 절대 죽으면 안 됨** — `process.on('unhandledRejection')` + `uncaughtException` 핸들러 필수 (`src/bot.js`).
3. **슬래시 명령은 즉시 `deferReply()` 호출** (Discord 3초 룰).
4. **토큰·API 키·PII 로깅 금지**. Discord 메시지에도 마스킹.
5. **환경 변수 추가/변경 시 4곳 동기화 필수** — `.env.example`, `scripts/cli.js`의 `ENV_SECTIONS`, `SPEC.md` §5, 운영 `.env`. 누락 시 즉시 추가할 것.
6. **ORM 안 씀** — `pg` 직접 쿼리. `src/db.js`의 `query`/`getClient`.
7. **ffmpeg는 시스템 패키지로만 의존** — npm으로 받지 않음.
8. **단일 회의 정책** — `Map<guildId, MeetingSession>` 전역 한 슬롯. 두 번째 `/join` 거절.
9. **threads-make와 완전 분리** — API 키·PG 인스턴스·봇 토큰·git 모두 별도 (ADR-5). 코드 패턴만 글자 단위로 복사하지 `import` 의존성 없음.

---

## 🏗️ 아키텍처

`/leave` 후처리는 `src/finalize.js`의 `finalizeMeeting(client, session, triggeredBy)` 단일 함수가 orchestrate:

```
recorder.stopRecording
  → audio-pipeline.buildSpeakerMp3 × N(화자 수)
  → stt-whisper.transcribeSpeakerMp3 × N
  → transcript-builder.mergeAcrossSpeakers + formatTranscript
  → audio-pipeline.buildMixedMp3Parts (30분 분할)
  → summarizer.summarizeTranscript (OpenAI gpt-4o-mini json_schema strict)
  → publisher.publishMeeting (쓰레드 + 첨부 + DB)
```

`bot.js`는 슬래시 명령 핸들러만. orchestration은 모두 `finalize.js`에 위임 (단일 책임).

### status 전이

`meetings.status`: `recording` → `transcribing` → `summarizing` → `completed` (또는 `failed`)

부팅 시 1시간 이상 in-progress인 row는 자동 `failed`로 정리 (`src/bot.js` ready 핸들러).

---

## 🛠️ 기술 스택

- Node.js 22+, ESM
- `discord.js` v14 + `@discordjs/voice` + `@discordjs/opus`
- `prism-media` (Opus → PCM)
- `ffmpeg` (시스템 패키지, concat / amix / segment / MP3 인코딩)
- `openai` SDK (Whisper API + Chat Completions `json_schema strict`)
- `pg` (PostgreSQL 18)
- `@clack/prompts` (CLI)
- PM2 (`ecosystem.config.cjs`, 앱 이름 `notesbot`)

---

## 🔑 환경 변수

```
DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
DISCORD_TRANSCRIPT_CHANNEL_ID, DISCORD_ALERTS_CHANNEL_ID
OPENAI_API_KEY (Whisper + gpt-4o-mini 공유)
WHISPER_MODEL, WHISPER_LANGUAGE, SUMMARY_MODEL
DATABASE_URL (threads-make와 별도 인스턴스)
AUTO_LEAVE_EMPTY_SECONDS, MP3_PART_DURATION_MINUTES, MP3_BITRATE_KBPS, END_BEHAVIOR_SILENCE_MS
LOG_LEVEL, TZ_DISPLAY
```

---

## 🚀 자주 쓰는 명령어

**원칙**: 운영 작업(env 편집·DB·Discord 명령 등록·PM2·업데이트·테스트)은 **모두 `npm run cli` 메뉴**를 통해서 수행한다. raw `pm2 ...` / `git pull` / `psql` 명령을 셸에서 직접 치지 말 것 — CLI가 단일 진입점.

```bash
# 단 하나의 운영 진입점
npm run cli
# → 🚀 초기 셋업 / ⚙️  환경 변수 편집 / 🔧 프롬프트 편집 / 🗄️  DB
# → 🤖 Discord 명령 재등록 / 📦 업데이트 적용 / 🎛️  PM2 운영 / 🧪 테스트

# 최초 1회만 셸에서 (CLI 진입 전)
npm install

# 개발 모드 (직접 셸에서)
npm run dev                          # nodemon
npm run test:record                  # 로컬 audio-pipeline + transcript-builder 시뮬레이션
```

> PM2를 직접 다루어야 하는 경우(예: 다른 앱 통합 점검)에도 본 프로젝트의 `notesbot` 프로세스에 대한 start/restart/stop/delete/logs/status/save·startup은 반드시 `npm run cli → 🎛️ PM2 운영`을 통해서 수행. raw `pm2 ...` 명령은 다른 프로젝트의 프로세스에 한해 사용.

---

## 📁 파일 구조

```
src/
├── bot.js              슬래시 명령 + 세션 + voiceStateUpdate (orchestration은 finalize.js에 위임)
├── finalize.js         /leave 후처리 orchestrator (단일 책임)
├── recorder.js         @discordjs/voice receive + prism-media decode
├── audio-pipeline.js   ffmpeg spawn — concat/amix/30분 cut/MP3
├── stt-whisper.js      Whisper API (verbose_json + segment timestamps)
├── transcript-builder.js  화자 segments 머지 + NOTESBOT TRANSCRIPT 포맷
├── summarizer.js       OpenAI gpt-4o-mini json_schema strict
├── publisher.js        쓰레드 생성 + 첨부 + DB 저장
├── db.js               pg pool
└── discord-register.js 슬래시 명령 등록

migrations/001_init.sql  meetings + meeting_speakers + meeting_audio_parts
prompts/summary.txt      OpenAI system 프롬프트 (변수 치환 {{TRANSCRIPT}})
scripts/cli.js, install.js, test-record.js
```

---

## 💡 코드 컨벤션

- ESM (`import`/`export`), async/await만
- 파일: `kebab-case` / 함수·변수: `camelCase` / DB: `snake_case` / 상수: `UPPER_SNAKE_CASE`
- 사용자 대면 메시지 한국어
- 슬래시 명령 핸들러는 즉시 `deferReply({ flags: MessageFlags.Ephemeral })`
- 외부 API 호출은 모두 try/catch + fallback
- 토큰/키 로깅 절대 금지

---

## 🐛 자주 만나는 이슈

- **Whisper "file too large"** — 화자 1명 발화가 25MB 초과. 32kbps mono 인코딩 가정 시 1h ≈ 14MB라 보통 안전. 초과 시 `audio-pipeline.js`에서 비트레이트 감축 또는 분할.
- **OpenAI 요약 응답 파싱 실패** — `json_schema strict`로 스키마 위반은 거의 0. 네트워크/타임아웃 시 `summarizer.js` fallback 발동 → `thread_title=null`이라 publisher가 `[MM-DD HH:MM] 회의록 — <호출자>` 형식 사용.
- **voice receive 끊김** — `@discordjs/voice`의 비공식 기능. 봇 부팅 시 stale tmp + stuck row 자동 청소 → 죽었다 살아도 안전.
- **ffmpeg 필터 호환성** — Pi5 표준 빌드 OK. 다른 환경은 `amix`/`adelay`/`apad` 동작 확인.
- **`@discordjs/opus` native 빌드 실패** — `python3`, `make`, `g++` 필요. 실패 시 `prism-media` 단독으로 fallback 가능 (현재는 둘 다 의존).
- **PM2 ecosystem.config 오류** — `package.json`에 `"type":"module"` 있으므로 반드시 `.cjs` 확장자.

---

## 📋 프로젝트 정보

- **시작일**: 2026-05-19
- **언어**: Node.js (ES2022+)
- **DB**: PostgreSQL (threads-make와 별도 인스턴스)
- **운영 환경**: PM2 (Pi5 또는 별도 서버)
- **작성자**: OnePaperHoon
