# 00 — 프로젝트 부트스트랩

> SPEC §3, §5 / plan.md §3 신규 파일 그룹 1

## 목표

빈 git clone 상태인 `eavesdropper/`에 새 Node.js ESM 프로젝트 스켈레톤을 깔고, 의존성 설치 + PM2 설정 + 시스템 의존성(ffmpeg, PostgreSQL) 확인까지 완료한다.

## 작업

### 1. `package.json` 생성

```json
{
  "name": "eavesdropper",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node src/bot.js",
    "dev": "nodemon src/bot.js",
    "db:migrate": "node migrations/migrate.js",
    "discord:register-commands": "node src/discord-register.js",
    "cli": "node scripts/cli.js",
    "install:setup": "node scripts/install.js",
    "test:record": "node scripts/test-record.js"
  },
  "dependencies": {
    "@clack/prompts": "^1.3.0",
    "@discordjs/voice": "^0.19.2",
    "discord.js": "^14.18.0",
    "dotenv": "^16.5.0",
    "openai": "^4.98.0",
    "opusscript": "^0.0.8",
    "pg": "^8.14.1",
    "prism-media": "^1.3.5"
  },
  "optionalDependencies": {
    "@discordjs/opus": "^0.10.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.10"
  },
  "engines": { "node": ">=22.0.0" }
}
```

> `ffmpeg`는 시스템 패키지(`apt install ffmpeg` 또는 macOS `brew install ffmpeg`)로 설치. npm 패키지로 안 받음 (이미 사내 인프라에 있음 가정).

### 2. `.gitignore`

```
node_modules/
logs/
tmp/
.env
.env.*
!.env.example
*.log
.DS_Store
```

### 3. `.env.example` (SPEC §5 그대로)

SPEC §5의 환경변수 블록 그대로 복사 + 모든 값은 빈 문자열.

### 4. `ecosystem.config.cjs`

```js
module.exports = {
  apps: [
    {
      name: 'eavesdropper',
      script: 'src/bot.js',
      interpreter: 'node',
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: { NODE_ENV: 'production' },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: 'logs/bot-error.log',
      out_file: 'logs/bot-out.log',
    },
  ],
};
```

### 5. `tmp/`, `logs/` 디렉토리 생성

`tmp/.gitkeep`, `logs/.gitkeep` 두고 빈 디렉토리 추적 (또는 `mkdir -p` 부트 시 자동).

### 6. 사전 시스템 점검

> **분리 원칙**: PG 인스턴스·OpenAI 키(Whisper+요약 단일)·Discord 봇 토큰 모두 threads-make와 **별도** (SPEC §2.1, §2.7, §2.10, ADR-5). 같은 PG 서버에 database만 추가하는 방식 **금지**.

다음 명령들이 모두 성공해야 다음 체크포인트 진행:

```bash
node --version                                                     # v22+
ffmpeg -version                                                    # 4.x+
psql --version                                                     # 14+ (또는 18)
# 별도 PG 서버 연결 검증 — threads-make와 다른 host:port 사용
psql -h <eavesdropper-pg-host> -p <port> -U eavesdropper_user \
     -d eavesdropper -c "SELECT 1"
npm install                                                        # 의존성 설치
```

`@discordjs/opus`는 `optionalDependencies`로 격리되어 있어 native 빌드가 실패해도 install이 계속 진행된다. 실패 시 `prism-media`가 자동으로 `opusscript`(pure JS) fallback. ARM64 Pi5 + Node 22 환경에서는 `@discordjs/opus@0.10.0`이 NEON intrinsics 버그로 빌드 실패가 알려진 이슈 — 무시하고 진행해도 봇은 정상 동작.

## 검수 기준

- [ ] `npm install` 무에러
- [ ] `node -e "console.log('ok')"` 성공
- [ ] `ffmpeg -version` 출력 확인
- [ ] `psql -h <host> -U eavesdropper_user -d eavesdropper -c "SELECT 1"` 성공 (DB는 사전 준비에서 생성)
- [ ] `.env` 파일 생성 (`.env.example` 복사 후 값 채움)
- [ ] `pm2 list` 사용 가능

## 다음 체크포인트

→ [01-db-foundation](./01-db-foundation.md)
