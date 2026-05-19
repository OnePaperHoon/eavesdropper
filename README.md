# eavesdropper — 회의 요약 봇 (NotesBot)

사내 Discord 음성 회의를 자동으로 녹음·전사(한국어 STT)·구조화 요약하여, 회의가 끝나면 지정된 텍스트 채널에 **쓰레드 + transcript .txt + 30분 분할 MP3**로 게시하는 봇입니다.

```
/join → 호출자 음성 채널 입장 → 화자별 캡처
                                     │
/leave → 후처리 → Whisper STT → OpenAI 요약
                                     │
                              #회의록 채널에 쓰레드 게시
                              (요약 Embed + transcript.txt + part_1.mp3, part_2.mp3 ...)
```

자세한 결정 트레일·아키텍처·ADR은 [`.a_plan/20260519회의요약봇/SPEC.md`](./.a_plan/20260519회의요약봇/SPEC.md) 참조. AI 어시스턴트(Claude 등)가 본 프로젝트에서 작업할 때는 [`CLAUDE.md`](./CLAUDE.md)를 먼저 읽으세요.

---

## 사전 준비

본 봇을 운영하려면 다음 4가지가 모두 필요합니다:

1. **운영 머신** (Raspberry Pi 5 또는 별도 리눅스 서버)
2. **Discord 봇 application + 토큰** ([1단계](#1-discord-봇-생성))
3. **OpenAI API 키** ([2단계](#2-openai-api-키-발급))
4. **별도 PostgreSQL 인스턴스** — threads-make 등 다른 프로젝트의 PG와 공용 금지 ([3단계](#3-postgresql-준비))

---

## 1. Discord 봇 생성

### 1-1. Application 생성

1. https://discord.com/developers/applications 접속 (회사 계정 권장)
2. 우측 상단 **"New Application"** → 이름 입력 (예: `NotesBot`) → Create
3. 좌측 메뉴 **General Information**에서 `APPLICATION ID` 복사 → 나중에 `.env`의 `DISCORD_CLIENT_ID`에 사용

### 1-2. Bot 토큰 발급

1. 좌측 메뉴 **Bot** 클릭
2. **Privileged Gateway Intents** 섹션에서 다음 토글 켜기:
   - ✅ **SERVER MEMBERS INTENT** (화자 닉네임 조회용)
   - ❌ PRESENCE INTENT (불필요)
   - ❌ MESSAGE CONTENT INTENT (불필요)
3. **Reset Token** 또는 **Token** 영역에서 토큰 발급 → 즉시 복사 (한 번만 보임)
   - 토큰을 잃으면 다시 Reset 가능하지만 기존 인스턴스가 죽음
   - 나중에 `.env`의 `DISCORD_BOT_TOKEN`에 사용
4. **PUBLIC BOT** 토글은 OFF (사내 전용)

### 1-3. OAuth2 권한 설정 + 초대 URL 생성

1. 좌측 메뉴 **OAuth2 → URL Generator**
2. **SCOPES** 체크:
   - ✅ `bot`
   - ✅ `applications.commands`
3. **BOT PERMISSIONS** 체크 (스크롤 내려가며):
   - ✅ View Channels
   - ✅ Send Messages
   - ✅ Send Messages in Threads
   - ✅ Create Public Threads
   - ✅ Embed Links
   - ✅ Attach Files
   - ✅ Read Message History
   - ✅ Use Slash Commands
   - ✅ Connect (voice 입장)
   - ✅ Speak (필수는 아니지만 권장)
4. 페이지 하단의 **GENERATED URL** 복사

### 1-4. 봇 서버 초대

1. 위에서 복사한 URL을 브라우저에 붙여넣기
2. **드롭다운에서 사내 Discord 서버 선택** → 인증
3. 봇이 서버 멤버 목록에 나타나면 성공

### 1-5. 서버 ID와 채널 ID 수집

Discord 클라이언트 **개발자 모드** 활성화:
- 설정(톱니바퀴) → **고급(Advanced)** → **개발자 모드** ON

수집할 ID 3개:
1. **서버(Guild) ID**: 서버 이름 우클릭 → "ID 복사"
   - 나중에 `.env`의 `DISCORD_GUILD_ID`
2. **`#회의록` 텍스트 채널 ID**: 회의록 게시용 채널을 새로 만들거나 기존 채널 선택 → 우클릭 → "ID 복사"
   - 나중에 `.env`의 `DISCORD_TRANSCRIPT_CHANNEL_ID`
3. **`#alerts` 텍스트 채널 ID** (선택): 에러·경고를 받을 채널. 미설정 시 콘솔에만 출력
   - 나중에 `.env`의 `DISCORD_ALERTS_CHANNEL_ID`

또한 테스트용 **음성 채널**을 하나 마련해두세요 (회의 시뮬레이션용).

---

## 2. OpenAI API 키 발급

> ⚠️ **threads-make 등 다른 프로젝트의 키 재사용 금지** (ADR-5 — 비용·권한 격리)

1. https://platform.openai.com/api-keys 접속 (회사 결제 계정 권장)
2. **Create new secret key** → 이름 (예: `eavesdropper-prod`)
3. 토큰 즉시 복사 → 나중에 `.env`의 `OPENAI_API_KEY`
4. 결제 정보 / 사용 한도 확인 (회의 1시간 ≈ $0.36 + 요약 $0.001~)

봇이 사용하는 모델:
- **Whisper** (`whisper-1`) — STT
- **gpt-4o-mini** — 요약 (변경 가능, `.env`의 `SUMMARY_MODEL`)

---

## 3. PostgreSQL 준비

> ⚠️ **threads-make 등의 PG 인스턴스와 공용 금지** — 별도 인스턴스 필요

새 PG 인스턴스 위치는 자유롭게 결정 (예: 같은 머신의 다른 포트 / 별도 머신 / 클라우드 RDS·Supabase).

```sql
-- PG 서버에 접속 후 (예: psql -U postgres)
CREATE USER eavesdropper_user WITH PASSWORD '<강한_비밀번호>';
CREATE DATABASE eavesdropper OWNER eavesdropper_user;
GRANT ALL PRIVILEGES ON DATABASE eavesdropper TO eavesdropper_user;
```

연결 문자열은 나중에 `.env`의 `DATABASE_URL`에:

```
postgres://eavesdropper_user:<비밀번호>@<호스트>:5432/eavesdropper
```

---

## 4. 시스템 패키지 설치 (운영 머신)

Raspberry Pi 5 / Debian / Ubuntu 기준:

```bash
sudo apt update
sudo apt install -y ffmpeg build-essential python3
```

- **ffmpeg** (필수): 오디오 concat·mix·MP3 인코딩
- **build-essential / python3** (선택): `@discordjs/opus` native 빌드 시도용. 빌드 실패해도 `opusscript` 자동 fallback이라 봇 동작에는 무방

Node.js **22 이상** 필요:

```bash
node --version    # v22.0.0 이상이어야 함
```

설치 안 됐다면 [nvm](https://github.com/nvm-sh/nvm) 또는 [NodeSource](https://github.com/nodesource/distributions) 권장.

PM2도 전역 설치:

```bash
sudo npm install -g pm2
pm2 --version
```

---

## 5. 프로젝트 셋업

### 5-1. clone & install

```bash
git clone <repo-url> eavesdropper
cd eavesdropper

npm install
```

> ⚠️ ARM64 Pi5 + Node 22 환경에서 `@discordjs/opus` 빌드 에러(`celt_inner_prod_neon` 등)가 보여도 무시. `optionalDependencies`라 install이 계속 진행되며 `opusscript`가 자동 fallback됩니다.

### 5-2. 초기 셋업 — `npm run cli`로 일원화

이후 모든 운영 작업은 **`npm run cli` 한 진입점**으로 처리합니다. raw `pm2 ...` / `psql` / `git pull` 셸 명령을 직접 치지 마세요.

```bash
npm run cli
```

메뉴에서 다음 순서로:

1. **🚀 초기 셋업** → `.env`를 대화형으로 채움
   - Discord 봇 토큰, Client ID, Guild ID, Transcript Channel ID
   - OpenAI API 키
   - DATABASE_URL (예: `postgres://eavesdropper_user:비번@localhost:5432/eavesdropper`)
   - (선택) Alerts Channel ID
   - 이어서 자동으로 `db:migrate` + 슬래시 명령 등록까지 수행

2. **🎛️ PM2 운영 → start** → 봇 부팅

3. **🎛️ PM2 운영 → save** → 부팅 자동시작 등록 (Pi 재부팅 후 자동 복구)

4. **🎛️ PM2 운영 → status** → 봇이 `online`인지 확인

이제 사내 Discord에서 봇이 온라인으로 보입니다.

---

## 6. 사용법 (사내 사용자용)

### 회의 녹음 시작

1. 본인이 음성 채널에 입장
2. 같은 서버의 아무 텍스트 채널에서:
   ```
   /join
   ```
3. 봇이 음성 채널에 들어오고 "🎙️ 회의 녹음 시작" Embed가 음성 채널 채팅에 표시됨

### 회의 종료

```
/leave
```

- 봇이 있는 음성 채널의 참여자라면 누구나 호출 가능
- 1~3분 후처리 후 `#회의록` 채널에 쓰레드가 생성됨

### 현재 상태 확인

```
/status
```

### 자동 종료 (안전장치)

봇만 남고 모든 인원이 음성 채널을 나가면 **30초 후 자동 `/leave`**. `/leave` 까먹기로 인한 무한 녹음·비용 누적 방지.

---

## 7. 운영 (`npm run cli` 메뉴)

| 메뉴 | 용도 |
|---|---|
| 🚀 초기 셋업 | 최초 1회 |
| ⚙️ 환경 변수 편집 | API 키 교체 / 채널 ID 변경 등 |
| 🔧 요약 프롬프트 편집 | `prompts/summary.txt` 즉시 편집 (재시작 불요) |
| 🗄️ DB | 마이그레이션, stuck 회의 청소 |
| 🤖 Discord 명령 재등록 | 슬래시 명령 추가/변경 시 |
| 📦 업데이트 적용 | `git pull` + `npm install` + `migrate` + 명령 재등록 + PM2 재시작 한 번에 |
| 🎛️ PM2 운영 | start / restart / stop / delete / logs / status / save & startup |
| 🧪 테스트 | 로컬 audio-pipeline·transcript-builder 단위 시뮬레이션 |

---

## 8. 문제 해결

### `npm install` 시 `@discordjs/opus` 빌드 실패

ARM64 Pi5 + Node 22 환경의 알려진 라이브러리 버그. **무시해도 됩니다** — `opusscript` 자동 fallback. 봇 동작에 문제 없음.

### `npm run cli` 시 `Cannot find package '@clack/prompts'`

`npm install`이 아직 안 됐습니다. 의존성 가드가 친절한 한국어 안내를 출력합니다.

```bash
npm install
```

### 슬래시 명령이 안 보임

```
npm run cli → 🤖 Discord 명령 재등록
```

Discord 클라이언트는 1분 이내 갱신.

### 봇이 음성 채널에 못 들어옴

- 봇 권한에 **Connect** + **View Channel** 있는지 확인 (1-3단계)
- 해당 음성 채널이 비공개라면 봇에게 해당 채널 권한 부여 필요

### `Whisper "file too large"`

32kbps mono 1시간 ≈ 14MB라 보통 25MB 한도 안전. 그래도 발생하면 `.env`의 `MP3_BITRATE_KBPS=24`로 낮춰보세요.

### transcript에 `[STT 실패]` 마커

화자 한 명의 Whisper 호출이 실패한 경우. 다른 화자는 정상 진행. 네트워크/타임아웃 일시적 문제일 가능성 큼.

### 봇이 죽었다 살아도 회의가 stuck 상태

부팅 시 자동으로 1시간 이상 in-progress인 회의 row를 `failed`로 정리합니다. 즉시 정리하려면 `npm run cli → 🗄️ DB → stuck 회의 청소`.

### 동시에 회의 2건을 녹음하고 싶음

본 SPEC 범위 외. 단일 회의만 대응 — 두 번째 `/join`은 거절됩니다. 향후 메인+워커 봇 아키텍처로 확장 가능 (별도 태스크).

---

## 9. 비용 (참고)

회의 1시간 기준 예상:

| 항목 | 비용 |
|---|---|
| Whisper STT | 약 $0.36 |
| gpt-4o-mini 요약 | 약 $0.001~0.005 |
| Discord 첨부 호스팅 | 무료 |
| **합계** | **약 $0.36/h** |

월 회의 100시간 ≈ $36.

---

## 10. 참고

- [SPEC.md](./.a_plan/20260519회의요약봇/SPEC.md) — 전체 결정 트레일 + ADR
- [plan.md](./.a_plan/20260519회의요약봇/plan.md) — 구현 계획
- [checkpoints/](./.a_plan/20260519회의요약봇/checkpoints/) — 단계별 체크포인트
- [CLAUDE.md](./CLAUDE.md) — AI 어시스턴트용 프로젝트 컨텍스트
