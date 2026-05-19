# 01 — DB 토대

> SPEC §2.10 / ADR-3 (3-테이블 축소판)

## 목표

PostgreSQL `eavesdropper` 데이터베이스에 마이그레이션 체계와 3-테이블 초기 스키마(`meetings`, `meeting_speakers`, `meeting_audio_parts`)를 구축한다.

## 작업

### 1. `src/db.js` — threads-make 패턴 그대로 차용

```js
import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('DB 풀 에러:', err.message);
});

export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
export default pool;
```

### 2. `migrations/migrate.js` — threads-make 패턴 그대로 차용

threads-make `migrations/migrate.js`를 글자 그대로 복사. 동작:
- `migrations` 이력 테이블 생성 (idempotent)
- `migrations/*.sql`을 알파벳 순 정렬
- 미적용 파일만 transaction 없이 순차 실행 (각 파일은 자체 transaction을 쓰거나 idempotent하게 작성)
- INSERT INTO migrations 후 다음 파일로

### 3. `migrations/001_init.sql`

```sql
-- 회의 요약 봇 초기 스키마 (SPEC §2.10 / ADR-3)

CREATE TYPE meeting_status AS ENUM (
  'recording',
  'transcribing',
  'summarizing',
  'completed',
  'failed'
);

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
  transcript_text TEXT,
  summary_json JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_meetings_status ON meetings(status);
CREATE INDEX idx_meetings_started_at ON meetings(started_at DESC);

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

### 4. 마이그레이션 실행

```bash
npm run db:migrate
```

기대 출력:
```
✅ 001_init.sql 적용 완료

총 1개 마이그레이션 완료
```

## 검수 기준

- [ ] `psql ... -c "\dt"` 시 `meetings`, `meeting_speakers`, `meeting_audio_parts`, `migrations` 4테이블 보임
- [ ] `psql ... -c "\dT"` 시 `meeting_status` enum 보임
- [ ] `npm run db:migrate` 재실행 시 "이미 적용됨" 메시지로 idempotent 확인
- [ ] `INSERT INTO meetings (guild_id, voice_channel_id, invoked_by_user_id) VALUES ('g', 'v', 'u') RETURNING id` 성공

## 향후 마이그레이션 가이드

- 파일명은 `00N_<설명>.sql` 순서 (zero-padding 3자리)
- 각 파일은 가능하면 idempotent (CREATE TABLE IF NOT EXISTS 등)
- ENUM 값 추가는 별도 migration: `ALTER TYPE meeting_status ADD VALUE 'new_state'`
- 환경변수 추가 마이그레이션 시 SPEC §5 + `.env.example` + `scripts/cli.js`의 ENV_SECTIONS + 운영 `.env` 4곳 동기화

## 다음 체크포인트

→ [02-bot-core](./02-bot-core.md)
