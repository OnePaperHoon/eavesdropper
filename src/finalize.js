import { join as pjoin } from 'path';
import { rmSync } from 'fs';
import { query } from './db.js';
import { stopRecording } from './recorder.js';
import { buildSpeakerMp3, buildMixedMp3Parts } from './audio-pipeline.js';
import { transcribeSpeakerMp3 } from './stt-whisper.js';
import { mergeAcrossSpeakers, formatTranscript } from './transcript-builder.js';
import { summarizeTranscript } from './summarizer.js';
import { publishMeeting } from './publisher.js';

const PART_SEC = Number(process.env.MP3_PART_DURATION_MINUTES || 30) * 60;

async function setStatus(meetingId, status, errorMessage = null) {
  await query(
    'UPDATE meetings SET status = $2, error_message = $3 WHERE id = $1',
    [meetingId, status, errorMessage],
  );
}

/**
 * /leave 또는 auto-leave 후의 후처리 전체 orchestrator.
 * 단일 책임: 모든 단계 순서 + status 전이를 여기서 담당.
 *
 * @param {import('discord.js').Client} client
 * @param {object} session
 * @param {'manual-leave'|'auto-empty-channel'|'forced-disconnect'} triggeredBy
 */
export async function finalizeMeeting(client, session, triggeredBy) {
  const meetingId = session.meetingId;
  const tmpDir = pjoin('tmp', String(meetingId));

  try {
    await stopRecording(session);
    await setStatus(meetingId, 'transcribing');

    const endedAt = new Date();
    const startedAtMs = new Date(session.startedAt).getTime();
    const totalDurationMs = endedAt.getTime() - startedAtMs;
    const durationSec = Math.max(0, Math.floor(totalDurationMs / 1000));

    // 화자별 MP3 생성 + Whisper STT
    const speakerInputs = [];
    for (const [userId, sp] of session.speakerSegments.entries()) {
      if (!sp.segments || sp.segments.length === 0) continue;
      const mp3Path = pjoin(tmpDir, `speaker_${userId}.mp3`);
      try {
        await buildSpeakerMp3({
          pcmPath: sp.pcmPath,
          segments: sp.segments,
          totalDurationMs,
          outMp3Path: mp3Path,
        });
      } catch (err) {
        console.warn(`buildSpeakerMp3 실패 (user=${userId}):`, err.message);
        continue;
      }
      const whisperSegments = await transcribeSpeakerMp3(mp3Path);
      speakerInputs.push({
        userId,
        displayName: sp.displayName,
        segments: sp.segments,
        whisperSegments,
        pcmPath: sp.pcmPath,
      });
    }

    if (speakerInputs.length === 0) {
      await setStatus(meetingId, 'failed', '발화 없음 — 음성 캡처 0');
      return;
    }

    // transcript 머지 + 포맷
    const merged = mergeAcrossSpeakers(speakerInputs);
    const partBoundariesSec = [];
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
    let mp3Parts = [];
    try {
      mp3Parts = await buildMixedMp3Parts({
        speakerInputs: speakerInputs.map((sp) => ({
          pcmPath: sp.pcmPath,
          segments: sp.segments,
        })),
        totalDurationMs,
        outDir: tmpDir,
      });
    } catch (err) {
      console.warn('buildMixedMp3Parts 실패:', err.message);
      // transcript는 게시하되 MP3는 빈 배열로
    }

    // 요약
    await setStatus(meetingId, 'summarizing');
    const summary = await summarizeTranscript(transcriptText);

    // 게시 + DB 저장 (publisher가 status='completed' 처리)
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
      speakers: speakerInputs.map((sp) => ({
        userId: sp.userId,
        displayName: sp.displayName,
      })),
    });

    // 정상 완료 시 tmp 정리
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  } catch (err) {
    console.error(`finalizeMeeting 실패 (meeting ${meetingId}, trigger=${triggeredBy}):`, err);
    await setStatus(meetingId, 'failed', err.message || String(err));
    // tmp 파일은 디버깅용으로 유지
    throw err;
  }
}
