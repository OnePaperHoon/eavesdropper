// SPEC §2.8 — NOTESBOT TRANSCRIPT 포맷 + 화자 segments 머지
// 시간대는 UTC 고정 (사용자 명시).

const FORMATTER_DATE = new Intl.DateTimeFormat('en-US', {
  weekday: 'long',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

const FORMATTER_TIME = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'UTC',
});

function fmtElapsed(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m${s}s`;
}

/**
 * 화자별 Whisper segments(MP3 내부 시간 기준)를 회의 시작 elapsed로 매핑하여
 * 단일 시간순 배열로 머지.
 *
 * 04 audio-pipeline의 1차 구현은 화자 발화를 순서대로 concat한 MP3이므로
 * MP3 내부 시간 = 발화들의 durationMs 누적. segments 메타로 매핑 테이블을 만들어
 * (pcmStart, pcmEnd) → elapsedStart로 변환한다.
 *
 * @param {Array<{
 *   userId: string,
 *   displayName: string,
 *   segments: Array<{startMs:number, durationMs:number}>,
 *   whisperSegments: Array<{start:number, end:number, text:string}>,
 * }>} speakerInputs
 * @returns {Array<{elapsedSec:number, displayName:string, text:string}>}
 */
export function mergeAcrossSpeakers(speakerInputs) {
  const merged = [];

  for (const sp of speakerInputs) {
    // MP3 내부 누적 초 → 회의 elapsed 매핑 테이블
    let pcmCursorSec = 0;
    const ranges = sp.segments.map((seg) => {
      const range = {
        pcmStart: pcmCursorSec,
        pcmEnd: pcmCursorSec + (seg.durationMs / 1000),
        elapsedStart: seg.startMs / 1000,
      };
      pcmCursorSec += (seg.durationMs / 1000);
      return range;
    });

    for (const w of sp.whisperSegments) {
      const range = ranges.find((r) => w.start >= r.pcmStart && w.start < r.pcmEnd)
        ?? ranges[ranges.length - 1];
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
 * SPEC §2.8 NOTESBOT TRANSCRIPT 포맷의 텍스트 본문 생성.
 *
 * @param {object} opts
 * @param {{
 *   guildName: string,
 *   startedAt: Date,
 *   endedAt: Date,
 *   durationSeconds: number,
 * }} opts.meeting
 * @param {Array<{displayName:string}>} opts.speakers
 * @param {Array<{elapsedSec:number, displayName:string, text:string}>} opts.merged
 * @param {number[]} opts.partBoundariesSec  — 30분 부분 경계 (예: [1800, 3600])
 */
export function formatTranscript({ meeting, speakers, merged, partBoundariesSec }) {
  const startedDateLabel = FORMATTER_DATE.format(meeting.startedAt);
  const startedTimeLabel = FORMATTER_TIME.format(meeting.startedAt) + ' UTC';
  const endedTimeLabel = FORMATTER_TIME.format(meeting.endedAt) + ' UTC';

  const headerLines = [
    '━'.repeat(60),
    '                     NOTESBOT TRANSCRIPT',
    '━'.repeat(60),
    '',
    `📍 Server:     ${meeting.guildName ?? ''}`,
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
  ];

  // 본문 + Part 경계 마커
  const bodyLines = [];
  const totalParts = partBoundariesSec.length + 1;
  let partIndex = 1;
  let nextBoundaryIdx = 0;

  for (const u of merged) {
    while (
      nextBoundaryIdx < partBoundariesSec.length
      && u.elapsedSec >= partBoundariesSec[nextBoundaryIdx]
    ) {
      partIndex++;
      bodyLines.push(
        `--- Part ${partIndex}/${totalParts} 시작 (${fmtElapsed(partBoundariesSec[nextBoundaryIdx])}) ---`,
      );
      nextBoundaryIdx++;
    }
    bodyLines.push(`[${fmtElapsed(u.elapsedSec)}] ${u.displayName}: ${u.text}`);
  }

  return headerLines.join('\n') + bodyLines.join('\n') + '\n';
}
