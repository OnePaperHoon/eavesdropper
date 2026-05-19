# 05 — STT + Transcript 포맷

> SPEC §2.1, §2.8 / ADR-1 (사후 일괄 + verbose_json segment timestamps)

## 목표

화자별 MP3를 Whisper API에 보내 segment timestamps를 받고, 화자 segments 메타와 결합하여 회의 시작 기준 elapsed timeline의 단일 transcript 텍스트를 만든다. SPEC §2.8의 `NOTESBOT TRANSCRIPT` 포맷 그대로 출력.

## 작업

### 1. `src/stt-whisper.js`

```js
import OpenAI from 'openai';
import { createReadStream } from 'fs';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.WHISPER_MODEL || 'whisper-1';
const LANG  = process.env.WHISPER_LANGUAGE || 'ko';

/**
 * @returns {Promise<Array<{start: number, end: number, text: string}>>}
 *          (start/end는 MP3 파일 내부 시간, 초 단위)
 */
export async function transcribeSpeakerMp3(mp3Path) {
  try {
    const resp = await openai.audio.transcriptions.create({
      file: createReadStream(mp3Path),
      model: MODEL,
      language: LANG,
      response_format: 'verbose_json',
      timestamp_granularities: ['segment'],
    });

    // resp.segments: [{ id, start, end, text, ... }]
    return (resp.segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
    }));
  } catch (err) {
    console.error(`Whisper 실패 (${mp3Path}):`, err.message);
    return [{ start: 0, end: 0, text: '[STT 실패]' }];
  }
}
```

### 2. `src/transcript-builder.js`

```js
const FORMATTER_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  timeZone: 'UTC',
});
const FORMATTER_TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric', minute: '2-digit', hour12: true,
  timeZone: 'UTC',
});

function fmtElapsed(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/**
 * 04 audio-pipeline의 1차 구현(화자 발화 단순 concat MP3) 결과를 회의 시작 기준 elapsed로 매핑.
 *
 * @param speakerInputs [{
 *   userId, displayName,
 *   segments: [{startMs, durationMs}],   // 03 recorder가 누적한 회의 시작 기준 절대 timing
 *   whisperSegments: [{start, end, text}],  // MP3 내부 시간 (concat된 시간)
 * }]
 * @returns merged: [{ elapsedSec, displayName, text }]
 */
export function mergeAcrossSpeakers(speakerInputs) {
  const merged = [];

  for (const sp of speakerInputs) {
    // sp.segments의 시간 합으로 MP3 내부 누적 시간 → 회의 elapsed 매핑 테이블 구축
    // segments는 발화 순서대로. MP3 내부 시간은 0, dur1, dur1+dur2, ... 순으로 누적.
    let pcmCursorSec = 0;
    const pcmToElapsed = sp.segments.map((seg) => {
      const range = {
        pcmStart: pcmCursorSec,
        pcmEnd: pcmCursorSec + seg.durationMs / 1000,
        elapsedStart: seg.startMs / 1000,
      };
      pcmCursorSec += seg.durationMs / 1000;
      return range;
    });

    for (const w of sp.whisperSegments) {
      // Whisper start (MP3 내부 초) → 어느 segment에 속하는지 찾기
      const range = pcmToElapsed.find((r) => w.start >= r.pcmStart && w.start < r.pcmEnd)
                 ?? pcmToElapsed[pcmToElapsed.length - 1];
      const elapsedSec = range
        ? range.elapsedStart + (w.start - range.pcmStart)
        : w.start;

      merged.push({
        elapsedSec,
        displayName: sp.displayName,
        text: w.text,
      });
    }
  }

  merged.sort((a, b) => a.elapsedSec - b.elapsedSec);
  return merged;
}

/**
 * SPEC §2.8 포맷의 transcript .txt 본문 생성.
 */
export function formatTranscript({
  meeting,           // { guildName, startedAt(Date), endedAt(Date), durationSeconds }
  speakers,          // [{ displayName }]
  merged,            // mergeAcrossSpeakers 결과
  partBoundariesSec, // [1800, 3600, ...] — 30분 부분 경계
}) {
  const startedDateLabel = FORMATTER_DATE.format(meeting.startedAt);
  const startedTimeLabel = FORMATTER_TIME.format(meeting.startedAt) + ' UTC';
  const endedTimeLabel = FORMATTER_TIME.format(meeting.endedAt) + ' UTC';

  const header = [
    '━'.repeat(60),
    '                     NOTESBOT TRANSCRIPT',
    '━'.repeat(60),
    '',
    `📍 Server:     ${meeting.guildName}`,
    `📅 Date:       ${startedDateLabel}`,
    `🌐 Time zone:  UTC`,
    `🕐 Started:    ${startedTimeLabel}`,
    `🕑 Ended:      ${endedTimeLabel}`,
    `⏱️  Duration:   ${fmtDuration(meeting.durationSeconds)}`,
    `👥 Speakers:   (${speakers.length} participants)`,
    ...speakers.map((s) => `    • ${s.displayName}`),
    '',
    '─'.repeat(60),
    '',
  ].join('\n');

  // 본문 (Part 경계 마커 삽입)
  let body = '';
  let partIndex = 1;
  const totalParts = partBoundariesSec.length + 1;
  let nextBoundary = partBoundariesSec[0];

  for (const u of merged) {
    while (nextBoundary !== undefined && u.elapsedSec >= nextBoundary) {
      partIndex++;
      body += `--- Part ${partIndex}/${totalParts} 시작 (${fmtElapsed(nextBoundary)}) ---\n`;
      nextBoundary = partBoundariesSec[partIndex - 1];
    }
    body += `[${fmtElapsed(u.elapsedSec)}] ${u.displayName}: ${u.text}\n`;
  }

  return header + body;
}
```

### 3. 통합 시점 메모

본 체크포인트(05)는 `stt-whisper.js` + `transcript-builder.js`의 **export 함수만** 정의한다. orchestration(이 함수들을 순서대로 호출하는 `finalizeMeeting`)은 **06 체크포인트의 `src/finalize.js`**에서 정의된다. 아래 의사코드는 06이 어떻게 본 모듈을 사용할지 보여주는 참고용:

```js
// src/finalize.js (06 체크포인트에서 완성)
async function finalizeMeeting(client, session, triggeredBy) {
  await stopRecording(session);

  await query("UPDATE meetings SET status='transcribing' WHERE id=$1", [session.meetingId]);

  // 04: 화자별 mp3 만들기
  const speakerInputs = [];
  for (const [userId, sp] of session.speakerSegments.entries()) {
    if (sp.segments.length === 0) continue;
    const mp3Path = pjoin('tmp', String(session.meetingId), `speaker_${userId}.mp3`);
    await buildSpeakerMp3({
      pcmPath: sp.pcmPath,
      segments: sp.segments,
      totalDurationMs: Date.now() - new Date(session.startedAt).getTime(),
      outMp3Path: mp3Path,
    });
    // 05: Whisper
    const whisperSegments = await transcribeSpeakerMp3(mp3Path);
    speakerInputs.push({
      userId,
      displayName: sp.displayName,
      segments: sp.segments,
      whisperSegments,
    });
  }

  // 05: 머지 + 포맷
  const merged = mergeAcrossSpeakers(speakerInputs);
  const endedAt = new Date();
  const durationSec = Math.floor((endedAt - new Date(session.startedAt)) / 1000);

  // 30분 경계
  const partBoundariesSec = [];
  for (let t = 1800; t < durationSec; t += 1800) partBoundariesSec.push(t);

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

  // 다음: 06이 summarizer + publisher 호출
  await runSummaryAndPublish(session, transcriptText, durationSec, endedAt);
}
```

> 본 의사코드는 **05의 검수 단위**가 아니다. 05는 `transcribeSpeakerMp3` / `mergeAcrossSpeakers` / `formatTranscript` 세 함수의 단위 동작만 검수한다.

### 4. DB 진행 상태 업데이트

각 단계마다:
- `/join` 직후: `status='recording'` (02에서 이미 처리)
- 04~05 시작: `status='transcribing'`
- 06 시작: `status='summarizing'`
- 06 완료: `status='completed'` + `transcript_text` + `summary_json` 저장
- 실패: `status='failed'` + `error_message`

## 검수 기준

- [ ] 더미 MP3 (사용자가 직접 녹음한 1분 wav → mp3) 입력 시 `transcribeSpeakerMp3` 결과로 `[{start, end, text}]` 배열 반환
- [ ] 03 + 04 + 05 통합: 1분 회의 → merged 배열에 두 화자 발화가 시간순 정렬
- [ ] `formatTranscript` 출력이 SPEC §2.8 샘플과 동일 구조 (이모지, 구분선, `[mm:ss] 이름: 텍스트`)
- [ ] 30분 미만 회의는 Part 경계 마커 없음, 30분+는 1개 마커
- [ ] STT 실패 화자는 `[STT 실패]` 라인으로 표시되고 다른 화자는 정상

## 알려진 트레이드오프

- `mergeAcrossSpeakers`는 04 1차 구현(concat) 가정. 04 정밀 mix 버전으로 진화 시 매핑 로직 단순화 가능.
- Whisper의 segment 경계가 발화 경계와 정확히 일치하지 않을 수 있음 — segment 시작이 다른 segment 시간에 잘못 매핑되면 timeline이 약간 어긋남. 1차 구현은 발화 단위 한 발화에 여러 Whisper segments가 들어가도 같은 segments 범위로 매핑되므로 안전.

## 다음 체크포인트

→ [06-summary-publish](./06-summary-publish.md)
