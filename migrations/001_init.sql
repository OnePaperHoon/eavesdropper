-- 회의 요약 봇 초기 스키마 (SPEC §2.10 / ADR-3)
-- 3-테이블 축소판: meetings + meeting_speakers + meeting_audio_parts
-- (utterance row 분해는 검색 요구 명확해진 시점에 별도 마이그레이션)

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
