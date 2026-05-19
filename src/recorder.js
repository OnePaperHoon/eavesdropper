import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { createWriteStream, mkdirSync } from 'fs';
import { join as pjoin } from 'path';

const TMP_ROOT = 'tmp';
const SILENCE_MS = Number(process.env.END_BEHAVIOR_SILENCE_MS || 1000);

// 48kHz stereo 16-bit PCM의 초당 바이트 (duration 계산용)
const BYTES_PER_SEC_48K_STEREO = 48000 * 2 /* channels */ * 2 /* 16-bit */;

/**
 * 02 bot.js의 handleJoin에서 voice connection이 Ready 된 직후 호출.
 * 화자별 PCM 캡처를 시작한다.
 *
 * @param {object} session  bot.js에 등록된 MeetingSession (voiceConnection·receiver 채워진 상태)
 * @param {import('discord.js').VoiceBasedChannel} voiceChannel
 */
export function startRecording(session, voiceChannel) {
  mkdirSync(pjoin(TMP_ROOT, String(session.meetingId)), { recursive: true });

  const guild = voiceChannel.guild;

  // 누군가 말하기 시작하면 그 사용자의 stream을 subscribe
  session.receiver.speaking.on('start', (userId) => {
    onSpeakingStart(session, guild, userId);
  });
}

function onSpeakingStart(session, guild, userId) {
  // 봇 발화 무시
  const member = guild.members.cache.get(userId);
  if (!member || member.user.bot) return;

  // 화자 컨테이너 lazy init
  if (!session.speakerSegments.has(userId)) {
    const displayName = member.nickname
      || member.user.globalName
      || member.user.username;
    session.speakerSegments.set(userId, {
      displayName,
      segments: [],
      pcmPath: pjoin(TMP_ROOT, String(session.meetingId), `speaker_${userId}.pcm`),
    });
  }
  const sp = session.speakerSegments.get(userId);

  // 침묵 N ms 후 stream auto-end
  const opusStream = session.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });

  // Opus → 48kHz stereo PCM (16-bit) — 16kHz mono 변환은 audio-pipeline(04)에서
  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });

  const startMs = Date.now() - new Date(session.startedAt).getTime();
  let bytesWritten = 0;

  const pcmWriteStream = createWriteStream(sp.pcmPath, { flags: 'a' });

  opusStream.pipe(decoder);

  decoder.on('data', (chunk) => {
    pcmWriteStream.write(chunk);
    bytesWritten += chunk.length;
  });

  decoder.on('error', (err) => {
    console.warn(`Opus decode 오류 (user=${userId}):`, err.message);
  });

  opusStream.on('error', (err) => {
    console.warn(`opusStream 오류 (user=${userId}):`, err.message);
  });

  // stream end 시 segments 메타 누적
  const finalize = () => {
    if (sp._finalized) return;
    sp._finalized = true;
    try { pcmWriteStream.end(); } catch {}
    if (bytesWritten > 0) {
      const durationMs = Math.round((bytesWritten / BYTES_PER_SEC_48K_STEREO) * 1000);
      sp.segments.push({ startMs, durationMs });
    }
    sp._finalized = false; // 다음 발화 cycle에서 재사용 가능
  };

  opusStream.on('end', finalize);
  opusStream.on('close', finalize);
  decoder.on('end', finalize);
}

/**
 * /leave 또는 auto-leave 시 finalize.js가 호출.
 * 마지막 발화들이 자동 end되도록 잠시 대기 후 voice connection을 끊는다.
 */
export async function stopRecording(session) {
  if (session.autoLeaveTimer) {
    clearTimeout(session.autoLeaveTimer);
    session.autoLeaveTimer = null;
  }

  // 마지막 발화 정리 — silence 임계 + 약간의 여유
  await new Promise((r) => setTimeout(r, SILENCE_MS + 500));

  try {
    session.voiceConnection?.destroy();
  } catch {}
  session.voiceConnection = null;
  session.receiver = null;
}
