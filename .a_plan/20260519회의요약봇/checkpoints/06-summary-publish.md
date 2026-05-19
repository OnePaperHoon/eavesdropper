# 06 — OpenAI 요약 + Discord 게시 + DB 저장

> SPEC §2.3, §2.7, §2.10, §9 / ADR-5 (OpenAI 단일 vendor)

## 목표

transcript 텍스트를 OpenAI `gpt-4o-mini`에 보내 `json_schema strict` 응답을 받고, `[MM-DD] <thread_title>` 형식 쓰레드를 `DISCORD_TRANSCRIPT_CHANNEL_ID` 채널에 생성하여 요약 Embed + transcript.txt + part_N.mp3 순차 첨부 후 DB에 영구 저장한다.

## 작업

### 1. `prompts/summary.txt` (OpenAI system 프롬프트)

```
당신은 사내 회의 트랜스크립트를 구조화 요약하는 AI 어시스턴트입니다.

다음 트랜스크립트를 읽고, 아래 JSON 스키마에 정확히 맞는 JSON 객체 단 하나만 출력하세요.
JSON 외 다른 문자(설명, 마크다운 펜스 등) 출력 금지.

스키마:
{
  "thread_title": string,                  // 50자 이내 한국어 한 줄. 회의 핵심 주제.
  "one_line_summary": string,              // 한 줄 요약 (1~2문장)
  "dynamic_sections": [                    // 회의 도메인에 따라 1~3개 자유 결정
    {
      "emoji": string,                     // 이모지 1자 (예: 🎨, 🛠, 📊)
      "title": string,                     // 영문/한글 자유 (예: "Creative Concepts")
      "body": string                       // 해당 섹션 본문 (불릿 가능)
    }
  ],
  "decisions": [string],                   // 회의에서 내려진 결정사항. 없으면 빈 배열.
  "next_steps": [string]                   // 후속 작업·책임자·마감. 없으면 빈 배열.
}

트랜스크립트:
{{TRANSCRIPT}}
```

### 2. `src/summarizer.js` (OpenAI `gpt-4o-mini` + `json_schema strict`)

```js
import OpenAI from 'openai';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, '..', 'prompts', 'summary.txt'), 'utf8');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.SUMMARY_MODEL || 'gpt-4o-mini';

// json_schema strict: 모델이 스키마 위반 응답을 자체 거부.
// thread_title maxLength 50 강제로 클라이언트 보정 거의 불필요.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['thread_title', 'one_line_summary', 'dynamic_sections', 'decisions', 'next_steps'],
  properties: {
    thread_title: { type: 'string', description: '50자 이내 한국어 한 줄 핵심 주제' },
    one_line_summary: { type: 'string' },
    dynamic_sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['emoji', 'title', 'body'],
        properties: {
          emoji: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    decisions: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
  },
};

const FALLBACK = () => ({
  thread_title: null,
  one_line_summary: '요약 생성 실패 — transcript 본문 참조',
  dynamic_sections: [],
  decisions: [],
  next_steps: [],
});

export async function summarizeTranscript(transcriptText) {
  const system = PROMPT_TEMPLATE.replace('{{TRANSCRIPT}}', transcriptText);

  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '위 스키마대로 JSON 객체를 출력하세요.' },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'meeting_summary',
          strict: true,
          schema: SUMMARY_SCHEMA,
        },
      },
    });

    const text = resp.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(text);

    // 50자 안전 절단 (strict가 maxLength를 enforce하지만 안전망)
    if (parsed.thread_title && parsed.thread_title.length > 50) {
      parsed.thread_title = parsed.thread_title.slice(0, 50);
    }
    return parsed;
  } catch (err) {
    console.error('OpenAI 요약 실패:', err.message);
    return FALLBACK();
  }
}
```

> **JSON 강제 모드 비교**: Claude의 system prompt 기반 JSON 강제는 가끔 펜스(```` ```json `````)나 추가 설명을 섞어 출력 → 파싱 실패. OpenAI `json_schema strict`는 모델이 스키마 위반 응답을 자체 거부하므로 클라이언트 fallback이 발동할 일이 사실상 없음. SPEC §2.7 결정의 핵심.

### 3. 요약 → Discord Embed 변환

```js
import { EmbedBuilder } from 'discord.js';

export function buildSummaryEmbed(summary, meeting, speakers) {
  const speakerNames = speakers.map((s) => s.displayName).join(', ');

  const lines = [
    `**📋 Notes from the Call**`,
    '',
    `**👥 Speakers:** ${speakerNames}`,
    '',
    summary.one_line_summary || '',
    '',
  ];

  for (const sec of summary.dynamic_sections || []) {
    lines.push(`**${sec.emoji} ${sec.title}**`);
    lines.push(sec.body);
    lines.push('');
  }

  if (summary.decisions?.length) {
    lines.push('**✅ Decision Tracking**');
    summary.decisions.forEach((d) => lines.push(`• ${d}`));
    lines.push('');
  }

  if (summary.next_steps?.length) {
    lines.push('**🧩 Next Steps & Responsibilities**');
    summary.next_steps.forEach((n) => lines.push(`• ${n}`));
  } else {
    lines.push('**🧩 Next Steps & Responsibilities**');
    lines.push('할당된 후속 작업 없음.');
  }

  // 4096자 한도 안전 절단
  const desc = lines.join('\n').slice(0, 4000);

  return new EmbedBuilder()
    .setDescription(desc)
    .setColor(0x57F287)
    .setTimestamp(meeting.endedAt);
}
```

### 4. `src/publisher.js` — 쓰레드 생성 + 첨부 + DB 저장

```js
import { AttachmentBuilder, ChannelType } from 'discord.js';
import { query } from './db.js';
import { writeFileSync, statSync, rmSync } from 'fs';
import { join as pjoin } from 'path';

const TRANSCRIPT_CHANNEL = process.env.DISCORD_TRANSCRIPT_CHANNEL_ID;

function pad(n) { return String(n).padStart(2, '0'); }

function makeThreadName(summary, meeting) {
  const d = new Date(meeting.startedAt);
  const mm = pad(d.getUTCMonth() + 1);
  const dd = pad(d.getUTCDate());

  if (summary.thread_title && summary.thread_title.trim()) {
    const prefix = `[${mm}-${dd}] `;
    const maxBody = 100 - prefix.length;
    return prefix + summary.thread_title.slice(0, maxBody);
  }
  // fallback
  const hh = pad(d.getUTCHours());
  const mi = pad(d.getUTCMinutes());
  return `[${mm}-${dd} ${hh}:${mi}] 회의록 — ${meeting.invokedByName}`.slice(0, 100);
}

export async function publishMeeting({
  client, session, summary, transcriptText, mp3Parts,
  meeting, speakers,
}) {
  const channel = await client.channels.fetch(TRANSCRIPT_CHANNEL);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error('DISCORD_TRANSCRIPT_CHANNEL_ID가 일반 텍스트 채널이 아닙니다.');
  }

  // 1) starter 메시지: 요약 Embed
  const embed = buildSummaryEmbed(summary, meeting, speakers);
  const transcriptBuf = Buffer.from(transcriptText, 'utf8');
  const transcriptAttachment = new AttachmentBuilder(transcriptBuf, {
    name: `transcript_${session.meetingId}.txt`,
  });

  const starterMsg = await channel.send({
    embeds: [embed],
    files: [transcriptAttachment],
  });

  // 2) 쓰레드 생성 (starter message에서)
  const threadName = makeThreadName(summary, meeting);
  const thread = await starterMsg.startThread({
    name: threadName,
    autoArchiveDuration: 10080,    // 7 days
  });

  // 3) part_N.mp3 첨부 — Discord는 1메시지당 최대 10첨부, 25MB/첨부 한도
  const partRows = [];
  for (let i = 0; i < mp3Parts.length; i++) {
    const part = mp3Parts[i];
    const size = statSync(part.path).size;
    const file = new AttachmentBuilder(part.path, { name: `part_${i + 1}.mp3` });
    const msg = await thread.send({ content: `🎵 part ${i + 1}/${mp3Parts.length}`, files: [file] });
    const url = msg.attachments.first()?.url;
    partRows.push({ partIndex: i + 1, url, durationSec: part.durationSec, size });
  }

  // 4) DB 저장
  await query(
    `UPDATE meetings SET
       status = 'completed',
       ended_at = $2,
       duration_seconds = $3,
       thread_id = $4,
       thread_title = $5,
       transcript_text = $6,
       summary_json = $7
     WHERE id = $1`,
    [
      session.meetingId,
      meeting.endedAt,
      meeting.durationSeconds,
      thread.id,
      threadName,
      transcriptText,
      summary,
    ]
  );

  for (const sp of speakers) {
    await query(
      `INSERT INTO meeting_speakers (meeting_id, user_id, display_name)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [session.meetingId, sp.userId, sp.displayName]
    );
  }

  for (const p of partRows) {
    await query(
      `INSERT INTO meeting_audio_parts
         (meeting_id, part_index, discord_attachment_url, duration_seconds, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.meetingId, p.partIndex, p.url, p.durationSec, p.size]
    );
  }

  // 5) tmp 정리
  try {
    rmSync(pjoin('tmp', String(session.meetingId)), { recursive: true, force: true });
  } catch {}

  return { threadId: thread.id, threadName };
}
```

### 5. 에러 처리

- summarizer 실패 → fallback object 사용. publisher는 fallback thread name 사용. `#alerts` 채널에 경고 메시지.
- publisher 도중 실패 (예: 첨부 한도 초과):
  - `meetings.status='failed'` + `error_message` 기록
  - `#alerts`에 회의 ID + 에러 보고
  - tmp 파일은 **삭제하지 않음** (수동 재시도 가능하도록)

### 6. transcribing → summarizing → completed 상태 전이

`finalize.js`의 `finalizeMeeting`이 단계별로 UPDATE 호출. 봇이 도중 죽으면 stuck 상태가 남음 — 부팅 시 1시간 이상 stuck row를 `failed`로 강제 (07 CLI 헬퍼에서 처리).

### 7. `src/finalize.js` — orchestrator (06 체크포인트의 핵심 산출물)

`/leave` 또는 auto-leave 트리거 후의 **후처리 전체**를 단일 함수가 책임진다. bot.js는 슬래시 핸들러만 가지고 orchestration은 모두 여기로 위임 — 단일 책임.

```js
// src/finalize.js
import { join as pjoin } from 'path';
import { query } from './db.js';
import { stopRecording } from './recorder.js';
import { buildSpeakerMp3, buildMixedMp3Parts } from './audio-pipeline.js';
import { transcribeSpeakerMp3 } from './stt-whisper.js';
import { mergeAcrossSpeakers, formatTranscript } from './transcript-builder.js';
import { summarizeTranscript } from './summarizer.js';
import { publishMeeting } from './publisher.js';

async function setStatus(meetingId, status, errorMessage = null) {
  await query(
    'UPDATE meetings SET status = $2, error_message = $3 WHERE id = $1',
    [meetingId, status, errorMessage]
  );
}

/**
 * /leave 또는 auto-leave 후 후처리 전체.
 * @param {import('discord.js').Client} client
 * @param {MeetingSession} session
 * @param {'manual-leave'|'auto-empty-channel'|'forced-disconnect'} triggeredBy
 */
export async function finalizeMeeting(client, session, triggeredBy) {
  const meetingId = session.meetingId;
  try {
    await stopRecording(session);
    await setStatus(meetingId, 'transcribing');

    // 화자별 MP3 생성 + Whisper STT
    const speakerInputs = [];
    const tmpDir = pjoin('tmp', String(meetingId));
    const endedAt = new Date();
    const totalDurationMs = endedAt - new Date(session.startedAt);

    for (const [userId, sp] of session.speakerSegments.entries()) {
      if (sp.segments.length === 0) continue;
      const mp3Path = pjoin(tmpDir, `speaker_${userId}.mp3`);
      await buildSpeakerMp3({
        pcmPath: sp.pcmPath,
        segments: sp.segments,
        totalDurationMs,
        outMp3Path: mp3Path,
      });
      const whisperSegments = await transcribeSpeakerMp3(mp3Path);
      speakerInputs.push({
        userId,
        displayName: sp.displayName,
        segments: sp.segments,
        whisperSegments,
      });
    }

    if (speakerInputs.length === 0) {
      await setStatus(meetingId, 'failed', '발화 없음 — 음성 캡처 0');
      return;
    }

    // transcript 머지 + 포맷
    const merged = mergeAcrossSpeakers(speakerInputs);
    const durationSec = Math.floor(totalDurationMs / 1000);
    const partBoundariesSec = [];
    const PART_SEC = Number(process.env.MP3_PART_DURATION_MINUTES || 30) * 60;
    for (let t = PART_SEC; t < durationSec; t += PART_SEC) partBoundariesSec.push(t);

    const transcriptText = formatTranscript({
      meeting: {
        guildName: session.guildName,
        startedAt: new Date(session.startedAt),
        endedAt,
        durationSeconds: durationSec,
      },
      speakers: speakerInputs.map((sp) => ({ displayName: sp.displayName })),
      merged,
      partBoundariesSec,
    });

    // mix MP3 part 생성
    const mp3Parts = await buildMixedMp3Parts({
      speakerInputs: speakerInputs.map((sp) => ({
        pcmPath: session.speakerSegments.get(sp.userId).pcmPath,
        segments: sp.segments,
      })),
      totalDurationMs,
      outDir: tmpDir,
    });

    // 요약
    await setStatus(meetingId, 'summarizing');
    const summary = await summarizeTranscript(transcriptText);

    // 게시 + DB 저장
    await publishMeeting({
      client,
      session,
      summary,
      transcriptText,
      mp3Parts,
      meeting: {
        guildName: session.guildName,
        startedAt: new Date(session.startedAt),
        endedAt,
        durationSeconds: durationSec,
        invokedByName: session.invokedByName,
      },
      speakers: speakerInputs.map((sp) => ({ userId: sp.userId, displayName: sp.displayName })),
    });

    // publisher 내부에서 status='completed' 처리
  } catch (err) {
    console.error(`finalizeMeeting 실패 (meeting ${meetingId}, trigger=${triggeredBy}):`, err);
    await setStatus(meetingId, 'failed', err.message || String(err));
    // tmp 파일은 디버깅용으로 유지 (정상 완료만 cleanup)
    throw err;   // 호출부(bot.js)가 #alerts에 보고
  }
}
```

### 8. 02 체크포인트 `handleLeave` 최종 통합 형태

본 06 완료 후 02의 `handleLeave` stub를 실 호출로 교체:

```js
import { finalizeMeeting } from './finalize.js';

async function handleLeave(interaction) {
  // ... (권한 가드 동일)

  await interaction.editReply('🔄 회의 종료 처리 중... transcript와 요약이 곧 게시됩니다.');
  sessions.delete(interaction.guildId);

  try {
    await finalizeMeeting(client, session, 'manual-leave');
  } catch (err) {
    sendAlert(`⚠️ 회의 ${session.meetingId} 후처리 실패: ${err.message}`);
  }
}
```

### 9. 03 체크포인트 `voiceStateUpdate` 자동 leave도 동일 호출

03 체크포인트의 자동 leave 핸들러도 `finalizeMeeting(client, session, 'auto-empty-channel')` 호출로 통일. **두 진입점이 같은 orchestrator를 사용**하므로 분기 코드 중복 없음.

## 검수 기준

- [ ] 시뮬레이션 transcript 입력 시 OpenAI가 json_schema strict 응답 → parsed object의 `thread_title` 50자 이내 한국어 (스키마 strict로 자동 보장)
- [ ] JSON 파싱 실패 케이스 (강제로 빈 응답) → fallback 동작
- [ ] 실 디스코드 채널에 starter message + 쓰레드 생성
- [ ] 쓰레드 이름이 `[05-19] 마승훈 데이트 아이디어 회의` 형태
- [ ] 쓰레드 첫 메시지에 transcript .txt 첨부 + 후속 메시지에 part_1.mp3 첨부
- [ ] DB `meetings.status='completed'` + `thread_id` + `transcript_text` + `summary_json` 저장 확인
- [ ] `meeting_speakers`, `meeting_audio_parts` row 정확
- [ ] `tmp/<meeting_id>/` 디렉토리 삭제 확인

## 다음 체크포인트

→ [07-cli-docs-poc](./07-cli-docs-poc.md)
