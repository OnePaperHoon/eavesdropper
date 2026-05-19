# 회의 요약 봇 (NotesBot) — SPEC

> 인터뷰 일자: 2026-05-19
> 1차 ADR 적용: 2026-05-19 (STT 호출 패턴 / VAD / DB 스키마 / 오디오 스택 재결정)
> 작성자: 시니어 아키텍트 인터뷰 + ADR 검증 기반 사용자 합의안
> 대상 디렉토리: `C:\Users\wkdgn\Desktop\shopinx\eavesdropper\`

---

## 0. 한 줄 요약

사내 Discord 음성 회의를 자동으로 녹음·전사(한국어 STT)·구조화 요약하여, 회의가 끝나면 지정된 텍스트 채널에 쓰레드 + MP3 첨부로 게시하는 봇.

---

## 1. 도메인 플로우 (확정)

```
[호출자] 음성 채널 참여 중
     │
     │ /join
     ▼
[봇] 호출자의 음성 채널로 join
     │ (음성 채널 텍스트에 "녹음 시작" Embed 공지)
     │
     ▼
[봇] receiver.speaking.on('start', userId) → receiver.subscribe(userId, {
     │   end: { behavior: EndBehaviorType.AfterSilence,
     │            duration: END_BEHAVIOR_SILENCE_MS }
     │ })
     │ — Discord SSRC가 user.id 매핑을 자동 제공 (오디오 화자 분리 불필요)
     │ — 발화가 끝나면 (침묵 N ms) stream auto-end
     │ — Opus → prism-media OpusDecoder → 16kHz mono PCM
     │ — 화자별로 절대 timestamp 메타와 함께 raw PCM 임시 파일에 append
     │
     │ (음성 채널 인원=0 30초 지속 시 자동 /leave 처리)
     ▼
[누군가] /leave (동일 음성 채널 참여자 누구나) 또는 자동
     │
     ▼
[봇] 후처리 파이프라인 (사후 일괄 — ADR Decision 1 채택)
     │
     │  Step 1: 화자별 PCM 파일들을 ffmpeg로 concat (발화 사이 무음 padding 포함)
     │  Step 2: 화자별 32kbps mono MP3로 압축 (Whisper 25MB 한도 안전)
     │  Step 3: 화자당 Whisper API 1회 호출
     │           - model=whisper-1
     │           - language=ko
     │           - response_format=verbose_json
     │           - timestamp_granularities=["segment"]
     │  Step 4: 화자별 segment timestamp를 회의 시작 기준 절대 elapsed로 변환
     │           → 화자 전체를 시간순 머지하여 단일 transcript 생성
     │  Step 5: mix 트랙 (모든 화자 PCM amix) → 30분 단위로 cut → part_N.mp3
     │
     ▼
[봇] OpenAI gpt-4o-mini로 transcript → 구조화 요약 생성 (json_schema strict)
     │ (요약 JSON에 thread_title 필드 포함 — 50자 이내 한국어 핵심 주제)
     │
     ▼
[봇] DISCORD_TRANSCRIPT_CHANNEL_ID 채널에 쓰레드 생성
     │ — 쓰레드 이름: "[MM-DD] <thread_title>"
     │   (요약/주제 추출 실패 시 fallback: "[MM-DD HH:MM] 회의록 — <호출자>")
     │ — 쓰레드 첫 메시지: 요약 Embed
     │ — transcript .txt 첨부 + part_1.mp3, part_2.mp3, ... 순차 첨부
     │ — PG에 회의 메타 + transcript_text + summary_json 영구 저장
     │
     ▼
[봇] 음성 채널 disconnect + 임시 파일 정리
```

---

## 2. 확정된 결정 사항

### 2.1 STT 엔진 + 호출 패턴 (ADR Decision 1)
- **OpenAI Whisper API** (`whisper-1` 모델)
- **호출 시점**: `/leave` 후 **사후 일괄** (실시간/청크 단위 호출 X)
- **호출 단위**: 화자 1명당 1 API 호출 (화자별 전체 발화 → MP3 → Whisper)
- **입력 포맷**: 32kbps mono MP3 (1시간 ≈ 14MB → 25MB 한도 안전)
- **timeline 복원**: `response_format=verbose_json` + `timestamp_granularities=["segment"]`로 segment-level timestamps 받음 → 회의 시작 기준 절대 elapsed로 변환 후 화자별 머지
- **언어 힌트**: `language=ko`
- 단가 약 $0.006/min ≈ $0.36/h
- `OPENAI_API_KEY` **별도 발급 필수** — threads-make와 키 분리 (비용 격리·권한 격리·키 폐기 시 영향 격리)

### 2.2 화자 식별
- **Discord SSRC 기반 자동 매핑** — `@discordjs/voice`의 `VoiceReceiver.subscribe(userId)`
- 오디오 기반 화자 분리(diarization) 모델 불필요
- 화자 표시 이름 우선순위 fallback:
  1. `member.nickname` (서버 닉네임, 한글 포함 가능)
  2. `user.globalName` (디스코드 글로벌 디스플레이 이름)
  3. `user.username` (legacy username)
- 봇 발화는 무시 (`user.bot === true`)

### 2.3 게시 위치
- **고정 텍스트 채널**: `DISCORD_TRANSCRIPT_CHANNEL_ID` env로 지정 (예: `#회의록`)
- **쓰레드 이름**: `[MM-DD] <AI 추출 주제>` 형식
  - 예: `[05-19] 마승훈 데이트 아이디어 회의`
  - 주제는 요약 LLM 산출물 JSON의 `thread_title` 필드 (50자 이내, 한국어 — json_schema strict로 보장)
  - 날짜 prefix `[MM-DD]`는 쓰레드 목록 정렬·검색 편의용 (사용자 결정)
  - Discord 쓰레드 이름 한도 100자 — title이 잘릴 경우 prefix 우선 보존
- **fallback**: AI 요약 실패 또는 `thread_title` 추출 실패 시 → `[MM-DD HH:MM] 회의록 — <호출자 이름>` 형식
- **쓰레드 생성 시점**: `/leave` 직후 → STT 일괄 처리 → OpenAI 요약 완료 → **그 다음** 쓰레드 생성
- 봇 입장 직후 **음성 채널 텍스트**에 "녹음 시작 / 종료는 /leave / 트랜스크립트는 #회의록으로" 안내 Embed

### 2.4 권한
- `/join`: 호출자가 **음성 채널에 참여 중**일 때만 가능 (자기가 들은 회의만 녹음)
- `/leave`: 현재 봇이 있는 음성 채널의 **참여자 누구나** 가능
- 별도 role/admin 가드는 없음 (사내 신뢰 기반)

### 2.5 녹음 길이·종료 안전장치
- **명시적 시간 한도 없음** (사용자 결정)
- **자동 leave 조건**: 음성 채널에 봇 외 인원 = 0명 상태 30초 지속 시 자동 `/leave`
- 환경변수: `AUTO_LEAVE_EMPTY_SECONDS=30`

### 2.6 MP3 분할·첨부 정책
- **30분 단위 자동 분할** — `part_1.mp3`, `part_2.mp3`, ...
- 비트레이트: **32kbps mono** (음성용 충분, 30분 ≈ 7MB → Discord 무료 25MB 한도 여유)
- mix 방식: 모든 화자 PCM을 단일 mixed 스트림으로 인코딩 (`ffmpeg amix` 필터)
- transcript 본문에 파트 경계 마커:
  ```
  --- Part 2/3 시작 (30:00) ---
  ```
- `/leave` 후 쓰레드 첫 메시지에 part 1 첨부 → 후속 메시지로 part 2, 3 ... 첨부

### 2.7 AI 자동 요약
- **디폴트 ON** (모든 회의에 자동 생성)
- 사용 LLM: **OpenAI `gpt-4o-mini`** (STT와 동일 `OPENAI_API_KEY` 공유 — 단일 vendor 통합, ADR-5)
- `response_format: { type: 'json_schema', strict: true }`로 출력 스키마 타입·필드를 모델 단에서 강제 → 파싱 실패율 사실상 0
- 회당 추가 비용 약 $0.001~0.005 (Claude Sonnet 대비 1/10)
- `SUMMARY_MODEL` env로 모델 교체 가능 (예: `gpt-4o`)
- 출력 형식 (사용자 명시 채택):

  ```
  🤖 Generating AI summary... (this may take a moment)

  📋 Notes from the Call

  👥 Speakers: <이름>, <이름>, ...

  <회의 1줄 요약>

  🎨 <동적 카테고리 1>
    — LLM이 회의 도메인에 따라 결정 (예: Creative Concepts, Tools, Rendering & Automation 등)

  📅 Timeline & Meeting Context
    날짜: YYYY-MM-DD (UTC)
    시작 시각: HH:MM AM/PM UTC
    종료 시각: HH:MM AM/PM UTC
    총 지속시간: <duration>
    녹음 모드: meeting

  💾 File Management / Channels
    서버: <Guild 이름>
    텍스트 채널: <쓰레드 부모 채널>
    음성 채널: <녹음한 voice 채널>

  🛠 Tools
    회의 중 언급된 도구·앱·웹사이트 (없으면 "언급 없음")

  ✅ Decision Tracking
    회의에서 내려진 결정사항 (없으면 "참여자 명단(기록용)만 표시")

  🧩 Next Steps & Responsibilities
    할당된 후속 작업·마감일·책임자 (없으면 "후속 작업 없음" 명시)
  ```

- **고정 섹션**: `👥 Speakers`, `📅 Timeline`, `💾 File Management`, `✅ Decision Tracking`, `🧩 Next Steps`
- **동적 섹션**: LLM이 회의 도메인을 보고 1~3개 카테고리 자유 결정 (예: 마케팅 회의면 `🎨 Creative Concepts`, 엔지니어링이면 `🛠 Tools` / `🛠 Rendering & Automation`)
- 요약 결과는 Discord Embed의 `description`에 담거나 본문 메시지로 출력 (Embed 4096자 한도 주의 — 초과 시 첨부 .md 분할)

#### 요약 출력 JSON 스키마 (OpenAI `json_schema strict`로 강제할 구조)

```json
{
  "thread_title": "마승훈 데이트 아이디어 회의",
  "one_line_summary": "마승훈 데이트 아이디어 회의 (간단 요약)",
  "dynamic_sections": [
    { "emoji": "🎨", "title": "Creative Concepts", "body": "..." }
  ],
  "decisions": ["박지건이 아이디어 부재를 이유로 회의 종료 결정"],
  "next_steps": []
}
```

- `thread_title`: **반드시 50자 이내 한국어 한 줄**, 핵심 주제. Discord 쓰레드 이름에 사용
- 출력 형식 안정성: OpenAI `response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }` 적용 → 모델 단에서 스키마 위반 시 자체 거부. 클라이언트 파싱 실패 사실상 발생 안 함
- 파싱 실패 시(네트워크 오류 등) → fallback 쓰레드 이름 사용 + `#alerts`에 경고 (안전망)

### 2.8 트랜스크립트 본문 형식 (사용자 명시 채택)

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                     NOTESBOT TRANSCRIPT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 Server:     <Guild 이름>
📅 Date:       Tuesday, May 19, 2026
🌐 Time zone:  UTC
🕐 Started:    HH:MM AM/PM UTC
🕑 Ended:      HH:MM AM/PM UTC
⏱️  Duration:   <duration>
👥 Speakers:   (N participants)
    • <이름 1>
    • <이름 2>
    • ...

────────────────────────────────────────────────────────────

[0:00] <이름>: <발화>
[0:05] <이름>: <발화>
--- Part 2/3 시작 (30:00) ---
[30:01] <이름>: <발화>
...
```

- 시간대: **UTC** (사용자 명시. 다른 사내 시스템 KST와 다름 — 의도된 결정)
- 날짜 포맷: 영문 (`Tuesday, May 19, 2026`)
- timestamp `[mm:ss]`: 회의 시작 기준 elapsed (시간대 무관, Whisper segment_timestamp + 화자 머지로 산출)

### 2.9 동시 회의 정책
- **단일 회의만 대응** (사용자 결정 — N개 라우팅 복잡도 회피)
- 이미 다른 음성 채널에서 녹음 중 상태에서 `/join` 호출 시 → 거절 메시지 (어느 채널에서 녹음 중인지 알림 포함)
- 추후 동시 N개 필요 시 메인 봇 + 워커 봇 아키텍처로 확장 (이 SPEC 범위 외)

### 2.10 DB (ADR Decision 3 축소판)
- **PostgreSQL 유지** (사용자 결정 — 추후 웹 대응을 위한 영구 보관)
- **threads-make와 완전 분리된 PostgreSQL 인스턴스** (서버·데이터베이스·유저 모두 별도. 서버 공용 금지 — 사용자 결정)
- 환경변수: `DATABASE_URL=postgres://eavesdropper_user:비밀번호@<별도 호스트>:5432/eavesdropper`
- 마이그레이션: `migrations/` 디렉토리, `npm run db:migrate`로 자동 적용 (threads-make 패턴 차용)

#### DB 스키마 초안 (3-테이블, YAGNI 축소판)

```sql
-- migrations/001_init.sql
CREATE TYPE meeting_status AS ENUM ('recording', 'transcribing', 'summarizing', 'completed', 'failed');

CREATE TABLE meetings (
  id BIGSERIAL PRIMARY KEY,
  guild_id TEXT NOT NULL,
  guild_name TEXT,
  voice_channel_id TEXT NOT NULL,
  voice_channel_name TEXT,
  invoked_by_user_id TEXT NOT NULL,
  invoked_by_name TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INT,
  status meeting_status NOT NULL DEFAULT 'recording',
  thread_id TEXT,
  thread_title TEXT,
  transcript_text TEXT,             -- 인라인. 검색 요구 명확해지면 row로 분해 마이그레이션
  summary_json JSONB,               -- 요약 LLM 산출물 전체 (OpenAI json_schema strict 결과)
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE meeting_speakers (
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE TABLE meeting_audio_parts (
  meeting_id BIGINT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  part_index INT NOT NULL,
  discord_attachment_url TEXT,
  duration_seconds INT,
  file_size_bytes INT,
  PRIMARY KEY (meeting_id, part_index)
);
```

> **유의**: 발화 단위 row 테이블(`meeting_utterances`)은 본 SPEC에서 **의도적으로 제외**. transcript는 `meetings.transcript_text`에 인라인. 검색·통계 요구가 명확해진 시점에 row 분해 마이그레이션 추가.

---

## 3. 기술 스택 (ADR Decision 2·4 적용)

- **Runtime**: Node.js 22+, ESM (`"type": "module"`)
- **Discord**: `discord.js` v14 + `@discordjs/voice` (voice receive 포함)
- **Opus → PCM 디코딩**: `prism-media` (OpusDecoder)
- **VAD**: **별도 라이브러리 없음** — `@discordjs/voice`의 `EndBehaviorType.AfterSilence` 내장 옵션 사용
- **오디오 처리 (concat, mix, 분할, MP3 인코딩)**: `ffmpeg` (시스템 의존성) + spawn 직접 호출 (또는 얇은 wrapper)
- **STT + 요약 LLM**: `openai` SDK 단일 (Whisper API `verbose_json` + Chat Completions `json_schema strict`로 `gpt-4o-mini` 요약) — ADR-5
- **DB**: `pg` (PostgreSQL 18)
- **CLI**: `@clack/prompts` (threads-make의 `scripts/cli.js` 패턴 차용)
- **운영**: PM2 (`ecosystem.config.cjs`), Raspberry Pi 5 또는 별도 서버
- **언어**: 한국어 (사용자 대면 메시지)
- **타임존**: UTC (transcript 메타데이터). 시스템 로그는 `Asia/Seoul` 권장

---

## 4. 파일 구조 (ADR Decision 2로 단순화)

```
eavesdropper/
├── README.md
├── CLAUDE.md                       # 이 SPEC 기반 작성 예정
├── package.json                    # type=module
├── ecosystem.config.cjs            # PM2 (notesbot)
├── .env.example
├── prompts/
│   └── summary.txt                 # OpenAI 요약 system 프롬프트 (변수 치환식, CLI에서 편집 가능)
├── src/
│   ├── bot.js                      # 봇 진입점, 슬래시 명령 핸들러 (orchestration은 finalize.js에 위임)
│   ├── finalize.js                 # /leave·auto-leave 후처리 orchestrator
│   │                               #   recorder.stopRecording → audio-pipeline → stt-whisper → transcript-builder
│   │                               #   → summarizer → publisher 순으로 호출, status 전이 관리
│   ├── recorder.js                 # voice channel join + receiver.subscribe + PCM 캡처
│   │                               #   - EndBehaviorType.AfterSilence 옵션으로 발화 cut
│   │                               #   - 화자별 raw PCM 임시 파일 누적
│   ├── audio-pipeline.js           # ffmpeg concat / amix / 30분 cut / MP3 인코딩
│   ├── stt-whisper.js              # 사후 일괄: 화자별 MP3 → Whisper(verbose_json) → segments
│   ├── transcript-builder.js       # 화자 segments 머지 → 회의 시작 기준 elapsed timeline + 포맷
│   ├── summarizer.js               # OpenAI json_schema strict로 구조화 요약 JSON 생성 (thread_title 포함)
│   ├── publisher.js                # 쓰레드 생성 + 첨부 전송 + DB 저장
│   ├── db.js                       # PG pool
│   └── discord-register.js         # 슬래시 명령 등록
├── migrations/
│   ├── migrate.js
│   └── 001_init.sql
├── scripts/
│   ├── cli.js                      # @clack/prompts 통합 CLI (npm run cli)
│   ├── install.js                  # 초기 셋업 TUI
│   └── test-record.js              # 로컬 녹음 시뮬레이션
└── logs/
```

> **변경점 (ADR Decision 2)**: `src/vad.js` 모듈 **삭제**. VAD는 `@discordjs/voice` 내장 옵션이 처리.

---

## 5. 환경 변수

```bash
# Discord
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
DISCORD_TRANSCRIPT_CHANNEL_ID=        # /leave 후 쓰레드 생성될 텍스트 채널
DISCORD_ALERTS_CHANNEL_ID=            # 에러·경고 (관리자 알림용)

# OpenAI (STT + 요약 단일 vendor — ADR-5)
OPENAI_API_KEY=
WHISPER_MODEL=whisper-1
WHISPER_LANGUAGE=ko
SUMMARY_MODEL=gpt-4o-mini             # gpt-4o 등으로 교체 가능

# PostgreSQL
DATABASE_URL=postgres://eavesdropper_user:비밀번호@localhost:5432/eavesdropper

# 녹음 정책
AUTO_LEAVE_EMPTY_SECONDS=30           # 봇만 남았을 때 자동 leave 대기 (초)
MP3_PART_DURATION_MINUTES=30          # MP3 파트 분할 간격
MP3_BITRATE_KBPS=32                   # 모노 비트레이트
END_BEHAVIOR_SILENCE_MS=1000          # @discordjs/voice subscribe()의 침묵 임계 (발화 cut 기준)

# 로그
LOG_LEVEL=info
TZ_DISPLAY=UTC                        # transcript 메타 표시 타임존
```

> **변경점 (ADR Decision 1·2)**:
> - `VAD_SILENCE_MS` → `END_BEHAVIOR_SILENCE_MS` (subscribe 옵션 인자 의미로 명명 변경)
> - `MAX_UTTERANCE_SECONDS` **삭제** (사후 일괄 처리이므로 청크 길이 한도 불필요)

> ⚠️ 환경변수 추가/변경 시 **4곳 동기화 필수** (threads-make 규칙 차용):
> 1. `.env.example`
> 2. `scripts/cli.js`의 `ENV_SECTIONS`
> 3. 이 SPEC의 §5 환경변수 목록
> 4. 운영 서버의 실제 `.env`

---

## 6. CLI 메뉴 범위 (`npm run cli`)

threads-make의 `scripts/cli.js` 패턴 차용. 메뉴:

- 🚀 **초기 셋업** — `.env` 인터랙티브 생성, 마이그레이션 실행, 슬래시 명령 등록
- ⚙️ **환경 변수 편집** — 섹션별 (Discord / OpenAI / DB / 녹음 정책 / 로그)
- 🔧 **프롬프트 편집** — `prompts/summary.txt` nano로 열기 (재시작 불필요)
- 🗄️ **DB** — 마이그레이션 실행, reset
- 🤖 **Discord 명령 재등록** — `npm run discord:register-commands`
- 📦 **업데이트 적용** — `git pull` + `npm install` + `db:migrate` + `discord:register-commands` + `pm2 restart`
- 🎛️ **PM2 운영** — start / restart / stop / logs / delete
- 🧪 **테스트** — `scripts/test-record.js` (로컬 녹음 시뮬레이션)
- 🚪 **종료**

---

## 7. 슬래시 명령 (등록 명세)

| 명령 | 옵션 | 권한 | 동작 |
|---|---|---|---|
| `/join` | (없음) | 호출자가 음성 채널 참여 중 | 호출자 음성 채널에 봇 join → 녹음 시작 |
| `/leave` | (없음) | 봇이 있는 음성 채널 참여자 | 녹음 종료 → 사후 일괄 파이프라인 → 쓰레드 게시 |
| `/status` | (없음) | 누구나 | 현재 녹음 중인 회의 정보 (없으면 "녹음 중인 회의 없음") |

---

## 8. 에러·예외 처리

threads-make 규칙 차용:

- 봇은 절대 죽으면 안 됨 — `process.on('unhandledRejection')` 필수
- 모든 외부 API(`OpenAI`, `Claude`, Discord upload) try/catch
- Whisper 호출 실패 (특정 화자) → 해당 화자 transcript에 `[STT 실패]` 마커, 다른 화자는 정상 진행
- 요약 LLM 실패 → transcript + MP3는 정상 게시, 요약 자리에 "요약 생성 실패 — 추후 재시도" 안내 (쓰레드 이름은 fallback 사용)
- 모든 슬래시 명령 핸들러는 즉시 `interaction.deferReply()` (3초 룰)
- 봇 토큰·API 키 로깅 금지 / Discord 메시지 출력 금지
- 음성 채널 연결 끊김 (네트워크) → 자동 재연결 1회 시도 → 실패 시 현재까지 수집된 PCM으로 강제 종료 + #alerts에 보고
- ffmpeg spawn 실패 → stderr 캡처 후 #alerts 보고 + DB status='failed'

---

## 9. 보안·프라이버시

- 봇 입장 시 채널에 명시적 "녹음 시작" 공지 (참여자가 인지 가능)
- 임시 파일(PCM/MP3 part)은 `/leave` 직후 (쓰레드 업로드 완료 후) 삭제
- PG에 영구 저장되는 데이터: 회의 메타·transcript_text·summary_json (MP3는 Discord에만 남기고 로컬 임시)
- 화자별 사용자 ID는 Discord ID로 저장 — 본인 요청 시 해당 회의 row 삭제 가능 (관리 CLI에 향후 추가)
- 한국 통신비밀보호법: 회의 참여자 중 봇 호출자 1명이 동의(=명령 실행)했으므로 본인 참여 대화 녹음은 합법

---

## 10. 비기능 요구사항

- **단일 회의 대응** — 동시 진행 X (두 번째 `/join` 거절)
- **최소 가동 환경** — Node 22, ffmpeg, PostgreSQL 14+. Raspberry Pi 5에서 동작 가능 (CPU STT 부담 없음 — 음성은 OpenAI로 외주, ffmpeg 인코딩만 로컬)
- **회의 길이 한도 명시적 없음** — 단, 봇만 남는 경우 30초 후 자동 leave
- **후처리 시간**: 1시간 회의 기준 ffmpeg concat + Whisper N회 + OpenAI 요약 1회 → 약 1~3분 (사용자에게 "처리 중" 진행 메시지 노출)

---

## 11. 명시적으로 SPEC 범위 외인 사항

- AI 요약을 사후에 재실행하는 `/summarize` 명령 (필요 시 후속 작업)
- 회의 검색용 웹 인터페이스 (DB는 이를 위해 보관하지만 웹 자체는 별도 프로젝트)
- 동시 N개 회의 대응 (메인+워커 봇 아키텍처)
- 화자별 음성 학습/지문 기반 식별 (현재는 Discord SSRC만 사용)
- 영상 회의 (Discord 화면 공유) 캡처
- 실시간 자막 (live transcription) — 본 SPEC은 회의 종료 후 일괄 게시
- 발화 단위(utterance row) 검색·통계 (DB는 인라인 transcript로 시작)

---

## 12. 기존 코드 패턴 차용 (탐색 결과)

> **주의**: 본 섹션은 **코드 작성 패턴의 글자 단위 복사**만 다룹니다. API 키, PostgreSQL 인스턴스, Discord 봇 토큰, 런타임 프로세스는 threads-make와 **모두 분리**됩니다 (§2.1, §2.7, §2.10 결정). 코드 의존성도 없음 — 별개 git, 별개 `node_modules`.

`threads-make/`에서 글자 그대로 복사하거나 골격을 모방할 수 있는 코드 패턴:

| 항목 | threads-make 위치 | eavesdropper 적용 |
|---|---|---|
| @clack/prompts CLI | `scripts/cli.js` | 메뉴만 회의록 도메인용으로 교체, 골격 복붙 |
| @clack/prompts 초기 설치 TUI | `scripts/install.js` | 동일 |
| ESM Discord 봇 entry | `src/discord-bot.js` 헤더부 | unhandledRejection / deferReply 패턴 |
| 사후 일괄 파이프라인 패턴 | `src/marketing-pipeline.js`, `src/replies-sync.js` | `/leave` 후 일괄 처리에 동일 멘탈 모델 적용 |
| OpenAI Chat Completions 호출 패턴 | threads-make는 Anthropic SDK 사용하지만 SDK 호출 골격은 동일 — eavesdropper는 `openai` SDK + `json_schema strict` 적용 |
| PG migration 자동 적용 | `migrations/migrate.js` | 동일 |
| PM2 ecosystem | `ecosystem.config.cjs` | 앱 1개(`notesbot`)로 단순화 |
| .env 섹션 정의 + 편집 | `scripts/cli.js` `ENV_SECTIONS` | 회의록용 키로 교체 |
| 환경변수 4곳 동기화 규칙 | threads-make `CLAUDE.md` 절대규칙 #8 | 동일 적용 |
| 사용자 대면 메시지 한국어 | 전반 | 동일 |
| 봇 안 죽게 하는 핸들러 | `src/discord-bot.js` 부트 | 동일 |

---

## 13. 인터뷰 결정 트레일

| # | 질문 | 결정 | 근거 |
|---|---|---|---|
| 1 | STT 엔진 | OpenAI Whisper API | 한국어 정확도 검증됨 (키는 별도 발급) |
| 2 | 트랜스크립트 게시 위치 | 고정 채널 #회의록 | 검색·관리 일원화 |
| 3 | 녹음 길이 한도 | 없음 + 봇 단독 30초 자동 leave | 한도 vs UX 트레이드오프, 청크 분할로 비용·파일크기 해결 |
| 4 | MP3 분할 단위 | 30분 + 봇만 남는 채널 자동 leave | 결정적 시점 (timeline 마커 동기) + 무료 25MB 한도 안전 |
| 5 | 권한·공지 | 호출자 음성채널 참여 필수 + /leave 동일 채널 누구나 + 입장 공지 Embed | 사내 신뢰 + 법적/윤리적 명시 |
| 6 | AI 요약 | 디폴트 ON + 사용자 명시 형식 (동적 카테고리 + 고정 섹션, OpenAI gpt-4o-mini json_schema strict) | "회의 요약 봇" 이름에 충실 |
| 7 | 동시 회의 + DB | 동시 1개만 + PG 유지 (추후 웹 대응) | N개 라우팅 복잡도 회피, 영구 보관은 별개 가치 |
| 8 | 쓰레드 이름 | `[MM-DD] <AI 추출 주제>` + 실패 시 fallback | timestamp+호출자보다 식별성↑, 날짜 prefix는 정렬·검색용 유지 |

---

## 14. ADR 결정 트레일 (구현 방안 검증)

| ADR # | 결정 영역 | 채택안 | 폐기안 | 핵심 근거 |
|---|---|---|---|---|
| ADR-1 | STT 호출 패턴 | **사후 일괄** (화자별 PCM concat → MP3 → Whisper verbose_json 1회) | 발화 청크 단위 실시간 호출 | 실시간 가치 0인데 비용 최대 / 한국어 짧은 청크 정확도 저하 / threads-make의 사후 cron 패턴과 동일 멘탈 모델 |
| ADR-2 | VAD | `@discordjs/voice`의 `EndBehaviorType.AfterSilence` 내장 옵션 | `webrtc-vad` + 자체 `src/vad.js` | 라이브러리 표준 / 의존성 0 / NIH 회피 |
| ADR-3 | DB 스키마 범위 | 3-테이블 (meetings + speakers + audio_parts), transcript 인라인 | 4-테이블 (+ meeting_utterances) | YAGNI — 발화 단위 검색 요구 미정의 / row 폭증 회피 / 추후 필요 시 row 분해 마이그레이션 |
| ADR-4 | 오디오 처리 스택 | `prism-media` (Opus→PCM) + `ffmpeg` spawn (concat/amix/MP3) | `@discordjs/opus` 직접 인코딩 | discord.js 공식 권장 조합 / mix 시간 동기화 부담 회피 |
| ADR-5 | LLM vendor 통합 | **OpenAI 단일** — Whisper(STT) + `gpt-4o-mini` json_schema strict(요약) | Anthropic Claude 별도 키 | 키 1개로 운영 단순 / json_schema strict가 Claude system prompt JSON 강제보다 파싱 안정 / 비용 1/10 / 의존성 `@anthropic-ai/sdk` 제거 / 단일 vendor 장애 risk는 사내 회의 봇 RTO에 관대 |

---

## 15. 다음 단계 (구현 시작 전 확인)

본 SPEC 합의 후 다음 산출물 예정 (이번 인터뷰·ADR 범위 외):

1. `package.json` + 의존성 (`discord.js`, `@discordjs/voice`, `@discordjs/opus`, `prism-media`, `openai`, `pg`, `@clack/prompts`) — ADR-5에 따라 `@anthropic-ai/sdk` 제외
2. `CLAUDE.md` 작성 (threads-make 스타일)
3. `migrations/001_init.sql` 작성 (3-테이블)
4. PoC: `/join` → 단일 사용자 음성 1분 캡처 → ffmpeg concat → Whisper 1회 → `/leave` → 로컬 transcript 출력
5. CLI(`scripts/cli.js`) 골격
6. OpenAI 요약 프롬프트(`prompts/summary.txt`) 설계 + `json_schema strict` 스키마 정의
7. ffmpeg 명령 wrapper (`src/audio-pipeline.js`) — concat / amix / 30분 cut / MP3 인코딩
8. 단계적 통합 → PM2 등록
