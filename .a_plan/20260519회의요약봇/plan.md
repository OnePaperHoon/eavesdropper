# 회의 요약 봇 (NotesBot) — 구현 계획서

> SPEC 참조: [`SPEC.md`](./SPEC.md)
> 작성일: 2026-05-19
> 작업 디렉토리: `C:\Users\wkdgn\Desktop\shopinx\eavesdropper\`

---

## 1. 구현 목표

사내 Discord 음성 회의를 자동 녹음·전사·요약하여 지정 텍스트 채널에 쓰레드(`[MM-DD] <AI 추출 주제>` 형식) + transcript .txt + 30분 단위 MP3 첨부로 게시하는 봇 v1을 구축한다.

성공 정의:
- 1시간 이내 한국어 음성 회의 1건을 처음부터 끝까지 처리 가능
- `/join` → 화자별 음성 캡처 → `/leave` → ffmpeg 후처리 → Whisper STT → OpenAI `gpt-4o-mini` 요약 → 쓰레드 게시까지 무인 자동
- PM2로 상시 운영, `@clack/prompts` CLI로 env·PM2·업데이트·DB 모두 관리
- 두 번째 `/join`은 거절 (단일 회의)
- 봇만 남는 음성 채널은 30초 후 자동 leave

---

## 2. As-Is vs To-Be

### As-Is (현재 상태)

```
eavesdropper/
├── .git/                   (원격 클론, github.com:shopinx/eavesdropper)
├── .a_plan/                (이번 계획 산출물)
└── README.md               (14 bytes — placeholder)
```

- 코드 없음. 의존성 없음. DB 없음. 봇 등록 없음.
- 시스템에 ffmpeg 미설치 가능성 (확인 필요)
- shopinx workspace 내 다른 프로젝트(`threads-make/`, `server/`)와 코드 의존성 없음

### To-Be (목표 상태)

```
eavesdropper/
├── .env / .env.example
├── package.json (ESM, Node 22+)
├── ecosystem.config.cjs (PM2 단일 앱 'notesbot')
├── CLAUDE.md
├── prompts/summary.txt
├── src/
│   ├── bot.js              슬래시 명령 + 세션 상태 (orchestration은 finalize.js에 위임)
│   ├── finalize.js         /leave·auto-leave 후처리 orchestrator (단일 책임)
│   ├── recorder.js         @discordjs/voice receive + prism-media decode
│   ├── audio-pipeline.js   ffmpeg concat / amix / 30분 cut / MP3
│   ├── stt-whisper.js      Whisper verbose_json
│   ├── transcript-builder.js  화자 segments 머지 + 포맷
│   ├── summarizer.js       OpenAI json_schema strict
│   ├── publisher.js        쓰레드 생성 + 첨부 + DB 저장
│   ├── db.js               pg pool (threads-make 차용)
│   └── discord-register.js
├── migrations/
│   ├── migrate.js          (threads-make 차용)
│   └── 001_init.sql        meetings + meeting_speakers + meeting_audio_parts
├── scripts/
│   ├── cli.js              @clack/prompts 통합 CLI
│   ├── install.js          대화형 초기 셋업
│   └── test-record.js      로컬 PoC
├── tmp/                    (PCM/MP3 임시 작업 공간, .gitignore)
└── logs/                   (PM2 로그)
```

- PM2 `notesbot` 상시 실행
- 새 PostgreSQL DB `eavesdropper` (threads-make와 별개)
- Discord Developer Portal에 신규 봇 등록 + 토큰 발급

---

## 3. 영향 범위 (Impact Scope)

### 3.1 신규 생성 파일

| 파일 | 담당 체크포인트 |
|---|---|
| `package.json`, `.gitignore`, `.env.example`, `ecosystem.config.cjs` | [00-bootstrap](./checkpoints/00-bootstrap.md) |
| `src/db.js`, `migrations/migrate.js`, `migrations/001_init.sql` | [01-db-foundation](./checkpoints/01-db-foundation.md) |
| `src/bot.js`, `src/discord-register.js` | [02-bot-core](./checkpoints/02-bot-core.md) |
| `src/recorder.js` | [03-voice-recording](./checkpoints/03-voice-recording.md) |
| `src/audio-pipeline.js` | [04-audio-pipeline](./checkpoints/04-audio-pipeline.md) |
| `src/stt-whisper.js`, `src/transcript-builder.js` | [05-stt-transcript](./checkpoints/05-stt-transcript.md) |
| `src/summarizer.js`, `prompts/summary.txt`, `src/publisher.js`, `src/finalize.js` | [06-summary-publish](./checkpoints/06-summary-publish.md) |
| `scripts/cli.js`, `scripts/install.js`, `scripts/test-record.js`, `CLAUDE.md` | [07-cli-docs-poc](./checkpoints/07-cli-docs-poc.md) |

### 3.2 수정 대상 파일

없음. eavesdropper는 빈 클론이므로 전부 신규.

### 3.3 간접 영향 (import / 호출 관계)

> **분리 원칙**: eavesdropper는 threads-make와 **모든 런타임 자원이 분리**됨 — OpenAI 키(Whisper+요약 단일 키), PostgreSQL 인스턴스, Discord 봇 토큰, Node 프로세스, `node_modules`, git 모두 별도. 코드는 패턴만 글자 단위로 복사하지 `import` 의존성 없음.

| 대상 | 영향 |
|---|---|
| `threads-make/` 코드 | **변경 없음**. 패턴만 복사 모방 (직접 import 안 함, 별개 git) |
| `shopinx/server/` | 변경 없음 |
| `shopinx/CLAUDE.md` (workspace) | `eavesdropper/` 섹션 추가 가능하나 본 계획 범위 외 — 별도 태스크 |
| 운영 머신 시스템 패키지 | `ffmpeg` 설치 필요 (00-bootstrap에서 점검) |
| Discord Developer Portal | 신규 application/봇 등록 + intents + permissions + 토큰 (00-bootstrap 사전 작업) |
| **별도 PostgreSQL 인스턴스** | threads-make와 분리된 PG 서버에 database `eavesdropper` + user 생성 (서버 공용 금지) |
| OpenAI 키 | **별도 발급 필수** — threads-make 키 재사용 금지. Whisper(STT) + `gpt-4o-mini`(요약) 단일 키로 처리 (ADR-5) |

---

## 4. 상세 해결 방안

### 4.1 핵심 흐름

`/join` 핸들러는 세션 상태(`Map<guildId, MeetingSession>`)에 진입 후 `recorder.js`에 voice channel을 위임한다. recorder는 `@discordjs/voice` receiver로 화자별 Opus 스트림을 받아 `prism-media` 디코더로 16kHz mono PCM 변환 후 `tmp/<meeting_id>/speaker_<userId>.pcm`에 append하며, 각 발화의 `(startMs, durationMs)` 메타를 메모리 segments 배열에 누적한다.

`/leave` 또는 자동 leave 트리거 시 **`finalize.js`의 `finalizeMeeting(session, triggeredBy)`** 단일 함수가 후처리 전체를 orchestrate한다 — `recorder.stopRecording` → `audio-pipeline.buildSpeakerMp3` × N(화자 수) → `stt-whisper.transcribeSpeakerMp3` × N → `transcript-builder.mergeAcrossSpeakers` + `formatTranscript` → `audio-pipeline.buildMixedMp3Parts` → `summarizer.summarizeTranscript` → `publisher.publishMeeting` 순서로 호출한다. 각 단계마다 `meetings.status` 전이(`transcribing` → `summarizing` → `completed` 또는 `failed`)를 책임진다. bot.js는 슬래시 명령 핸들러만 보유하고 orchestration은 모두 finalize.js에 위임 — **단일 책임 원칙**.

`summarizer.js`가 transcript를 OpenAI에 보내 `json_schema strict` 응답을 받고 `thread_title`을 추출, `publisher.js`가 `[MM-DD] <thread_title>` 쓰레드를 생성하여 요약 Embed + transcript.txt + part_N.mp3 순차 첨부 후 DB에 영구 저장한다.

### 4.2 트리키한 부분과 대응

| 이슈 | 대응 |
|---|---|
| 화자별 PCM은 발화 구간만 들어와 시간축이 비연속 | recorder가 (startMs, durationMs) segments 메타를 별도 누적 → audio-pipeline에서 무음 padding 삽입 |
| Discord voice receive는 비공식 API, 끊김 가능 | `voiceConnection.on('stateChange')` 모니터링, Disconnected→1회 재연결 시도, 실패 시 현재까지 수집분으로 강제 종료 |
| 큰 회의(1시간+)에서 Whisper 25MB 한도 | 32kbps mono MP3는 1h ≈ 14MB로 안전. 그래도 단일 화자 발화가 30MB 넘으면 audio-pipeline이 분할 호출 |
| 요약 응답 파싱 실패 (네트워크 등) | summarizer는 fallback 객체 + alerts 채널 경고. publisher는 fallback 쓰레드 이름 사용. `json_schema strict`로 스키마 위반은 거의 발생 안 함 |
| Discord 첨부 한도 25MB (무료 서버) | 32kbps + 30분 분할로 part당 ~7MB. 한도 초과 시 비트레이트 자동 16kbps로 감소 (fallback) |
| 봇이 처리 중에 죽음 | `tmp/<meeting_id>/` 파일은 부팅 시 청소(7일 이전), DB `meetings.status='recording'`은 7일 이상이면 자동 'failed' 처리 (08-cli의 헬퍼) |

### 4.3 SPEC 결정 매핑

체크포인트별 SPEC §매핑:

- 00-bootstrap → SPEC §3, §5
- 01-db-foundation → SPEC §2.10
- 02-bot-core → SPEC §1, §2.3, §2.4, §2.9, §7
- 03-voice-recording → SPEC §1, §2.2, §2.5, §3, ADR-2
- 04-audio-pipeline → SPEC §2.6, ADR-4
- 05-stt-transcript → SPEC §2.1, §2.8, ADR-1
- 06-summary-publish → SPEC §2.3, §2.7, §2.10, §9
- 07-cli-docs-poc → SPEC §6

---

## 5. 단계별 실행 계획

각 체크포인트는 단위 검수 가능한 1개 작업. 순서 의존성 있음 (00 → 01 → 02 → 03 → 04 → 05 → 06 → 07).

| # | 체크포인트 | 단위 검수 기준 |
|---|---|---|
| 00 | [프로젝트 부트스트랩](./checkpoints/00-bootstrap.md) | `npm install` 무에러, PG 연결 성공, ffmpeg `-version` OK |
| 01 | [DB 토대](./checkpoints/01-db-foundation.md) | `npm run db:migrate` 후 `meetings` / `meeting_speakers` / `meeting_audio_parts` 3테이블 존재 |
| 02 | [봇 코어 (명령 + 가드)](./checkpoints/02-bot-core.md) | 실 디스코드에서 `/join` 호출 시 봇이 음성채널 입장 + 공지 Embed, `/leave` 시 빠짐 (STT 없이) |
| 03 | [음성 캡처](./checkpoints/03-voice-recording.md) | 1분 발화 후 `tmp/<meeting>/speaker_<userId>.pcm` 파일 + segments 메타 누적 확인 |
| 04 | [오디오 파이프라인](./checkpoints/04-audio-pipeline.md) | PCM 입력 → 단일 mix MP3 + 30분 분할 MP3 둘 다 생성 |
| 05 | [STT + Transcript](./checkpoints/05-stt-transcript.md) | 더미 MP3 → Whisper segments → 포맷된 transcript .txt |
| 06 | [요약 + 게시](./checkpoints/06-summary-publish.md) | 시뮬레이션 transcript → OpenAI json_schema strict 응답 → 실 쓰레드 생성 + 첨부 + DB row |
| 07 | [CLI + 문서 + PoC](./checkpoints/07-cli-docs-poc.md) | `npm run cli` 메뉴 8개 동작, PM2 등록, 실 환경 1분 회의 end-to-end 성공 |

---

## 6. 명시적 비-목표 (이번 계획 범위 외)

- 동시 N개 회의 대응 (메인+워커 봇)
- 회의 검색용 웹 인터페이스
- 발화 단위 row 테이블 (`meeting_utterances`)
- `/summarize` 재요약 명령
- Pi5 SSH 자동 배포 스크립트 (사용자가 수동 git pull + cli "업데이트 적용" 메뉴 활용)
- shopinx workspace CLAUDE.md에 eavesdropper 섹션 추가

---

## 7. 사전 준비 체크리스트 (사용자 책임)

본 계획 실행 전 사용자가 직접 확보해야 하는 사항:

- [ ] Discord Developer Portal에 신규 application 생성 + Bot 추가
  - Privileged Gateway Intents: 모두 OFF 가능 (voice는 별도)
  - OAuth2 Scopes: `bot`, `applications.commands`
  - Bot Permissions: Connect, Speak(불필요하지만 권장), Send Messages, Embed Links, Attach Files, Read Message History, Use Slash Commands, Create Public Threads, Send Messages in Threads
  - 봇 토큰 발급
- [ ] **별도 OpenAI API 키 발급** (threads-make 키 재사용 금지). Whisper + `gpt-4o-mini` 둘 다 한 키로 사용 (ADR-5)
- [ ] **별도 PostgreSQL 인스턴스 준비** (threads-make 서버와 공용 금지)
  - 인스턴스 위치 결정 필요 (예: 같은 머신의 다른 포트 / 별도 머신 / 클라우드 PG) — 본 SPEC 범위 외, 운영자가 결정
  - 새 인스턴스에 database `eavesdropper` + user `eavesdropper_user` + 비밀번호 발급
  - `DATABASE_URL` 환경변수에 해당 호스트/포트/계정 반영
- [ ] 운영 머신에 `ffmpeg` 설치 확인 (`ffmpeg -version`)
- [ ] 운영 머신 Node 버전 22+ 확인
- [ ] 사내 Discord 서버에 `#회의록` 텍스트 채널 + 테스트용 음성 채널 마련
